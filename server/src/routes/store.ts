/**
 * API магазинного сотрудника: он видит только свою точку.
 *
 *   GET /api/store — карточка своей точки (только просмотр: данные заполняет офис)
 *   GET /api/store/order-catalog — продукция производства для оформления заказа
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, wrap } from '../http';
import { requireStore } from '../services/auth';

export const storeRouter = Router();

const CARD_SQL = `
  select s.id, s.code, s.name, s.active, s.position,
         s.address, s.phone, s.email,
         s.contact_person as "contactPerson",
         s.opening_hours as "openingHours",
         s.pib, s.mbr, s.account_no as "accountNo", s.note
    from stores s where s.id = $1`;

storeRouter.get(
  '/',
  requireStore,
  wrap(async (req, res) => {
    const storeId = req.user?.storeId as number;
    const { rows } = await pool.query(CARD_SQL, [storeId]);
    if (!rows.length) throw new ApiError(404, 'Магазин не найден');
    res.json(rows[0]);
  })
);

/**
 * Продукция производства для формы заказа магазина: только карточка продукта
 * (название, выход, каталог), состав и склады магазину не нужны.
 */
storeRouter.get(
  '/order-catalog',
  requireStore,
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      select tc.id, tc.name, tc.note, tc.portion_qty::float8 as "portionQty",
             pu.code as "portionUnitCode",
             tc.catalog_id as "catalogId", cc.name as "catalogName",
             cc.icon as "catalogIcon", cc.color as "catalogColor"
        from tech_cards tc
        join units pu on pu.id = tc.portion_unit_id
        left join product_catalogs cc on cc.id = tc.catalog_id
       order by cc.position nulls last, cc.name nulls last, tc.name`);
    res.json(rows);
  })
);
