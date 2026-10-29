/**
 * Журнал действий: кто, что и когда сделал.
 *
 *   GET /api/audit?limit=&offset=&user=&entity=&action=&entityId=&q=&from=&to=
 *
 * Записи пишутся из маршрутов (services/audit.ts) и триггеров БД. Здесь только чтение,
 * плюс сводка для фильтров (по людям, разделам и видам действий).
 */
import { Router } from 'express';
import { pool } from '../db';
import { wrap } from '../http';

export const auditRouter = Router();

/** Фильтр из строки запроса: пусто -> null. */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

auditRouter.get(
  '/',
  wrap(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const conds: string[] = [];
    const params: unknown[] = [];
    const add = (sql: (n: number) => string, value: unknown): void => {
      params.push(value);
      conds.push(sql(params.length));
    };

    const user = str(req.query.user);
    if (user) add((n) => `(lower(a.user_login) like $${n} or lower(coalesce(a.user_name, '')) like $${n})`, `%${user.toLowerCase()}%`);
    const entity = str(req.query.entity);
    if (entity) add((n) => `a.entity = $${n}`, entity);
    const action = str(req.query.action);
    if (action) add((n) => `a.action = $${n}`, action);
    const entityId = str(req.query.entityId);
    if (entityId) add((n) => `a.entity_id = $${n}`, entityId);
    const q = str(req.query.q);
    if (q) add((n) => `(a.title ilike $${n} or a.details::text ilike $${n})`, `%${q}%`);
    const from = str(req.query.from);
    if (from) add((n) => `a.created_at >= $${n}::date`, from);
    const to = str(req.query.to);
    if (to) add((n) => `a.created_at < ($${n}::date + 1)`, to);

    const where = conds.length ? `where ${conds.join(' and ')}` : '';

    const { rows } = await pool.query(
      `select a.id, a.user_id as "userId", a.user_login as "userLogin", a.user_name as "userName",
              a.action, a.entity, a.entity_id as "entityId", a.title, a.details, a.created_at as "createdAt"
         from audit_log a
         ${where}
        order by a.id desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset]
    );

    const { rows: totals } = await pool.query(
      `select count(*)::int as total from audit_log a ${where}`,
      params
    );

    // сводка по тем же фильтрам — что выбирать в выпадающих списках
    const { rows: people } = await pool.query(
      `select a.user_login as "userLogin", max(coalesce(a.user_name, a.user_login)) as "userName", count(*)::int as cnt
         from audit_log a ${where}
        group by 1 order by cnt desc limit 30`,
      params
    );
    const { rows: sections } = await pool.query(
      `select a.entity, count(*)::int as cnt
         from audit_log a ${where}
        group by 1 order by cnt desc`,
      params
    );
    const { rows: kinds } = await pool.query(
      `select a.action, count(*)::int as cnt
         from audit_log a ${where}
        group by 1 order by cnt desc`,
      params
    );

    res.json({
      total: Number(totals[0]?.total ?? 0),
      limit,
      offset,
      entries: rows.map((r) => ({
        ...r,
        userName: r.userName ?? r.userLogin,
        details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
      })),
      summary: { people, entities: sections, actions: kinds },
    });
  })
);
