import { Router } from 'express';
import { pool } from '../db';
import { wrap } from '../http';

export const metaRouter = Router();

metaRouter.get(
  '/units',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      'select id, code, name, dimension, base_factor::float8 as "baseFactor" from units order by dimension, base_factor'
    );
    res.json(rows);
  })
);

metaRouter.get(
  '/categories',
  wrap(async (_req, res) => {
    const { rows } = await pool.query('select distinct category from products order by category');
    res.json(rows.map((r) => r.category));
  })
);

/** Справочник категорий номенклатуры (product_categories) — для выбора в форме позиции. */
metaRouter.get(
  '/categories-dictionary',
  wrap(async (_req, res) => {
    const { rows } = await pool.query('select id, name from product_categories order by name');
    res.json(rows);
  })
);

/** Каталоги готовой продукции (product_catalogs) — для выбора в карточке продукта. */
metaRouter.get(
  '/product-catalogs',
  wrap(async (_req, res) => {
    const { rows } = await pool.query('select id, name, icon, color from product_catalogs order by position, name');
    res.json(rows);
  })
);
