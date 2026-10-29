import * as fs from 'fs';
import * as path from 'path';
import { PoolClient } from 'pg';
import { Router } from 'express';
import { pool, tx } from '../db';
import { config } from '../config';
import { ApiError, optNum, reqArr, reqNum, reqStr, wrap } from '../http';
import { applyMovement } from '../services/stock';
import { loadUnits, toBaseCross, loadProductConv, type ProdConv } from '../services/expansion';
import { auditTx, type Actor } from '../services/audit';

export const waybillsRouter = Router();

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface WaybillInItem {
  productId: number;
  qty: number;
  unitId: number;
  price: number | null;
  /** Ставка PDV в % (5/10/20); null — без НДС / нет данных. */
  vatRate?: number | null;
}

export interface WaybillInHead {
  number: string;
  supplier: string;
  docDate: string | null;
  fileName?: string | null;
  storedFile?: string | null;
  /** Байты фото/скана — хранятся в БД (file_data), диск лишь кэш. */
  fileData?: Buffer | null;
  fileMime?: string | null;
  /** Дополнительные листы/дубли фото той же накладной: [{stored, name, mime, data}]. */
  extraFiles?: { stored: string; name: string; mime: string; data: Buffer }[] | null;
  currency?: string | null;
  supplierPib?: string | null;
  /** Напечатанные в документе итоги (для сверки с пересчётом по строкам). */
  docTotalNet?: number | null;
  docTotalVat?: number | null;
  docTotalGross?: number | null;
  /** Кто принял накладную на склад: пишем в waybills.accepted_by/accepted_login. */
  actor?: Actor;
}

/**
 * Создаёт накладную и приходует её на склад в переданном клиенте (транзакция снаружи).
 * Общая для ручного POST и подтверждения GPT-импорта.
 * Цены в накладных — без PDV, поэтому в себестоимость идёт price, а НДС хранится отдельно.
 */
export async function ingestWaybill(client: PoolClient, head: WaybillInHead, items: WaybillInItem[]): Promise<number> {
  const units = await loadUnits(client);
  let totalNet = 0;
  let totalVat = 0;
  for (const it of items) {
    const net = it.qty * (it.price ?? 0);
    totalNet += net;
    // НДС в печатных документах округлён по строкам — суммируем тоже так, иначе Σ не бьётся с напечатанным на полкопейки
    totalVat += round2((net * (it.vatRate ?? 0)) / 100);
  }
  const extras = head.extraFiles?.length
    ? head.extraFiles.map((f) => ({ stored: f.stored, name: f.name, mime: f.mime, data: f.data.toString('base64') }))
    : null;
  const { rows: wb } = await client.query(
    `insert into waybills (number, supplier, doc_date, file_name, stored_file, file_data, file_mime, extra_files,
                           currency, supplier_pib, total_net, total_vat, total_gross,
                           doc_total_net, doc_total_vat, doc_total_gross,
                           accepted_by, accepted_login, accepted_at)
     values ($1, $2, coalesce($3::date, current_date), $4, $5, $6, $7, $8,
             coalesce($9, 'RSD'), $10, $11, $12, $13, $14, $15, $16,
             $17, $18, now())
     returning id`,
    [
      head.number, head.supplier, head.docDate, head.fileName ?? null, head.storedFile ?? null,
      head.fileData ?? null, head.fileMime ?? null,
      extras ? JSON.stringify(extras) : null,
      head.currency ?? null, head.supplierPib ?? null,
      round2(totalNet), round2(totalVat), round2(round2(totalNet) + round2(totalVat)),
      head.docTotalNet ?? null, head.docTotalVat ?? null, head.docTotalGross ?? null,
      head.actor?.id ?? null, head.actor?.login ?? null,
    ]
  );
  const waybillId = wb[0].id as number;

  for (const it of items) {
    if (it.qty <= 0) throw new ApiError(400, 'Количество должно быть > 0');
    // склад принимает строго базовые единицы (г/мл/шт): перевод «kg с бумаги -> г» делает импорт
    const u = units.get(it.unitId);
    if (!u) throw new ApiError(400, `Единица #${it.unitId} не найдена — приход только в базовых единицах (г/мл/шт)`);
    if (u.factor !== 1) throw new ApiError(400, `Приход в «${it.unitId}» запрещён: хранение только в базовых (г/мл/шт)`);
    // базовая единица продукта + его коэффициенты пересчёта размерностей — для перевода и проверки
    const { rows: pr } = await client.query(
      'select unit_id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from products where id = $1',
      [it.productId]
    );
    if (!pr.length) throw new ApiError(400, `Продукт #${it.productId} не найден`);
    const conv: ProdConv = {
      gPerPcs: pr[0].gp == null ? null : Number(pr[0].gp),
      mlPerPcs: pr[0].mp == null ? null : Number(pr[0].mp),
      gPerMl: pr[0].gm == null ? null : Number(pr[0].gm),
    };
    const qtyBase = toBaseCross(it.qty, it.unitId, pr[0].unit_id, units, conv);
    // себестоимость за каноничную базовую единицу — из денег строки (работает и при кросс-размерном приходе)
    const money = it.qty * (it.price ?? 0);
    const costBase = qtyBase > 0 ? money / qtyBase : 0;
    const vatAmount = round2((money * (it.vatRate ?? 0)) / 100);

    await client.query(
      'insert into waybill_items (waybill_id, product_id, qty, unit_id, price, vat_rate, vat_amount) values ($1,$2,$3,$4,$5,$6,$7)',
      [waybillId, it.productId, it.qty, it.unitId, it.price ?? 0, it.vatRate ?? null, vatAmount]
    );
    await applyMovement(client, {
      productId: it.productId,
      type: 'receipt',
      delta: qtyBase,
      unitCost: costBase,
      docType: 'waybill',
      docId: waybillId,
      comment: `Приход по накладной №${head.number}`,
      actor: head.actor ?? null,
    });
  }
  return waybillId;
}

waybillsRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      select w.id, w.number, w.supplier, to_char(w.doc_date,'YYYY-MM-DD') as "docDate",
             w.status, count(i.id) as "itemsCount",
             (w.stored_file is not null or w.file_data is not null) as "hasFile",
             coalesce(jsonb_array_length(w.extra_files), 0) as "extraCount",
             w.accepted_login as "acceptedLogin",
             (select coalesce(nullif(btrim(u.full_name), ''), w.accepted_login) from users u where u.id = w.accepted_by) as "acceptedName",
             to_char(w.accepted_at, 'YYYY-MM-DD HH24:MI') as "acceptedAt",
             w.reversed_login as "reversedLogin",
             (select coalesce(nullif(btrim(u.full_name), ''), w.reversed_login) from users u where u.id = w.reversed_by) as "reversedName",
             to_char(w.reversed_at, 'YYYY-MM-DD HH24:MI') as "reversedAt",
             coalesce(sum(i.qty * i.price), 0)::float8 as total
        from waybills w
        left join waybill_items i on i.waybill_id = w.id
       group by w.id
       order by w.doc_date desc, w.id desc`);
    res.json(rows);
  })
);

/** Отдаёт прикреплённое фото/скан/PDF накладной: сначала из БД, на худой конец с диска. ?att=N — дополнительный лист (с 0). */
waybillsRouter.get(
  '/:id/file',
  wrap(async (req, res) => {
    const att = Number(req.query.att ?? -1);
    if (att >= 0) {
      // дополнительный лист: байты живут в extra_files (jsonb), диск — кэш
      const { rows: ex } = await pool.query('select extra_files from waybills where id = $1', [req.params.id]);
      const f = (ex[0]?.extra_files ?? [])[att];
      if (!f) throw new ApiError(404, 'Лист не найден');
      // data — base64 в jsonb (исторически мог лежать и как {"type":"Buffer",...})
      const buf: Buffer | null =
        typeof f.data === 'string' && f.data
          ? Buffer.from(f.data, 'base64')
          : Array.isArray(f.data?.data)
            ? Buffer.from(f.data.data)
            : Buffer.isBuffer(f.data)
              ? f.data
              : null;
      if (buf) {
        res.setHeader('Content-Type', f.mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name ?? f.stored ?? `лист ${att + 2}`)}"`);
        res.send(buf);
        return;
      }
      const disk = f.stored && path.join(config.uploadsDir, path.basename(f.stored));
      if (disk && fs.existsSync(disk)) {
        res.sendFile(disk);
        return;
      }
      throw new ApiError(404, 'Файл листа не найден ни в БД, ни на диске');
    }
    const { rows } = await pool.query(
      "select stored_file, file_name, file_mime, octet_length(file_data) as sz, case when file_data is null then null else file_data end as data from waybills where id = $1",
      [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, 'Накладная не найдена');
    const r = rows[0];
    if (r.data) {
      res.setHeader('Content-Type', r.file_mime ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.file_name ?? r.stored_file ?? 'document')}"`);
      res.send(r.data); // pg отдаёт bytea как Buffer
      return;
    }
    if (!r.stored_file) throw new ApiError(404, 'Файл у накладной не прикреплён');
    const candidates = [r.stored_file, path.join(config.uploadsDir, path.basename(r.stored_file)), path.join(process.cwd(), 'uploads', path.basename(r.stored_file))];
    const abs = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!abs) throw new ApiError(404, 'Файл не найден ни в БД, ни на диске');
    res.sendFile(abs);
  })
);

waybillsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const { rows: head } = await pool.query(
      `select w.id, w.number, w.supplier, to_char(w.doc_date,'YYYY-MM-DD') as "docDate", w.status,
              w.file_name as "fileName", (w.stored_file is not null or w.file_data is not null) as "hasFile",
              w.extra_files as "extraFiles",
              w.currency, w.supplier_pib as "supplierPib",
              w.accepted_login as "acceptedLogin",
              coalesce(nullif(btrim(au.full_name), ''), w.accepted_login) as "acceptedName",
              to_char(w.accepted_at, 'DD.MM.YYYY HH24:MI') as "acceptedAt",
              w.reversed_login as "reversedLogin",
              coalesce(nullif(btrim(ru.full_name), ''), w.reversed_login) as "reversedName",
              to_char(w.reversed_at, 'DD.MM.YYYY HH24:MI') as "reversedAt",
              w.total_net::float8 as "totalNet", w.total_vat::float8 as "totalVat", w.total_gross::float8 as "totalGross",
              w.doc_total_net::float8 as "docTotalNet", w.doc_total_vat::float8 as "docTotalVat", w.doc_total_gross::float8 as "docTotalGross"
         from waybills w
         left join users au on au.id = w.accepted_by
         left join users ru on ru.id = w.reversed_by
        where w.id = $1`,
      [req.params.id]
    );
    if (!head.length) throw new ApiError(404, 'Накладная не найдена');
    const { rows: items } = await pool.query(
      `select i.id, i.product_id as "productId", p.name as "productName",
              i.qty::float8 as qty, i.unit_id as "unitId", u.code as "unitCode",
              i.price::float8 as price, i.vat_rate::float8 as "vatRate", i.vat_amount::float8 as "vatAmount"
         from waybill_items i
         join products p on p.id = i.product_id
         join units u on u.id = i.unit_id
        where i.waybill_id = $1 order by i.id`,
      [req.params.id]
    );
    const { extraFiles, ...rest } = head[0];
    // байты (base64) в выдачу не тащим — клиент листает их через /file?att=
    res.json({
      ...rest,
      extraFiles: Array.isArray(extraFiles) ? extraFiles.map(({ data: _d, ...m }: { data?: unknown }) => m) : null,
      items,
    });
  })
);

/**
 * Создаёт накладную и сразу приходует на склад (одна транзакция).
 * items: [{productId, qty, unitId, price}] — цена за указанную единицу.
 */
waybillsRouter.post(
  '/',
  wrap(async (req, res) => {
    const number = reqStr(req.body, 'number');
    const supplier = typeof req.body.supplier === 'string' ? req.body.supplier.trim() : '';
    const docDate = typeof req.body.docDate === 'string' ? req.body.docDate : null;
    const items = reqArr(req.body, 'items').map((it) => ({
      productId: reqNum(it, 'productId'),
      qty: reqNum(it, 'qty'),
      unitId: reqNum(it, 'unitId'),
      price: optNum(it, 'price'),
    }));

    const id = await tx(async (client) => {
      const waybillId = await ingestWaybill(client, { number, supplier, docDate, actor: req.user }, items);
      await auditTx(client, req.user, {
        action: 'post',
        entity: 'waybill',
        entityId: waybillId,
        title: `Накладная №${number}${supplier ? ' · ' + supplier : ''}`,
        details: { mode: 'manual', items: items.length, supplier, docDate },
      });
      return waybillId;
    });
    res.status(201).json({ id });
  })
);

/**
 * Откат (сторно) накладной: движения прихода аннулируются, а остатки и средневзвешенная
 * себестоимость затронутых продуктов пересчитываются «как будто накладной никогда не было» —
 * иначе отменённая цена навсегда отравляет avg_cost.
 */
waybillsRouter.post(
  '/:id/reverse',
  wrap(async (req, res) => {
    const waybillId = Number(req.params.id);
    const affected = await tx(async (client) => {
      const { rows: st } = await client.query('select id, number, status from waybills where id = $1 for update', [waybillId]);
      if (!st.length) throw new ApiError(404, 'Накладная не найдена');
      if (st[0].status === 'reversed') throw new ApiError(409, 'Накладная уже отменена');

      const { rows: items } = await client.query(
        `select i.product_id as "productId", i.qty::float8 as qty, i.unit_id as "unitId", p.unit_id as "baseUnitId"
           from waybill_items i join products p on p.id = i.product_id where i.waybill_id = $1`,
        [waybillId]
      );
      if (!items.length) throw new ApiError(409, 'У накладной нет позиций — отменять нечего');

      const units = await loadUnits(client);
      const convMap = await loadProductConv(client);
      const productIds = [...new Set(items.map((i) => i.productId as number))].sort((a, b) => a - b);
      await client.query('select 1 from stock where product_id = any($1::int[]) for update', [productIds]);

      // 1) сторнируем приход (с проверкой, что товар ещё не растащен со склада)
      for (const it of items) {
        const qtyBase = toBaseCross(it.qty, it.unitId, it.baseUnitId, units, convMap.get(it.productId));
        await applyMovement(client, {
          productId: it.productId,
          type: 'writeoff',
          delta: -qtyBase,
          docType: 'waybill',
          docId: waybillId,
          comment: `Отмена накладной №${st[0].number}`,
          actor: req.user,
        });
      }

      // сначала помечаем отменённой — чтобы пересчёт ниже исключил и её движения
      await client.query(
        "update waybills set status = 'reversed', reversed_by = $2, reversed_login = $3, reversed_at = now() where id = $1",
        [waybillId, req.user?.id ?? null, req.user?.login ?? null]
      );

      // 2) пересчёт остатка и avg_cost по журналу; движения ВСЕХ отменённых накладных
      //    (приход и сторно) выбрасываются — иначе сторно одной отмены, проигранное при
      //    пересчёте другой, заново отравляет средневзвешенную цену
      for (const pid of productIds) {
        const { rows: mv } = await client.query(
          `select type, qty::float8 as qty, unit_cost::float8 as cost from movements
            where product_id = $1
              and not (coalesce(doc_type,'') = 'waybill'
                       and coalesce(doc_id,0) in (select id from waybills where status = 'reversed'))
            order by id`,
          [pid]
        );
        let q = 0;
        let c = 0;
        for (const m of mv) {
          if (m.type === 'receipt') {
            const nq = q + m.qty;
            c = nq > 0 ? (q * c + m.qty * m.cost) / nq : m.cost;
            q = nq;
          } else {
            q += m.qty; // списания/корректировки среднюю цену не меняют
          }
        }
        await client.query('update stock set qty = $2, avg_cost = $3, updated_at = now() where product_id = $1', [pid, q, c]);
      }

      await auditTx(client, req.user, {
        action: 'reverse',
        entity: 'waybill',
        entityId: waybillId,
        title: `Накладная №${st[0].number}`,
        details: { productsRecalculated: productIds.length },
      });

      return productIds.length;
    });
    res.json({ ok: true, productsRecalculated: affected });
  })
);
