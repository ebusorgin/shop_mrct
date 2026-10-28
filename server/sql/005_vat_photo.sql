-- ============================================================
-- 005: учёт PDV (НДС) + хранение исходного фото накладной в БД
--   waybills:  реквизиты поставщика (PIB), валюта, итоги нетто/PDV/брутто,
--              фото как bytea (файл переживает перезапуск и перенос БД)
--   waybill_items: ставка PDV по строке и сумма НДС
--   Цена в накладной — без PDV (Вред = Кол × Цена), поэтому avg_cost
--   остаётся корректной; НДС хранится отдельно и в расчёт себестоимости пока не входит.
-- ============================================================

alter table waybills add column if not exists supplier_pib text;          -- ДАВ / PIB поставщика
alter table waybills add column if not exists currency text not null default 'RSD'; -- валута (ДИН.)
alter table waybills add column if not exists total_net numeric(14,2);    -- Вредност без ПДВ (пересчёт по строкам)
alter table waybills add column if not exists total_vat numeric(14,2);    -- ПДВ износ (пересчёт по строкам)
alter table waybills add column if not exists total_gross numeric(14,2);  -- Наплата (укупно) (пересчёт по строкам)
alter table waybills add column if not exists doc_total_net numeric(14,2);   -- «Вредност» как напечатано в документе
alter table waybills add column if not exists doc_total_vat numeric(14,2);   -- «ПДВ» как напечатано
alter table waybills add column if not exists doc_total_gross numeric(14,2); -- «Наплата» как напечатано
alter table waybills add column if not exists file_data bytea;            -- исходное фото/скан
alter table waybills add column if not exists file_mime text;

alter table waybill_items add column if not exists vat_rate numeric(6,3);   -- ставка % (5, 10, 20)
alter table waybill_items add column if not exists vat_amount numeric(14,2);-- сумма НДС по строке

comment on column waybill_items.vat_rate is 'Ставка PDV в процентах; null = нет данных / без PDV';
