import { Router } from 'express';
import { PoolClient } from 'pg';
import { pool, tx } from '../db';
import { ApiError, reqArr, reqInt, reqNum, reqStr, wrap } from '../http';
import { expandCard, assertBaseUnit } from '../services/expansion';

export const cardsRouter = Router();

interface CardItemDto {
  sourceType: 'raw' | 'semi';
  refId: number;
  qty: number;
  unitId: number;
  position: number;
}

function parseItems(raw: unknown): CardItemDto[] {
  return (raw as Record<string, unknown>[]).map((x) => {
    const sourceType = String(x.sourceType);
    if (sourceType !== 'raw' && sourceType !== 'semi') throw new ApiError(400, 'sourceType: raw|semi');
    return {
      sourceType: sourceType as CardItemDto['sourceType'],
      refId: reqInt(x, 'refId'),
      qty: reqNum(x, 'qty'),
      unitId: reqInt(x, 'unitId'),
      position: x.position === undefined ? 0 : reqNum(x, 'position'),
    };
  });
}

const CARD_SQL = `
  select tc.id, tc.name, tc.note, tc.portion_qty as "portionQty",
         tc.portion_unit_id as "portionUnitId", pu.code as "portionUnitCode",
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', i.id, 'sourceType', i.source_type, 'refId', i.ref_id,
               'qty', i.qty, 'unitId', i.unit_id, 'unitCode', u.code, 'position', i.position,
               'refName', coalesce(p.name, sp.name)
             ) order by i.position, i.id
           ) filter (where i.id is not null),
           '[]'
         ) as items
    from tech_cards tc
    join units pu on pu.id = tc.portion_unit_id
    left join tech_card_items i on i.card_id = tc.id
    left join products p on i.source_type = 'raw' and p.id = i.ref_id
    left join semi_products sp on i.source_type = 'semi' and sp.id = i.ref_id
    left join units u on u.id = i.unit_id
   group by tc.id, pu.code`;

const decode = (r: Record<string, unknown>) => ({
  ...r,
  portionQty: Number(r.portionQty),
  items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
});

cardsRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`select * from (${CARD_SQL}) t order by t.name`);
    res.json(rows.map(decode));
  })
);

cardsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(`select * from (${CARD_SQL}) t where t.id = $1`, [Number(req.params.id)]);
    if (!rows.length) throw new ApiError(404, 'Техкарта не найдена');
    res.json(decode(rows[0]));
  })
);

/** Предпросмотр: сколько СЫРЬЯ уйдёт на N порций (с учётом уварки полуфабрикатов). */
cardsRouter.get(
  '/:id/expansion',
  wrap(async (req, res) => {
    const portions = Math.max(1, Number(req.query.portions ?? 1) || 1);
    const need = await tx(async (client) => expandCard(client, Number(req.params.id), portions));
    // имена и текущие остатки для UI / предпросмотра списания
    const details = await Promise.all(
      need.map(async (n) => {
        const { rows: pr } = await pool.query(
          `select p.name, u.code as "unitCode", coalesce(s.qty,0)::float8 as "stockQty"
             from products p join units u on u.id = p.unit_id
             left join stock s on s.product_id = p.id where p.id = $1`,
          [n.productId]
        );
        return { ...n, ...pr[0] };
      })
    );
    res.json(details);
  })
);

cardsRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name');
    const portionQty = reqNum(req.body, 'portionQty');
    const portionUnitId = reqInt(req.body, 'portionUnitId');
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    const items = parseItems(reqArr(req.body, 'items'));
    const id = await tx(async (client) => {
      await assertBaseUnit(client, portionUnitId, 'Техкарта');
      const { rows } = await client.query(
        'insert into tech_cards (name, portion_qty, portion_unit_id, note) values ($1,$2,$3,$4) returning id',
        [name, portionQty, portionUnitId, note]
      );
      await saveItems(client, rows[0].id, items);
      return rows[0].id as number;
    });
    res.status(201).json({ id });
  })
);

cardsRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = reqStr(req.body, 'name');
    const portionQty = reqNum(req.body, 'portionQty');
    const portionUnitId = reqInt(req.body, 'portionUnitId');
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    const items = parseItems(reqArr(req.body, 'items'));
    await tx(async (client) => {
      await assertBaseUnit(client, portionUnitId, 'Техкарта');
      await client.query(
        'update tech_cards set name=$2, portion_qty=$3, portion_unit_id=$4, note=$5 where id=$1',
        [id, name, portionQty, portionUnitId, note]
      );
      await client.query('delete from tech_card_items where card_id = $1', [id]);
      await saveItems(client, id, items);
    });
    res.json({ ok: true });
  })
);

cardsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      'select count(*) from production_batches where card_id = $1 and status = $2',
      [Number(req.params.id), 'posted']
    );
    if (Number(rows[0].count) > 0) throw new ApiError(409, 'По техкарте есть отгрузки — удаление запрещено');
    await pool.query('delete from tech_cards where id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  })
);

async function saveItems(client: PoolClient, cardId: number, items: CardItemDto[]) {
  for (const i of items) {
    await assertBaseUnit(client, i.unitId, 'Позиция техкарты');
    await client.query(
      `insert into tech_card_items (card_id, source_type, ref_id, qty, unit_id, position)
       values ($1,$2,$3,$4,$5,$6)`,
      [cardId, i.sourceType, i.refId, i.qty, i.unitId, i.position]
    );
  }
}
