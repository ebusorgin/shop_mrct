/**
 * «Спросить у ИИ» — подсказки, которые человек потом сохраняет сам.
 *
 * POST /api/ai/coefficient  { sourceType: 'raw'|'semi', refId, field: 'gPerPcs'|'mlPerPcs'|'gPerMl' }
 *   → { field, value, confidence, reason, model }
 *
 * Спрашиваем только то, что можно проверить: физическую величину для записи справочника
 * (плотность, масса или объём одной штуки). В базу ручка НЕ пишет — значение подставляется
 * в поле, а сохранение делает человек обычным PATCH продукта/заготовки; там изменение
 * и остаётся в журнале, с пометкой, что число подсказала модель.
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, reqInt, wrap } from '../http';
import { askConvCoefficient, isConvField, CONV_FIELDS } from '../services/llm-facts';

export const aiRouter = Router();

/**
 * Карточка продукта или заготовки — имя, единица учёта и то, что в ней написано о товаре.
 * Коэффициенты выводим camelCase-алиасами: имена совпадают с `field` из запроса, поэтому
 * текущее значение берём из строки одним выражением (row[field]).
 */
const convCols = (t: string): string =>
  `${t}.g_per_pcs::float8 as "gPerPcs", ${t}.ml_per_pcs::float8 as "mlPerPcs", ${t}.g_per_ml::float8 as "gPerMl"`;

const SQL_PRODUCT = `
  select p.name, u.code as "unitCode", nullif(trim(p.category), '') as context,
         ${convCols('p')}
    from products p
    left join units u on u.id = p.unit_id
   where p.id = $1`;

const SQL_SEMI = `
  select sp.name, u.code as "unitCode", nullif(trim(sp.note), '') as context,
         ${convCols('sp')}
    from semi_products sp
    left join units u on u.id = sp.unit_id
   where sp.id = $1`;

aiRouter.post(
  '/coefficient',
  wrap(async (req, res) => {
    const body = req.body ?? {};
    const sourceType = body.sourceType === 'semi' ? 'semi' : 'raw';
    const field = body.field;
    if (!isConvField(field)) throw new ApiError(400, 'field должен быть gPerPcs, mlPerPcs или gPerMl');
    const refId = reqInt(body, 'refId');

    const { rows } = await pool.query(sourceType === 'semi' ? SQL_SEMI : SQL_PRODUCT, [refId]);
    if (!rows.length) {
      throw new ApiError(404, sourceType === 'semi' ? 'Полуфабрикат не найден' : 'Продукт не найден');
    }
    const row = rows[0];
    const answer = await askConvCoefficient({
      name: row.name,
      kind: sourceType === 'semi' ? 'вложенная заготовка цеха' : 'продукт номенклатуры',
      unitCode: row.unitCode ?? null,
      context: row.context ?? null,
      field,
      current: row[field] ?? null,
    });
    res.json({ field, unit: CONV_FIELDS[field].unit, ...answer });
  })
);
