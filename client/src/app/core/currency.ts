import { signal } from '@angular/core';

/**
 * Значок валюты в суммах CRM.
 *
 * Бизнес сербский: документы и каталог в динарах, ₽ в интерфейсе — ошибка.
 * Значок хранится в настройках (server app_settings, ключ `currency`), грузится
 * при входе и меняется без перезагрузки: все суммы читают этот сигнал.
 */
export const DEFAULT_CURRENCY_SYMBOL = 'дин.';

/** Быстрый выбор в настройках: динар, ISO-код и евро для прайсов поставщиков. */
export const CURRENCY_PRESETS = ['дин.', 'RSD', '€'] as const;

export const currencySymbol = signal(DEFAULT_CURRENCY_SYMBOL);

export function setCurrencySymbol(symbol: string | null | undefined): void {
  const clean = String(symbol ?? '').replace(/\s+/g, ' ').trim();
  currencySymbol.set(clean ? clean.slice(0, 6) : DEFAULT_CURRENCY_SYMBOL);
}
