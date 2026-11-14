/**
 * API раздела «Точки продаж» — справочник торговых точек (stores).
 *
 *   GET    /api/points            — список точек с профилем (без удалённых)
 *   GET    /api/points/:id        — одна точка
 *   GET    /api/points/:id/stats  — показатели точки для внутренней страницы
 *   POST   /api/points            — создать точку
 *   PATCH  /api/points/:id        — редактировать точку
 *   POST   /api/points/:id/deactivate — мягко деактивировать (история цела)
 *   POST   /api/points/:id/activate   — вернуть точку в работу
 *   DELETE /api/points/:id        — скрыть точку (мягкое удаление, данные остаются)
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, reqInt, reqNum, wrap } from '../http';
import { audit, diff } from '../services/audit';
import { storeStats } from '../services/store-stats';

export const pointsRouter = Router();

interface PointCard {
  id: number;
  code: string;
  name: string;
  active: boolean;
  position: number;
  address: string;
  phone: string;
  email: string;
  contactPerson: string;
  openingHours: string;
  pib: string;
  mbr: string;
  accountNo: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** кто завёл точку и кто последним её правил (логин) */
  createdByLogin: string | null;
  createdByName: string | null;
  updatedByLogin: string | null;
  updatedByName: string | null;
}

/** Optional string из тела (не строка/пусто -> переданный def). */
function optStr(body: Record<string, unknown>, field: string, def = ''): string {
  const v = body[field];
  if (v === undefined || v === null) return def;
  return String(v).trim();
}

/** Список точек с профилем. */
async function loadCards(): Promise<PointCard[]> {
  const { rows } = await pool.query(`
    select s.id, s.code, s.name, s.active, s.position,
           s.address, s.phone, s.email, s.contact_person as "contactPerson",
           s.opening_hours as "openingHours", s.pib, s.mbr, s.account_no as "accountNo", s.note,
           to_char(s.created_at, 'YYYY-MM-DD') as "createdAt",
           to_char(s.updated_at, 'YYYY-MM-DD') as "updatedAt",
           cu.login as "createdByLogin", uu.login as "updatedByLogin",
           coalesce(nullif(btrim(cu.full_name), ''), cu.login) as "createdByName",
           coalesce(nullif(btrim(uu.full_name), ''), uu.login) as "updatedByName"
      from stores s
      left join users cu on cu.id = s.created_by
      left join users uu on uu.id = s.updated_by
     where s.deleted_at is null
     order by s.position, s.id`);

  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    active: r.active,
    position: Number(r.position),
    address: r.address ?? '',
    phone: r.phone ?? '',
    email: r.email ?? '',
    contactPerson: r.contactPerson ?? '',
    openingHours: r.openingHours ?? '',
    pib: r.pib ?? '',
    mbr: r.mbr ?? '',
    accountNo: r.accountNo ?? '',
    note: r.note ?? '',
    createdAt: r.createdAt ?? '',
    updatedAt: r.updatedAt ?? '',
    createdByLogin: r.createdByLogin ?? null,
    createdByName: r.createdByName ?? null,
    updatedByLogin: r.updatedByLogin ?? null,
    updatedByName: r.updatedByName ?? null,
  }) as PointCard);
}

pointsRouter.get(
  '/',
  wrap(async (_req, res) => {
    res.json(await loadCards());
  })
);

pointsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const cards = await loadCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw new ApiError(404, 'Точка не найдена');
    res.json(card);
  })
);

pointsRouter.get(
  '/:id/stats',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query('select 1 from stores where id = $1 and deleted_at is null', [id]);
    if (!rows.length) throw new ApiError(404, 'Точка не найдена');
    res.json(await storeStats(id));
  })
);

pointsRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Поле «name» обязательно');

    // id = номер точки; если не задан — следующий свободный после существующих.
    let id: number;
    if (req.body.id !== undefined && req.body.id !== null && req.body.id !== '') {
      id = reqInt(req.body, 'id');
      const { rows: dup } = await pool.query('select 1 from stores where id = $1', [id]);
      if (dup.length) throw new ApiError(409, `Точка с номером ${id} уже существует`);
    } else {
      const { rows } = await pool.query('select coalesce(max(id), 102) + 1 as nid from stores');
      id = Number(rows[0].nid);
    }

    const code = optStr(req.body, 'code') || `Mix 38${id}`;
    const { rows: codeDup } = await pool.query('select 1 from stores where code = $1', [code]);
    if (codeDup.length) throw new ApiError(409, `Код «${code}» уже используется`);

    const position = req.body.position === undefined || req.body.position === '' ? id : reqNum(req.body, 'position');
    const active = req.body.active === undefined ? true : Boolean(req.body.active);

    await pool.query(
      `insert into stores (id, code, name, active, position, address, phone, email, contact_person, opening_hours, pib, mbr, account_no, note, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [
        id, code, name, active, position,
        optStr(req.body, 'address'), optStr(req.body, 'phone'), optStr(req.body, 'email'),
        optStr(req.body, 'contactPerson'), optStr(req.body, 'openingHours'),
        optStr(req.body, 'pib'), optStr(req.body, 'mbr'), optStr(req.body, 'accountNo'),
        optStr(req.body, 'note'),
        req.user?.id ?? null,
      ]
    );
    await audit(req.user, {
      action: 'create',
      entity: 'store',
      entityId: id,
      title: `Точка «${name}»`,
      details: { code, active, position },
    });
    res.status(201).json({ id });
  })
);

pointsRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Поле «name» обязательно');
    const { rows: cur } = await pool.query(
      'select id, code, name, active, position, address, phone, email, contact_person, opening_hours, pib, mbr, account_no as "accountNo", note from stores where id = $1 and deleted_at is null',
      [id]
    );
    if (!cur.length) throw new ApiError(404, 'Точка не найдена');

    const code = optStr(req.body, 'code') || `Mix 38${id}`;
    const { rows: codeDup } = await pool.query('select 1 from stores where code = $1 and id <> $2', [code, id]);
    if (codeDup.length) throw new ApiError(409, `Код «${code}» уже используется`);

    const position = req.body.position === undefined || req.body.position === '' ? id : reqNum(req.body, 'position');
    const active = req.body.active === undefined ? true : Boolean(req.body.active);

    await pool.query(
      `update stores set code=$2, name=$3, active=$4, position=$5, address=$6, phone=$7, email=$8,
              contact_person=$9, opening_hours=$10, pib=$11, mbr=$12, account_no=$13, note=$14, updated_at=now(), updated_by=$15
        where id=$1`,
      [
        id, code, name, active, position,
        optStr(req.body, 'address'), optStr(req.body, 'phone'), optStr(req.body, 'email'),
        optStr(req.body, 'contactPerson'), optStr(req.body, 'openingHours'),
        optStr(req.body, 'pib'), optStr(req.body, 'mbr'), optStr(req.body, 'accountNo'),
        optStr(req.body, 'note'),
        req.user?.id ?? null,
      ]
    );
    await audit(req.user, {
      action: 'update',
      entity: 'store',
      entityId: id,
      title: `Точка «${name}»`,
      details: diff(cur[0] as Record<string, unknown>, {
        code, name, active, position,
        address: optStr(req.body, 'address'), phone: optStr(req.body, 'phone'), email: optStr(req.body, 'email'),
        contact_person: optStr(req.body, 'contactPerson'), opening_hours: optStr(req.body, 'openingHours'),
        pib: optStr(req.body, 'pib'), mbr: optStr(req.body, 'mbr'), accountNo: optStr(req.body, 'accountNo'),
        note: optStr(req.body, 'note'),
      }),
    });
    res.json({ ok: true });
  })
);

pointsRouter.post(
  '/:id/deactivate',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      'update stores set active = false, updated_at = now(), updated_by = $2 where id = $1 and deleted_at is null returning id, name',
      [id, req.user?.id ?? null]
    );
    if (!rows.length) throw new ApiError(404, 'Точка не найдена');
    await audit(req.user, { action: 'update', entity: 'store', entityId: id, title: `Точка «${rows[0].name}»`, details: { active: false } });
    res.json({ ok: true });
  })
);

pointsRouter.post(
  '/:id/activate',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `update stores set active = true, updated_at = now(), updated_by = $2
        where id = $1 and deleted_at is null returning id, name`,
      [id, req.user?.id ?? null]
    );
    if (!rows.length) throw new ApiError(404, 'Точка не найдена');
    await audit(req.user, { action: 'update', entity: 'store', entityId: id, title: `Точка «${rows[0].name}»`, details: { active: true } });
    res.json({ ok: true });
  })
);

pointsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      'select name from stores where id = $1 and deleted_at is null',
      [id]
    );
    if (!rows.length) throw new ApiError(404, 'Точка не найдена');
    // Мягкое удаление: карточка исчезает из справочника, заказы и журнал остаются.
    await pool.query(
      'update stores set deleted_at = now(), active = false, updated_at = now(), updated_by = $2 where id = $1',
      [id, req.user?.id ?? null]
    );
    await audit(req.user, {
      action: 'delete',
      entity: 'store',
      entityId: id,
      title: `Точка «${rows[0].name}»`,
      details: { soft: true },
    });
    res.json({ ok: true });
  })
);
