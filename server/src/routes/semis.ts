import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqArr, reqInt, reqNum, reqStr, wrap, aiSource } from '../http';
import { assertBaseUnit } from '../services/expansion';
import { buildBoardFromInputs, boardIsEmpty } from '../services/semi-board';
import { assertNameFree } from '../services/name-check';
import { audit, auditTx, diff } from '../services/audit';

export const semisRouter = Router();

/** Неотрицательное число или null (пусто/undefined -> null) — для коэффициентов пересчёта размера выхода. */
function convNum(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `Поле «${field}» — неотрицательное число или пусто`);
  return n;
}

/** Целое неотрицательное число или null (пусто/undefined -> null) — для срока годности в днях. */
function intOrNull(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, `Поле «${field}» — целое неотрицательное число или пусто`);
  return n;
}

/** Положительное число или null — размер партии (сколько заготовки получаем из состава). */
function posNum(body: Record<string, unknown>, field: string, fallback: number): number {
  const v = body[field];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, `Поле «${field}» — положительное число`);
  return n;
}

/**
 * Состав заготовки: все входы равны между собой — у каждого своё количество НА ПАРТИЮ
 * (в базовых единицах самого входа) и свой необязательный выход после обработки.
 * Привязки к «базовому продукту» больше нет: выход партии задаёт out_qty, а не один из входов.
 */
interface SemiInputDto {
  sourceType: 'raw' | 'semi';
  refId: number;
  qty: number;
  yieldPct: number | null;
}

function parseInputs(raw: unknown): SemiInputDto[] {
  const arr = raw as Record<string, unknown>[];
  if (!arr.length) throw new ApiError(400, 'Состав пуст — добавьте хотя бы один ингредиент');
  const seen = new Set<string>();
  const inputs = arr.map((x) => {
    const sourceType = String(x.sourceType ?? 'raw');
    if (sourceType !== 'raw' && sourceType !== 'semi') throw new ApiError(400, 'sourceType: raw|semi');
    const refId = reqInt(x, 'refId');
    const qty = reqNum(x, 'qty');
    if (!(qty > 0)) throw new ApiError(400, 'Количество входа должно быть больше 0');
    // выход после обработки опционален: пусто/0/некорректно => null (расход 1:1, без потерь)
    const y = Number(x.yieldPct);
    const yieldPct = Number.isFinite(y) && y > 0 && y <= 100 ? y : null;
    const key = `${sourceType}:${refId}`;
    if (seen.has(key)) throw new ApiError(400, 'Один и тот же вход в составе дважды — объедините строки');
    seen.add(key);
    return { sourceType: sourceType as SemiInputDto['sourceType'], refId, qty, yieldPct };
  });
  return inputs;
}

/**
 * Стол конструктора (расположение блоков и связи) — рисованный артефакт той же заготовки.
 * Сервер проверяет только форму и размер: содержимое рисует клиент.
 */
function boardJson(body: Record<string, unknown>): string | null {
  const b = body.board;
  if (b === undefined || b === null) return null;
  if (typeof b !== 'object') throw new ApiError(400, 'Поле «board» — объект стола');
  const j = JSON.stringify(b);
  if (j.length > 4_000_000) throw new ApiError(400, 'Стол слишком большой');
  return j;
}

/** Снимок состава для журнала: компонент (человеческое имя), количество на партию, выход после обработки. */
const SNAPSHOT_INPUTS_SQL = `
  select coalesce(p.name, sub.name) as name,
         si.qty_per_output::float8 as qty, si.yield_pct::float8 as yield_pct
    from semi_inputs si
    left join products p on si.source_type = 'raw'  and p.id = si.ref_id
    left join semi_products sub on si.source_type = 'semi' and sub.id = si.ref_id
   where si.semi_id = $1
   order by si.id`;

/** Что поменялось в самом составе: «Морковь чищенная: 200 → 0.6». Считается по имени компонента. */
function normChanges(
  before: { name: string | null; qty: number | null; yield_pct: number | null }[],
  after: { name: string | null; qty: number | null; yield_pct: number | null }[]
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const prev = new Map(before.map((r) => [r.name ?? '—', r]));
  for (const r of after) {
    const p = prev.get(r.name ?? '—');
    if (!p) continue; // добавленный/удалённый вход уже виден в счётчике «состав»
    if (p.qty !== r.qty) out[String(r.name)] = { from: p.qty, to: r.qty };
    if (p.yield_pct !== r.yield_pct) out[`${String(r.name)} · выход после обработки`] = { from: p.yield_pct, to: r.yield_pct };
  }
  return out;
}

const LIST_SQL = `
  select sp.id, sp.name, sp.note, u.code as "unitCode", sp.unit_id as "unitId",
         sp.out_qty::float8 as "outQty",
         sp.shelf_life_days as "shelfLifeDays",
         sp.g_per_pcs::float8 as "gPerPcs", sp.ml_per_pcs::float8 as "mlPerPcs", sp.g_per_ml::float8 as "gPerMl",
         (sp.board is not null) as "hasBoard",
     jsonb_agg(
       jsonb_build_object(
         'id', si.id, 'sourceType', si.source_type, 'refId', si.ref_id,
         'name', coalesce(p.name, sub.name),
         'qty', si.qty_per_output, 'yieldPct', si.yield_pct,
         'unitCode', coalesce(pu.code, su.code), 'unitId', coalesce(p.unit_id, sub.unit_id)
       ) order by si.id
     ) as inputs
    from semi_products sp
    join units u on u.id = sp.unit_id
    join semi_inputs si on si.semi_id = sp.id
    left join products p on si.source_type = 'raw'  and p.id = si.ref_id
    left join units pu on pu.id = p.unit_id
    left join semi_products sub on si.source_type = 'semi' and sub.id = si.ref_id
    left join units su on su.id = sub.unit_id
   group by sp.id, u.code
   order by sp.name`;

semisRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(LIST_SQL);
    res.json(rows.map(decodeRow));
  })
);

semisRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select t.*, (select sp.board from semi_products sp where sp.id = t.id) as board
         from (${LIST_SQL}) t where t.id = $1`,
      [Number(req.params.id)]
    );
    if (!rows.length) throw new ApiError(404, 'Полуфабрикат не найден');
    res.json(decodeRow(rows[0]));
  })
);

semisRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name');
    const unitId = reqInt(req.body, 'unitId');
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    const outQty = posNum(req.body, 'outQty', 1);
    const shelfLifeDays = intOrNull(req.body, 'shelfLifeDays');
    const gPerPcs = convNum(req.body, 'gPerPcs');
    const mlPerPcs = convNum(req.body, 'mlPerPcs');
    const gPerMl = convNum(req.body, 'gPerMl');
    const inputs = parseInputs(reqArr(req.body, 'inputs'));
    const board = boardJson(req.body);
    const id = await tx(async (client) => {
      await assertBaseUnit(client, unitId, 'Полуфабрикат');
      await assertNameFree(client, name, 'semi_products');
      // редактор рецептов стол не шлёт — соберём блок-схему из состава (у конструктора стол свой)
      const boardStr = await autoBoard(client, board, inputs, name, unitId);
      const { rows } = await client.query(
        `insert into semi_products (name, unit_id, note, out_qty, shelf_life_days, g_per_pcs, ml_per_pcs, g_per_ml, board, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10) returning id`,
        [name, unitId, note, outQty, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl, boardStr, req.user?.id ?? null]
      );
      await insertInputs(client, rows[0].id, inputs);
      await assertNoCycle(client, rows[0].id);
      await auditTx(client, req.user, {
        action: 'create',
        entity: 'semi',
        entityId: rows[0].id as number,
        title: `Полуфабрикат «${name}»`,
        details: { unitId, outQty, note, shelfLifeDays, inputs: inputs.length },
      });
      return rows[0].id as number;
    });
    res.status(201).json({ id });
  })
);

semisRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = reqStr(req.body, 'name');
    const unitId = reqInt(req.body, 'unitId');
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    const outQty = posNum(req.body, 'outQty', 1);
    const shelfLifeDays = intOrNull(req.body, 'shelfLifeDays');
    const gPerPcs = convNum(req.body, 'gPerPcs');
    const mlPerPcs = convNum(req.body, 'mlPerPcs');
    const gPerMl = convNum(req.body, 'gPerMl');
    const inputs = parseInputs(reqArr(req.body, 'inputs'));
    // стол правится отдельно (конструктор) — null значит «не трогать»
    const board = req.body.board === undefined ? null : boardJson(req.body);
    await tx(async (client) => {
      await assertBaseUnit(client, unitId, 'Полуфабрикат');
      await assertNameFree(client, name, 'semi_products', id);
      const { rows: before } = await client.query(
        'select name, unit_id, note, out_qty::float8 as out_qty, shelf_life_days, g_per_pcs::float8 as g_per_pcs, ml_per_pcs::float8 as ml_per_pcs, g_per_ml::float8 as g_per_ml, board from semi_products where id = $1',
        [id]
      );
      if (!before.length) throw new ApiError(404, 'Полуфабрикат не найден');
      // стол правится отдельно: прислали — берём; не прислали, но стола нет — генерим из нового состава;
      // не прислали и стол уже есть (ручная раскладка) — не трогаем (null → coalesce оставит как было).
      const existingBoard = (before[0] as { board?: unknown }).board;
      delete (before[0] as Record<string, unknown>).board; // в снапшот изменений board не участвует
      const boardStr =
        board ?? (boardIsEmpty(existingBoard) ? await autoBoard(client, null, inputs, name, unitId) : null);
      const { rows: beforeInputs } = await client.query(SNAPSHOT_INPUTS_SQL, [id]);
      await client.query(
        `update semi_products
            set name=$2, unit_id=$3, note=$4, out_qty=$5, shelf_life_days=$6, g_per_pcs=$7, ml_per_pcs=$8, g_per_ml=$9,
                board = coalesce($11::jsonb, board),
                updated_by = $10
          where id=$1`,
        [id, name, unitId, note, outQty, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl, req.user?.id ?? null, boardStr]
      );
      await client.query('delete from semi_inputs where semi_id = $1', [id]);
      await insertInputs(client, id, inputs);
      await assertNoCycle(client, id);
      const { rows: afterInputs } = await client.query(SNAPSHOT_INPUTS_SQL, [id]);
      const changes = {
        ...diff(
          { ...before[0], inputs: beforeInputs.length },
          {
            name, unit_id: unitId, note, out_qty: outQty, shelf_life_days: shelfLifeDays,
            g_per_pcs: gPerPcs, ml_per_pcs: mlPerPcs, g_per_ml: gPerMl, inputs: inputs.length,
          }
        ),
        // нормы входов тоже должны быть видны: иначе правка рецептуры остаётся в журнале пустой записью
        ...normChanges(beforeInputs, afterInputs),
      };
      // коэффициент мог подсказать GPT — помечаем источник, чтобы правка от руки не выглядела фактом
      const ai = aiSource(req.body ?? {});
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'semi',
        entityId: id,
        title: `Полуфабрикат «${name}»`,
        details: ai && Object.keys(changes).length ? { ...changes, ai_model: ai } : changes,
      });
    });
    res.json({ ok: true });
  })
);

semisRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select sp.name,
         (select count(*) from tech_card_items where source_type='semi' and ref_id = $1) as cards,
         (select count(*) from semi_inputs where source_type='semi' and ref_id = $1) as semis
       from semi_products sp where sp.id = $1`,
      [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, 'Полуфабрикат не найден');
    if (Number(rows[0].cards) > 0) throw new ApiError(409, 'Полуфабрикат используется в техкартах');
    if (Number(rows[0].semis) > 0) throw new ApiError(409, 'Полуфабрикат используется в составе других полуфабрикатов');
    await pool.query('delete from semi_products where id = $1', [req.params.id]);
    await audit(req.user, {
      action: 'delete',
      entity: 'semi',
      entityId: req.params.id,
      title: `Полуфабрикат «${rows[0].name}»`,
    });
    res.json({ ok: true });
  })
);

async function insertInputs(client: import('pg').PoolClient, semiId: number, inputs: SemiInputDto[]) {
  for (const i of inputs) {
    await client.query(
      `insert into semi_inputs (semi_id, source_type, ref_id, qty_per_output, yield_pct)
       values ($1,$2,$3,$4,$5)`,
      [semiId, i.sourceType, i.refId, i.qty, i.yieldPct]
    );
  }
}

/** Код базовой единицы — для подписи центрального блока автосгенерированного стола. */
async function unitCodeOf(client: import('pg').PoolClient, unitId: number): Promise<string> {
  const { rows } = await client.query('select code from units where id = $1', [unitId]);
  return rows.length ? String(rows[0].code) : '';
}

/**
 * Если клиент не прислал стол (редактор рецептов правит только состав) — раскладываем
 * рецепт на блок-схему, чтобы у заготовки сразу был визуальный «стол» в конструкторе.
 * Присланный стол (конструктор) возвращаем как есть — ручную раскладку не перезаписываем.
 */
async function autoBoard(
  client: import('pg').PoolClient,
  provided: string | null,
  inputs: SemiInputDto[],
  name: string,
  unitId: number
): Promise<string | null> {
  if (provided !== null) return provided;
  const built = await buildBoardFromInputs(client, inputs, name, await unitCodeOf(client, unitId));
  return built ? JSON.stringify(built) : null;
}

/** DFS по графу semi_inputs: из `startId` нельзя вернуться в `startId` через составные полуфабрикаты. */
async function assertNoCycle(client: import('pg').PoolClient, startId: number) {
  const visited = new Set<number>();
  const stack: number[] = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    const { rows } = await client.query(
      `select ref_id from semi_inputs where semi_id = $1 and source_type = 'semi'`,
      [cur]
    );
    for (const r of rows) {
      const rid = Number(r.ref_id);
      if (rid === startId) {
        throw new ApiError(400, 'Цикл: полуфабрикат не может (прямо или опосредованно) входить в собственный состав');
      }
      if (!visited.has(rid)) {
        visited.add(rid);
        stack.push(rid);
      }
    }
  }
}

function decodeRow(r: Record<string, unknown>) {
  const inputs = typeof r.inputs === 'string' ? JSON.parse(r.inputs) : r.inputs;
  const board = typeof r.board === 'string' ? JSON.parse(r.board) : r.board ?? null;
  return { ...r, inputs, board };
}
