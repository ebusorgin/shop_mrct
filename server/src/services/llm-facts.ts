/**
 * Справочные физические величины продуктов через GPT.
 *
 * Нужна, когда в рецептуре не хватает коэффициента пересчёта размерности («г» ↔ «мл»,
 * «шт» → «г»), а человек не помнит плотность молока или массу яйца: кнопка «Спросить у ИИ»
 * подставляет число в поле быстрой правки. Модель даёт ТОЛЬКО число и объяснение и ничего
 * не сохраняет — запись в базу делает человек тем же PATCH, который виден в журнале.
 *
 * Ответ модели по определению подозрителен: у каждого коэффициента есть физические границы,
 * и за них модель уходит регулярно (плотность 1030, «грамм в 1 шт» для пакета 250 г = 0.25).
 * Поэтому число проверяется здесь и наружу не проходит, если похоже на выдумку — вместо
 * него приходит value=null с объяснением, и человек видит, что спрашивать бессмысленно.
 */
import { config } from '../config';
import { ApiError } from '../http';
import { createGptClient } from './gpt-transport';

/** Поле-коэффициент пересчёта размерности (совпадает с именем поля в products/semi_products). */
export type ConvField = 'gPerPcs' | 'mlPerPcs' | 'gPerMl';

interface FieldSpec {
  /** Как формулируем вопрос модели — с явными единицами, чтобы не переводила «на своё». */
  ask: string;
  /** Единица ответа. */
  unit: string;
  /** Физические границы: вне их число не отдаём человеку. */
  min: number;
  max: number;
  /** Что это за число в терминах склада — подставляем в промпт и в подсказку. */
  what: string;
  /** Типичные ловушки поля — модель про них спрашиваем отдельно. */
  traps: string;
}

export const CONV_FIELDS: Record<ConvField, FieldSpec> = {
  gPerMl: {
    ask: 'сколько ГРАММ весит ОДИН МИЛЛИЛИТР этого продукта',
    unit: 'г/мл',
    min: 0.05,
    max: 5,
    what: 'плотность продукта (1 мл = сколько г)',
    traps:
      'Плотно упакованное/пюрированное (пюре, фарш, нарезка) считаете как массу вещества, а не как ' +
      'насыпную плотность; для сыпучих указывайте насыпную (как лежит в стакане), а не истинную.',
  },
  gPerPcs: {
    ask: 'сколько ГРАММ в ОДНОЙ ШТУКЕ этого продукта',
    unit: 'г/шт',
    min: 0.01,
    max: 25000,
    what: 'масса одной штуки (1000 шт = сколько кг)',
    traps:
      '«Штука» — это то, что на складе лежит одной единицей учёта: головка, пучок, пакет, бутылка, ' +
      'коробка. Если продукт в штуках — это фасовка, а не предмет, так и напишите.',
  },
  mlPerPcs: {
    ask: 'сколько МИЛЛИЛИТРОВ в ОДНОЙ ШТУКЕ этого продукта',
    unit: 'мл/шт',
    min: 0.01,
    max: 25000,
    what: 'объём одной штуки (1000 шт = сколько литров)',
    traps: '«Штука» — одна единица учёта: бутылка, банка, пакет, головка. Объём — содержимого, не тары.',
  },
};

export const isConvField = (v: unknown): v is ConvField => typeof v === 'string' && v in CONV_FIELDS;

/** Что возвращаем интерфейсу. */
export interface AiCoefficient {
  /** Готовое число для поля; null — модель не смогла ответить осмысленно. */
  value: number | null;
  /** high | medium | low — как модель сама оценила ответ. */
  confidence: string;
  /** Короткое объяснение по-русски: чему равно, от чего зависит, что проверить. */
  reason: string;
  /** Модель, которая отвечала — попадает в журнал вместе с сохранённым значением. */
  model: string;
}

const SYSTEM =
  'Ты — справочник по пищевым продуктам для технолога пищевого цеха. ' +
  'Отвечаешь строго ОДНИМ JSON без markdown и без текста вне JSON. ' +
  'Ты не выдумываешь точность: если у продукта нет одного общепринятого значения, так и пишешь. ' +
  'Числа — только в тех единицах, о которых спросили, десятичная точка, без разделителей тысяч.';

function task(f: FieldSpec, what: { name: string; kind: string; unitCode: string | null; context: string | null; current: number | null }): string {
  return (
    `ЗАПИСЬ СКЛАДА: «${what.name}» (${what.kind})\n` +
    `Учитывается на складе в: ${what.unitCode ?? 'единица не задана'}\n` +
    (what.context ? `Описание/категория из карточки: ${what.context}\n` : '') +
    (what.current != null ? `Сейчас в системе задано: ${what.current} ${f.unit}\n` : 'Сейчас в системе значение не задано.\n') +
    `\nВОПРОС: ${f.ask}? Это ${f.what}, единицы ответа — ${f.unit}.\n` +
    `УЧТИ: ${f.traps}\n` +
    `Если «${what.name}» — собирательное название (смесь, соус, «специи», нарезка без уточнения) и одного значения нет: ` +
    `дай самое типичное для этой записи и обязательно опиши в reason, насколько оно может плавать.\n` +
    `Если ответа не знаешь вовсе — value: null и в reason напиши, что нужно посмотреть (упаковку, поставщика, замер).\n` +
    `\nФОРМАТ ОТВЕТА (только JSON):\n` +
    `{"value": number|null, "confidence": "high"|"medium"|"low", "reason": "1-3 короткие фразы по-русски: значение, ` +
    `от чего зависит, типичный диапазон, что проверить"}`
  );
}

/** Вытащить JSON из ответа: модель иногда оборачивает его в ```json, несмотря на запрет. */
function parseObject(text: string): Record<string, unknown> {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  const slice = s >= 0 && e > s ? t.slice(s, e + 1) : t;
  return JSON.parse(slice) as Record<string, unknown>;
}

/**
 * Спросить у модели один коэффициент пересчёта размерности.
 * Транспорт (напрямую или через Tor) и ключ — общие с разбором накладных: createGptClient().
 */
export async function askConvCoefficient(what: {
  name: string;
  kind: string;
  unitCode: string | null;
  context: string | null;
  field: ConvField;
  current: number | null;
}): Promise<AiCoefficient> {
  const spec = CONV_FIELDS[what.field];
  const oa = await createGptClient(); // без ключа бросает 501 — так же, как импорт накладных
  let text = '';
  try {
    const r = await oa.chat.completions.create({
      model: config.openaiModel,
      response_format: { type: 'json_object' },
      max_completion_tokens: 700,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: task(spec, what) },
      ],
    });
    text = r.choices[0]?.message?.content ?? '';
  } catch (e) {
    throw new ApiError(502, `GPT не ответил: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = parseObject(text);
  } catch {
    throw new ApiError(502, `GPT вернул не JSON: ${text.slice(0, 160) || 'пустой ответ'}`);
  }

  const reason = String(data.reason ?? '').trim().slice(0, 400);
  const confidence = ['high', 'medium', 'low'].includes(String(data.confidence)) ? String(data.confidence) : 'low';
  const raw = typeof data.value === 'string' ? Number(data.value.replace(',', '.')) : Number(data.value);

  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      value: null,
      confidence,
      reason: reason || 'модель не дала числовое значение',
      model: config.openaiModel,
    };
  }
  if (raw < spec.min || raw > spec.max) {
    // число физически невозможно для этого поля — почти всегда перевод не в те единицы
    return {
      value: null,
      confidence: 'low',
      reason:
        `GPT ответил ${raw} ${spec.unit} — это вне физических пределов поля ` +
        `(${spec.min}…${spec.max} ${spec.unit}), значение не подставляем. Ответ модели: ${reason || '—'}`,
      model: config.openaiModel,
    };
  }
  // округляем до микрона/миллиграмма: лишние знаки модель всё равно не гарантирует
  const value = Math.round(raw * 1e6) / 1e6;
  return { value, confidence, reason, model: config.openaiModel };
}
