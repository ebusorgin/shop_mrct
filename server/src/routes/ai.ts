/**
 * «Спросить у ИИ» — подсказки, которые человек потом сохраняет сам.
 *
 * POST /api/ai/coefficient  { sourceType: 'raw'|'semi', refId, field: 'gPerPcs'|'mlPerPcs'|'gPerMl' }
 *   либо для ещё не сохранённой позиции: { sourceType, name, unitCode?, context?, field }
 *   → { field, value, confidence, reason, model }
 *
 * Спрашиваем только то, что можно проверить: физическую величину для записи справочника
 * (плотность, масса или объём одной штуки). В базу ручка НЕ пишет — значение подставляется
 * в поле, а сохранение делает человек обычным PATCH продукта/заготовки; там изменение
 * и остаётся в журнале, с пометкой, что число подсказала модель.
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, reqInt, reqStr, wrap } from '../http';
import { askConvCoefficient, askConvCoefficients, isConvField, CONV_FIELDS } from '../services/llm-facts';

export const aiRouter = Router();

/**
 * Карточка продукта или заготовки — имя, единица учёта и то, что в ней написано о товаре.
 * Коэффициенты выводим camelCase-алиасами: имена совпадают с `field` из запроса, поэтому
 * текущее значение берём из строки одним выражением (row[field]).
 */
const convCols = (t: string): string =>
  `${t}.g_per_pcs::float8 as "gPerPcs", ${t}.ml_per_pcs::float8 as "mlPerPcs", ${t}.g_per_ml::float8 as "gPerMl"`;

const SQL_PRODUCT = `
  select p.name, u.code as "unitCode", nullif(trim(pc.name), '') as context,
         ${convCols('p')}
    from products p
    left join product_categories pc on pc.id = p.category_id
    left join units u on u.id = p.unit_id
   where p.id = $1`;

/** Необязательный текст из тела запроса: пустое/нестроковое значение — «не задано». */
function optText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s || null;
}

aiRouter.post(
  '/coefficient',
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = body.field;
    if (!isConvField(field)) throw new ApiError(400, 'field должен быть gPerPcs, mlPerPcs или gPerMl');

    // Сохранённая позиция: описание и текущее значение берём из базы. Новую позицию
    // (модалка «Новая позиция») описывает клиент — до сохранения записи в базе ещё нет.
    const hasId = body.refId !== undefined && body.refId !== null && body.refId !== '';
    let what: Parameters<typeof askConvCoefficient>[0];
    if (hasId) {
      const refId = reqInt(body, 'refId');
      const { rows } = await pool.query(SQL_PRODUCT, [refId]);
      if (!rows.length) throw new ApiError(404, 'Продукт не найден');
      const row = rows[0];
      what = {
        name: row.name,
        kind: 'продукт номенклатуры',
        unitCode: row.unitCode ?? null,
        context: row.context ?? null,
        field,
        current: row[field] ?? null,
      };
    } else {
      what = {
        name: reqStr(body, 'name'),
        kind: 'продукт номенклатуры',
        unitCode: optText(body.unitCode),
        context: optText(body.context),
        field,
        current: null,
      };
    }
    const answer = await askConvCoefficient(what);
    res.json({ field, unit: CONV_FIELDS[field].unit, ...answer });
  })
);

/**
 * POST /api/ai/coefficients — сразу три коэффициента одним запросом к ИИ.
 * Один процесс Qoder CLI вместо трёх параллельных; ответ тот же, что у /coefficient.
 */
aiRouter.post(
  '/coefficients',
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hasId = body.refId !== undefined && body.refId !== null && body.refId !== '';
    let what;
    if (hasId) {
      const refId = reqInt(body, 'refId');
      const { rows } = await pool.query(SQL_PRODUCT, [refId]);
      if (!rows.length) throw new ApiError(404, 'Продукт не найден');
      const row = rows[0];
      what = {
        name: row.name,
        kind: 'продукт номенклатуры',
        unitCode: row.unitCode ?? null,
        context: row.context ?? null,
        current: {
          gPerPcs: row.gPerPcs ?? null,
          mlPerPcs: row.mlPerPcs ?? null,
          gPerMl: row.gPerMl ?? null,
        },
      };
    } else {
      what = {
        name: reqStr(body, 'name'),
        kind: 'продукт номенклатуры',
        unitCode: optText(body.unitCode),
        context: optText(body.context),
        current: null,
      };
    }
    const results = await askConvCoefficients(what);
    res.json({ results });
  })
);
