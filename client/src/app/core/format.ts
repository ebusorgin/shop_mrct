/** Форматирование количества из БАЗОВЫХ единиц (г/мл/шт) в читаемые: кг/л — только отображение. */
export function fmtQty(baseQty: number, unitCode: string, signed = false): string {
  const abs = Math.abs(baseQty);
  const sign = signed && baseQty < 0 ? '−' : '';
  if (unitCode === 'г') {
    return abs >= 1000 ? `${sign}${trim(abs / 1000)} кг` : `${sign}${trim(abs)} г`;
  }
  if (unitCode === 'мл') {
    return abs >= 1000 ? `${sign}${trim(abs / 1000)} л` : `${sign}${trim(abs)} мл`;
  }
  return `${sign}${trim(abs)} ${unitCode}`;
}

export function trim(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Единица количества отчёта-отгрузки по-русски: кг / л / шт / порц. */
export function reportUnitLabel(unit: string): string {
  if (unit === 'kg') return 'кг';
  if (unit === 'l') return 'л';
  if (unit === 'kom') return 'шт';
  return 'порц.';
}

/** Количество в единицах отчёта-отгрузки: «3 кг», «5 порц.», «30 шт». */
export function fmtReportQty(qty: number, unit: string): string {
  return `${trim(qty)} ${reportUnitLabel(unit)}`;
}

/** Округление денег до копеек (сотых dinara) — тысячных на UI быть не должно. */
export function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtMoney(n: number): string {
  return `${trim(cents(n))} ₽`;
}

/** Цена за базовую единицу -> цена за удобную для чтения единицу (только отображение). */
export function fmtCost(baseCost: number, unitCode: string): string {
  let per = baseCost;
  let suffix = unitCode;
  if (unitCode === 'г' && baseCost * 1000 < 10000) { per = baseCost * 1000; suffix = 'кг'; }
  if (unitCode === 'мл' && baseCost * 1000 < 10000) { per = baseCost * 1000; suffix = 'л'; }
  return `${trim(per)} ₽/${suffix}`;
}

export function today(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Момент времени из ISO -> «28.10.2026 14:05» (локальное время); пусто -> «—». */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = (x: number) => String(x).padStart(2, '0');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Извлекает человекочитаемую ошибку из ответа HttpErrorResponse. */
export function httpErr(e: unknown): string {
  const anyErr = e as { error?: { error?: string; details?: unknown }; status?: number; message?: string };
  if (anyErr?.error?.error) {
    const det = anyErr.error.details;
    return det ? `${anyErr.error.error}` : anyErr.error.error;
  }
  return anyErr?.message ?? String(e);
}
