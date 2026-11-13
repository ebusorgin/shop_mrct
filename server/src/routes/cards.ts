import { Router } from 'express';
import { PoolClient } from 'pg';
import { pool, tx } from '../db';
import { ApiError, reqArr, reqInt, reqNum, reqStr, wrap } from '../http';
import { expandCard, assertBaseUnit } from '../services/expansion';
import { assertNameFree } from '../services/name-check';
import { audit, auditTx, diff } from '../services/audit';
import { defaultPackaging, packagingsSql, parsePackagings, savePackagings } from '../services/packagings';

export const cardsRouter = Router();

interface CardItemDto {
  sourceType: 'raw' | 'semi' | 'product';
  refId: number;
  qty: number;
  unitId: number;
  position: number;
}

function parseItems(raw: unknown): CardItemDto[] {
  return (raw as Record<string, unknown>[]).map((x) => {
    const sourceType = String(x.sourceType);
    if (sourceType !== 'raw' && sourceType !== 'semi' && sourceType !== 'product') {
      throw new ApiError(400, 'sourceType: raw|semi|product');
    }
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
         tc.catalog_id as "catalogId", cc.name as "catalogName",
         ${packagingsSql()} as packagings,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', i.id, 'sourceType', i.source_type, 'refId', i.ref_id,
               'qty', i.qty, 'unitId', i.unit_id, 'unitCode', u.code, 'position', i.position,
               'refName', coalesce(p.name, sp.name, tcp.name)
             ) order by i.position, i.id
           ) filter (where i.id is not null),
           '[]'
         ) as items
    from tech_cards tc
    join units pu on pu.id = tc.portion_unit_id
    left join product_catalogs cc on cc.id = tc.catalog_id
    left join tech_card_items i on i.card_id = tc.id
    left join products p on i.source_type = 'raw' and p.id = i.ref_id
    left join semi_products sp on i.source_type = 'semi' and sp.id = i.ref_id
    left join tech_cards tcp on i.source_type = 'product' and tcp.id = i.ref_id
    left join units u on u.id = i.unit_id
   group by tc.id, pu.code, cc.name`;

const decode = (r: Record<string, unknown>) => ({
  ...r,
  portionQty: Number(r.portionQty),
  packagings: typeof r.packagings === 'string' ? JSON.parse(r.packagings) : r.packagings,
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

/** Предпросмотр: сколько СЫРЬЯ уйдёт на N порций (с учётом выхода после обработки полуфабрикатов). */
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
    const catalogId = req.body.catalogId === undefined || req.body.catalogId === null || req.body.catalogId === ''
      ? null
      : reqInt(req.body, 'catalogId');
    const items = parseItems(reqArr(req.body, 'items'));
    const packagings = req.body.packagings === undefined ? null : parsePackagings(req.body.packagings);
    const id = await tx(async (client) => {
      await assertBaseUnit(client, portionUnitId, 'Техкарта');
      await assertNameFree(client, name, 'tech_cards');
      const { rows } = await client.query(
        `insert into tech_cards (name, portion_qty, portion_unit_id, note, catalog_id, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$6) returning id`,
        [name, portionQty, portionUnitId, note, catalogId, req.user?.id ?? null]
      );
      await saveItems(client, rows[0].id, items);
      const { rows: units } = await client.query('select code from units where id = $1', [portionUnitId]);
      const toSave = packagings ?? [defaultPackaging(portionQty)];
      await savePackagings(client, rows[0].id, toSave, units[0].code, portionQty);
      await auditTx(client, req.user, {
        action: 'create',
        entity: 'tech_card',
        entityId: rows[0].id as number,
        title: `Техкарта «${name}»`,
        details: { portionQty, portionUnitId, catalogId, items: items.length, packagings: toSave.length },
      });
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
    const catalogId = req.body.catalogId === undefined || req.body.catalogId === null || req.body.catalogId === ''
      ? null
      : reqInt(req.body, 'catalogId');
    const items = parseItems(reqArr(req.body, 'items'));
    const packagings = req.body.packagings === undefined ? null : parsePackagings(req.body.packagings);
    if (packagings && !packagings.length) throw new ApiError(400, 'Нужна хотя бы одна фасовка');
    await tx(async (client) => {
      await assertBaseUnit(client, portionUnitId, 'Техкарта');
      await assertNameFree(client, name, 'tech_cards', id);
      const { rows: before } = await client.query(
        'select name, portion_qty::float8 as portion_qty, portion_unit_id, note, catalog_id from tech_cards where id = $1 for update',
        [id]
      );
      if (!before.length) throw new ApiError(404, 'Техкарта не найдена');
      await assertNoCardCycle(client, id, items);
      const { rows: beforeItems } = await client.query('select count(*)::int as n from tech_card_items where card_id = $1', [id]);
      const { rows: beforePackagings } = await client.query('select count(*)::int as n from product_packagings where card_id = $1', [id]);
      await client.query(
        'update tech_cards set name=$2, portion_qty=$3, portion_unit_id=$4, note=$5, catalog_id=$6, updated_by=$7 where id=$1',
        [id, name, portionQty, portionUnitId, note, catalogId, req.user?.id ?? null]
      );
      await client.query('delete from tech_card_items where card_id = $1', [id]);
      await saveItems(client, id, items);
      const { rows: units } = await client.query('select code from units where id = $1', [portionUnitId]);
      if (packagings) {
        await savePackagings(client, id, packagings, units[0].code, portionQty);
      } else if (before[0].portion_unit_id !== portionUnitId) {
        await client.query(
          `update product_packagings set name = trim_scale(qty_base)::text || ' ' || $2 where card_id = $1`,
          [id, units[0].code]
        );
      }
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'tech_card',
        entityId: id,
        title: `Техкарта «${name}»`,
        details: diff(
          { ...before[0], items: beforeItems[0].n, packagings: beforePackagings[0].n },
          {
            name, portion_qty: portionQty, portion_unit_id: portionUnitId, note, catalog_id: catalogId,
            items: items.length, packagings: packagings ? packagings.length : beforePackagings[0].n,
          }
        ),
      });
    });
    res.json({ ok: true });
  })
);

cardsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select tc.name,
         (select count(*) from production_batches where card_id = tc.id and status = 'posted') as posted,
         (select count(*) from tech_card_items where source_type = 'product' and ref_id = tc.id) as used
       from tech_cards tc where tc.id = $1`,
      [Number(req.params.id)]
    );
    if (!rows.length) throw new ApiError(404, 'Техкарта не найдена');
    if (Number(rows[0].posted) > 0) throw new ApiError(409, 'По техкарте есть отгрузки — удаление запрещено');
    if (Number(rows[0].used) > 0) throw new ApiError(409, 'Техкарта используется в составе других техкарт — удаление запрещено');
    await tx(async (client) => {
      await client.query('delete from tech_card_items where card_id = $1', [Number(req.params.id)]);
      await client.query('delete from tech_cards where id = $1', [Number(req.params.id)]);
    });
    await audit(req.user, {
      action: 'delete',
      entity: 'tech_card',
      entityId: req.params.id,
      title: `Техкарта «${rows[0].name}»`,
    });
    res.json({ ok: true });
  })
);

async function saveItems(client: PoolClient, cardId: number, items: CardItemDto[]) {
  for (const i of items) {
    await assertBaseUnit(client, i.unitId, 'Позиция техкарты');
    if (i.sourceType === 'product') {
      const { rows } = await client.query('select 1 from tech_cards where id = $1', [i.refId]);
      if (!rows.length) throw new ApiError(400, 'Техкарта в составе не найдена');
    }
    await client.query(
      `insert into tech_card_items (card_id, source_type, ref_id, qty, unit_id, position)
       values ($1,$2,$3,$4,$5,$6)`,
      [cardId, i.sourceType, i.refId, i.qty, i.unitId, i.position]
    );
  }
}

/** Продукт не может прямо или через другие продукты входить в собственный состав. */
async function assertNoCardCycle(client: PoolClient, cardId: number, items: CardItemDto[]): Promise<void> {
  const stack = items.filter((i) => i.sourceType === 'product').map((i) => i.refId);
  const seen = new Set<number>();
  while (stack.length) {
    const ref = stack.pop()!;
    if (ref === cardId) throw new ApiError(400, 'Техкарта не может входить в собственный состав');
    if (seen.has(ref)) continue;
    seen.add(ref);
    const { rows } = await client.query(
      `select ref_id from tech_card_items where source_type = 'product' and card_id = $1`,
      [ref]
    );
    for (const r of rows) stack.push(r.ref_id as number);
  }
}
