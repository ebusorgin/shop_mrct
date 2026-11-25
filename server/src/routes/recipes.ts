import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, wrap } from '../http';
import { auditTx } from '../services/audit';

export const recipesRouter = Router();

/**
 * Рецептуры из новой модели: products -> product_nodes (состав),
 * product_skus -> product_sku_packages -> packages (фасовки и тара).
 * Только чтение: страница «Рецептуры» показывает выгрузку без редактирования.
 */
recipesRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows: catalogs } = await pool.query(
      'select id, name, icon, color from product_catalogs order by position, id'
    );
    const { rows: recipes } = await pool.query(
      `select p.id, p.name, p.name_en as "nameEn", p.name_sr as "nameSr",
              u.code as "unitCode", p.unit_id as "unitId",
              p.portion_qty::float8 as "portionQty",
              p.catalog_id as "catalogId", p.description, p.created_at as "createdAt"
         from products p
         left join units u on u.id = p.unit_id
        order by p.name`
    );
    const { rows: nodes } = await pool.query(
      `select n.id, n.product_id as "productId",
              n.material_id as "materialId", m.name as "materialName", u.code as "unitCode",
              n.sub_product_id as "subProductId", sp.name as "subProductName",
              n.qty::float8 as qty, n.loss_pct::float8 as "lossPct"
         from product_nodes n
         left join materials m on m.id = n.material_id
         left join units u on u.id = m.unit_id
         left join products sp on sp.id = n.sub_product_id
        order by n.product_id, n.id`
    );
    const { rows: skus } = await pool.query(
      `select s.id, s.product_id as "productId", s.name,
              s.qty_base::float8 as "qtyBase",
              s.price_basis as "priceBasis",
              s.price::float8 as price, s.cost_price::float8 as "costPrice",
              s.issue_type as "issueType", s.is_active as "isActive",
              s.archived as "archived",
              (select count(*)::int from store_order_items i where i.packaging_id = s.id) as "usedInOrders"
         from product_skus s
        order by s.product_id, s.id`
    );
    const { rows: skuPackages } = await pool.query(
      `select l.sku_id as "skuId", p.id, p.name, p.kind
         from product_sku_packages l
         join packages p on p.id = l.package_id
        order by l.sku_id, p.id`
    );
    const { rows: materials } = await pool.query(
      `select m.id, m.name, u.code as "unitCode", c.name as "category", c.position as "categoryPosition",
              m.g_per_pcs::float8 as "gPerPcs", m.ml_per_pcs::float8 as "mlPerPcs", m.g_per_ml::float8 as "gPerMl"
         from materials m
         join units u on u.id = m.unit_id
         left join material_categories c on c.id = m.category_id
        where m.active
        order by c.position nulls last, m.name`
    );
    const { rows: packages } = await pool.query(
      'select id, name, kind from packages order by kind, name'
    );
    const { rows: units } = await pool.query(
      'select id, code, name, dimension, base_factor::float8 as "baseFactor" from units order by id'
    );

    const nodesByProduct = new Map<number, Record<string, unknown>[]>();
    for (const n of nodes) {
      const key = Number(n.productId);
      const list = nodesByProduct.get(key) ?? [];
      list.push({
        id: Number(n.id),
        materialId: n.materialId == null ? null : Number(n.materialId),
        materialName: n.materialName == null ? null : String(n.materialName),
        unitCode: n.unitCode == null ? null : String(n.unitCode),
        subProductId: n.subProductId == null ? null : Number(n.subProductId),
        subProductName: n.subProductName == null ? null : String(n.subProductName),
        qty: Number(n.qty),
        lossPct: Number(n.lossPct ?? 0),
      });
      nodesByProduct.set(key, list);
    }

    const packsBySku = new Map<number, Record<string, unknown>[]>();
    for (const p of skuPackages) {
      const key = Number(p.skuId);
      const list = packsBySku.get(key) ?? [];
      list.push({ id: Number(p.id), name: String(p.name), kind: String(p.kind) });
      packsBySku.set(key, list);
    }

    const skusByProduct = new Map<number, Record<string, unknown>[]>();
    for (const s of skus) {
      const key = Number(s.productId);
      const list = skusByProduct.get(key) ?? [];
      list.push({
        id: Number(s.id),
        name: String(s.name ?? ''),
        qtyBase: Number(s.qtyBase ?? 0),
        priceBasis: String(s.priceBasis ?? 'unit'),
        price: Number(s.price),
        costPrice: Number(s.costPrice),
        issueType: String(s.issueType),
        isActive: s.isActive !== false,
        archived: s.archived === true,
        usedInOrders: Number(s.usedInOrders ?? 0),
        packages: packsBySku.get(Number(s.id)) ?? [],
      });
      skusByProduct.set(key, list);
    }

    res.json({
      catalogs: catalogs.map((c) => ({
        id: Number(c.id),
        name: String(c.name),
        icon: String(c.icon ?? ''),
        color: String(c.color ?? ''),
      })),
      materials: materials.map((m) => ({
        id: Number(m.id),
        name: String(m.name),
        unitCode: String(m.unitCode ?? ''),
        category: String(m.category ?? 'Без категории'),
        gPerPcs: m.gPerPcs == null ? null : Number(m.gPerPcs),
        mlPerPcs: m.mlPerPcs == null ? null : Number(m.mlPerPcs),
        gPerMl: m.gPerMl == null ? null : Number(m.gPerMl),
      })),
      packages: packages.map((p) => ({
        id: Number(p.id),
        name: String(p.name),
        kind: String(p.kind),
      })),
      units: units.map((u) => ({
        id: Number(u.id),
        code: String(u.code),
        name: String(u.name),
        dimension: String(u.dimension),
        baseFactor: Number(u.baseFactor ?? 1),
      })),
      recipes: recipes.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        nameEn: String(r.nameEn ?? ''),
        nameSr: String(r.nameSr ?? ''),
        unitCode: String(r.unitCode ?? ''),
        unitId: r.unitId == null ? null : Number(r.unitId),
        portionQty: Number(r.portionQty ?? 0),
        catalogId: r.catalogId == null ? null : Number(r.catalogId),
        description: String(r.description ?? ''),
        createdAt: r.createdAt,
        nodes: nodesByProduct.get(Number(r.id)) ?? [],
        skus: skusByProduct.get(Number(r.id)) ?? [],
      })),
    });
  })
);

/** Список фасовок (SKU) для ручного сопоставления строк Google-таблицы. */
recipesRouter.get(
  '/skus',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select s.id, p.name as "nodeName", s.name as title,
              s.qty_base::float8 as "qtyBase", s.is_active as available,
              s.price::float8 as price, u.code as "unitCode",
              c.name as "catalogName"
         from product_skus s
         join products p on p.id = s.product_id
         join units u on u.id = p.unit_id
         left join product_catalogs c on c.id = p.catalog_id
        where not s.archived
        order by c.position nulls last, p.name, s.qty_base`
    );
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        nodeName: String(r.nodeName),
        title: r.title == null ? null : String(r.title),
        qtyBase: Number(r.qtyBase),
        available: r.available !== false,
        price: Number(r.price),
        unitCode: String(r.unitCode ?? ''),
        catalogName: r.catalogName == null ? null : String(r.catalogName),
      }))
    );
  })
);

interface SaveNode {
  materialId: number | null;
  subProductId: number | null;
  qty: number;
  lossPct: number;
}

interface SaveSku {
  id: number | null;
  name: string;
  qtyBase: number;
  priceBasis: 'unit' | 'portion';
  price: number;
  costPrice: number;
  isActive: boolean;
  archived: boolean;
  packageIds: number[];
}

const toNum = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** Сохранение рецептуры: поля, состав и фасовки одной транзакцией. */
recipesRouter.put(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'Некорректный id рецептуры');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Название рецептуры не может быть пустым');
    const nameEn = String(body.nameEn ?? '').trim();
    const nameSr = String(body.nameSr ?? '').trim();
    const description = String(body.description ?? '');
    const catalogRaw = body.catalogId;
    const catalogId = catalogRaw == null || catalogRaw === '' ? null : Number(catalogRaw);
    if (catalogId != null && (!Number.isInteger(catalogId) || catalogId <= 0)) {
      throw new ApiError(400, 'Некорректный каталог');
    }
    const portionQty = body.portionQty == null || body.portionQty === '' ? 0 : toNum(body.portionQty);
    if (!(portionQty >= 0)) throw new ApiError(400, 'Выход не может быть отрицательным');
    const unitRaw = body.unitId;
    const unitId = unitRaw == null || unitRaw === '' ? null : Number(unitRaw);
    if (unitId == null || !Number.isInteger(unitId) || unitId <= 0) {
      throw new ApiError(400, 'Выберите единицу рецептуры');
    }
    {
      const { rows } = await pool.query('select id from units where id = $1', [unitId]);
      if (!rows.length) throw new ApiError(400, 'Единица рецептуры не найдена');
    }

    const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
    const nodes: SaveNode[] = [];
    const seen = new Set<string>();
    for (const raw of rawNodes) {
      const n = (raw ?? {}) as Record<string, unknown>;
      const materialId = n.materialId == null || n.materialId === '' ? null : Number(n.materialId);
      const subProductId = n.subProductId == null || n.subProductId === '' ? null : Number(n.subProductId);
      if ((materialId == null) === (subProductId == null)) {
        throw new ApiError(400, 'Компонент: выберите ровно одно — сырьё или рецептуру');
      }
      if (materialId != null && (!Number.isInteger(materialId) || materialId <= 0)) {
        throw new ApiError(400, 'Некорректное сырьё в составе');
      }
      if (subProductId != null && (!Number.isInteger(subProductId) || subProductId <= 0)) {
        throw new ApiError(400, 'Некорректная рецептура в составе');
      }
      if (subProductId === id) throw new ApiError(400, 'Рецептура не может входить сама в себя');
      const key = materialId != null ? `m:${materialId}` : `p:${subProductId}`;
      if (seen.has(key)) throw new ApiError(400, 'Компонент добавлен дважды');
      seen.add(key);
      const qty = toNum(n.qty);
      if (!(qty > 0)) throw new ApiError(400, 'Количество компонента должно быть больше 0');
      const lossPct = n.lossPct == null || n.lossPct === '' ? 0 : toNum(n.lossPct);
      if (!(lossPct >= 0 && lossPct <= 100)) throw new ApiError(400, 'Потери должны быть от 0 до 100 %');
      nodes.push({ materialId, subProductId, qty, lossPct });
    }

    const rawSkus = Array.isArray(body.skus) ? body.skus : [];
    const skus: SaveSku[] = [];
    const skuIds = new Set<number>();
    for (const raw of rawSkus) {
      const s = (raw ?? {}) as Record<string, unknown>;
      const skuId = s.id == null || s.id === '' ? null : Number(s.id);
      if (skuId != null && (!Number.isInteger(skuId) || skuId <= 0)) throw new ApiError(400, 'Некорректный id фасовки');
      if (skuId != null) {
        if (skuIds.has(skuId)) throw new ApiError(400, 'Фасовка повторяется');
        skuIds.add(skuId);
      }
      const priceBasis = String(s.priceBasis ?? 'unit');
      if (priceBasis !== 'unit' && priceBasis !== 'portion') {
        throw new ApiError(400, 'База цены: unit или portion');
      }
      // issue_type выводится из базы цены при сохранении (unit => weight, иначе package)
      const price = toNum(s.price ?? 0);
      const costPrice = toNum(s.costPrice ?? 0);
      const qtyBase = s.qtyBase == null || s.qtyBase === '' ? 0 : toNum(s.qtyBase);
      if (!(price >= 0) || !(costPrice >= 0)) {
        throw new ApiError(400, 'Цена и себестоимость не могут быть отрицательными');
      }
      if (!(qtyBase >= 0)) throw new ApiError(400, 'Размер фасовки не может быть отрицательным');
      const packageIds = Array.isArray(s.packageIds) ? s.packageIds.map((v) => Number(v)) : [];
      if (packageIds.some((v) => !Number.isInteger(v) || v <= 0)) {
        throw new ApiError(400, 'Некорректная тара в фасовке');
      }
      // issue_type выводится из базы цены: за единицу — выдача по весу, иначе упаковка
      skus.push({
        id: skuId,
        name: String(s.name ?? '').trim(),
        qtyBase,
        priceBasis,
        price,
        costPrice,
        isActive: s.isActive !== false,
        archived: s.archived === true,
        packageIds: [...new Set(packageIds)],
      });
    }

    const materialIds = [...new Set(nodes.map((n) => n.materialId).filter((v): v is number => v != null))];
    if (materialIds.length) {
      const { rows } = await pool.query('select id from materials where id = any($1::int[])', [materialIds]);
      if (rows.length !== materialIds.length) throw new ApiError(400, 'Часть сырья из состава не найдена');
    }
    const subIds = [...new Set(nodes.map((n) => n.subProductId).filter((v): v is number => v != null))];
    if (subIds.length) {
      const { rows } = await pool.query('select id from products where id = any($1::int[])', [subIds]);
      if (rows.length !== subIds.length) throw new ApiError(400, 'Часть вложенных рецептур не найдена');
    }
    const packageIds = [...new Set(skus.flatMap((s) => s.packageIds))];
    if (packageIds.length) {
      const { rows } = await pool.query('select id from packages where id = any($1::int[])', [packageIds]);
      if (rows.length !== packageIds.length) throw new ApiError(400, 'Часть тары не найдена');
    }

    await tx(async (client) => {
      const upd = await client.query(
        `update products
            set name = $2, name_en = $3, name_sr = $4, catalog_id = $5, description = $6,
                portion_qty = $7, unit_id = $8
          where id = $1`,
        [id, name, nameEn, nameSr, catalogId, description, portionQty, unitId]
      );
      if (!upd.rowCount) throw new ApiError(404, 'Рецептура не найдена');

      await client.query('delete from product_nodes where product_id = $1', [id]);
      for (const n of nodes) {
        await client.query(
          `insert into product_nodes (product_id, material_id, sub_product_id, qty, loss_pct)
           values ($1, $2, $3, $4, $5)`,
          [id, n.materialId, n.subProductId, n.qty, n.lossPct]
        );
      }

      const { rows: existingRows } = await client.query(
        'select id from product_skus where product_id = $1',
        [id]
      );
      const existing = new Set<number>(existingRows.map((r) => Number(r.id)));
      const keep = new Set<number>();
      for (const s of skus) {
        const issueType: 'weight' | 'package' = s.priceBasis === 'unit' ? 'weight' : 'package';
        let skuId = s.id;
        if (skuId != null) {
          if (!existing.has(skuId)) throw new ApiError(400, 'Фасовка не принадлежит этой рецептуре');
          keep.add(skuId);
          await client.query(
            `update product_skus
                set name = $2, price = $3, cost_price = $4, issue_type = $5, is_active = $6, qty_base = $7,
                    price_basis = $8, archived = $9
              where id = $1`,
            [skuId, s.name, s.price, s.costPrice, issueType, s.isActive, s.qtyBase, s.priceBasis, s.archived]
          );
        } else {
          const { rows } = await client.query(
            `insert into product_skus (product_id, name, price, cost_price, issue_type, is_active, qty_base, price_basis, archived)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
            [id, s.name, s.price, s.costPrice, issueType, s.isActive, s.qtyBase, s.priceBasis, s.archived]
          );
          skuId = Number(rows[0].id);
          keep.add(skuId);
        }
        await client.query('delete from product_sku_packages where sku_id = $1', [skuId]);
        for (const packageId of s.packageIds) {
          await client.query(
            'insert into product_sku_packages (sku_id, package_id) values ($1, $2) on conflict do nothing',
            [skuId, packageId]
          );
        }
      }
      // Фасовки, которых нет в присланном составе, не удаляем физически:
      // на них могут ссылаться заказы. Убираем в архив (мягкое удаление).
      for (const old of existing) {
        if (!keep.has(old)) {
          await client.query(
            'update product_skus set archived = true, is_active = false where id = $1',
            [old]
          );
        }
      }

      await auditTx(client, req.user, {
        action: 'update',
        entity: 'product',
        entityId: id,
        title: `Рецептура · ${name}`,
        details: { nodes: nodes.length, skus: skus.length },
      });
    });

    res.json({ ok: true });
  })
);
