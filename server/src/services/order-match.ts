/**
 * Сопоставление строк Google Таблицы с каталогом CRM (готовая продукция = tech_cards).
 * Порядок: 1) точный PLU; 2) нормализованное совпадение имени; 3) нечёткий поиск
 * (токены + Левенштейн) с порогом. Результат — card_id или null (строка заводится
 * внешним именем, товар позже подвяжется через ручную сопоставку).
 */
import { pool } from '../db';

export interface CardRef {
  id: number;
  name: string;
  plu: string | null;
  unitCode: string;
  /** базовая единица выхода техкарты: 'г' | 'мл' | 'шт' */
  baseUnitCode: string;
  /** вес/объём одной порции выхода (для пересчёта «порц» источника в базовые единицы) */
  portionQty: number;
}

export interface MatchResult {
  cardId: number | null;
  via: 'plu' | 'name' | 'fuzzy' | null;
  sim: number;
}

/** Убираем «!!ЗАКАЗ КРАТНО 2 КГ!!», скобки, пунктуацию; нижний регистр. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/!![^!]*!!/g, ' ')
    .replace(/[(«”"][^)]*[)»"]/g, ' ')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\d+\s*(кг|г|л|мл|шт|g|kg)\b/g, ' ') // «Блины с сыром/ветчиной(100г)» ~ «Блины с сыром ветчиной»
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / max;
}

/** Сходство по токенам: сколько слов источника найдено вcandidate + общая сим. */
function score(srcNorm: string, candNorm: string): number {
  const exact = srcNorm === candNorm ? 1 : 0;
  if (exact) return 1;
  const srcToks = srcNorm.split(' ').filter((t) => t.length > 2);
  const candSet = new Set(candNorm.split(' '));
  const overlap = srcToks.length ? srcToks.filter((t) => candSet.has(t) || t.startsWith(candNorm) || candNorm.startsWith(t)).length / srcToks.length : 0;
  return 0.55 * overlap + 0.45 * similarity(srcNorm, candNorm);
}

const FUZZY_THRESHOLD = 0.62;

export class CardMatcher {
  private cards: CardRef[] = [];
  private normIdx: { norm: string; card: CardRef }[] = [];

  async load(): Promise<void> {
    const { rows } = await pool.query(`
      select tc.id, tc.name, tc.plu, u.code as "unitCode", u.code as "baseUnitCode",
             coalesce(tc.portion_qty::float8, 0) as "portionQty"
        from tech_cards tc
        join units u on u.id = tc.portion_unit_id
       order by tc.name`);
    this.cards = rows as CardRef[];
    this.normIdx = this.cards.map((c) => ({ norm: normalizeName(c.name), card: c }));
  }

  async match(name: string, plu: string | null): Promise<MatchResult> {
    if (!this.cards.length) await this.load();
    if (plu) {
      const byPlu = this.cards.find((c) => c.plu && c.plu.trim().toUpperCase() === plu.trim().toUpperCase());
      if (byPlu) return { cardId: byPlu.id, via: 'plu', sim: 1 };
    }
    const src = normalizeName(name);
    if (!src) return { cardId: null, via: null, sim: 0 };
    const exact = this.normIdx.find((x) => x.norm === src);
    if (exact) return { cardId: exact.card.id, via: 'name', sim: 1 };
    let best: { card: CardRef; sc: number } | null = null;
    for (const x of this.normIdx) {
      const sc = score(src, x.norm);
      if (!best || sc > best.sc) best = { card: x.card, sc };
    }
    if (best && best.sc >= FUZZY_THRESHOLD) return { cardId: best.card.id, via: 'fuzzy', sim: best.sc };
    return { cardId: null, via: null, sim: best?.sc ?? 0 };
  }

  byId(id: number): CardRef | undefined {
    return this.cards.find((c) => c.id === id);
  }
}

/** Единицы-«штуки» источника: порции/штуки (пересчёт в граммы — через вес порции техкарты). */
const COUNT_UNITS = new Set(['шт', 'порц', 'порция', 'порции', 'des']);

/**
 * Пересчёт «печатного» количества источника в базовые единицы CRM (кг->г, порц->г и т.п.).
 * portionQty — грамм/мл на одну порцию техкарты; нужен, когда источник считает порциями,
 * а карточка хранится в г/мл.
 */
export function toBase(qty: number, printedUnit: string, baseUnitCode: string, portionQty = 0): number {
  const mass = { г: 1, кг: 1000, т: 1_000_000 } as Record<string, number>;
  const vol = { мл: 1, л: 1000 } as Record<string, number>;
  if (COUNT_UNITS.has(printedUnit)) {
    if (baseUnitCode === 'шт') return qty;
    if ((baseUnitCode === 'г' || baseUnitCode === 'мл') && portionQty > 0) return qty * portionQty;
    return qty;
  }
  if (baseUnitCode === 'шт') return qty;
  if (baseUnitCode === 'г') return qty * (mass[printedUnit] ?? 1);
  if (baseUnitCode === 'мл') return qty * (vol[printedUnit] ?? 1);
  return qty;
}

/** Минимальный набор полей, нужный для обратного пересчёта (OrderItem удовлетворяет структурно). */
export interface PrintedQtyInput {
  qty: number;
  unitCode: string | null;
  cardUnit: string | null;
  portionQty: number;
}

/**
 * Обратное к toBase: «печатное» количество источника из базового (г/мл/шт).
 * Нужно для стоимости: VK в таблице задаётся за печатную единицу (за кг / за порцию).
 * Общая для сводки заказов и агрегатов раздела «Точки продаж».
 */
export function printedQty(it: PrintedQtyInput): number {
  const base = it.cardUnit ?? it.unitCode ?? 'г';
  const shown = it.unitCode ?? base;
  if (COUNT_UNITS.has(shown)) {
    if (base === 'шт' || it.portionQty <= 0) return it.qty;
    return it.qty / it.portionQty; // порц: г -> кол-во порций
  }
  const massVol: Record<string, number> = { г: 1, кг: 1000, мл: 1, л: 1000 };
  if (base === 'шт') return it.qty;
  const f = massVol[shown];
  return f ? it.qty / f : it.qty;
}
