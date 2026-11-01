-- ============================================================
-- 031: Двусторонняя синхронизация заказов с Google-таблицей (БД приоритетнее).
--
--  Быкло две несводимые формы одной линии заказа:
--    • строка листа  — tab_id NOT NULL, уникальна (tab_id, store, source_name);
--    • ручной заказ  — tab_id IS NULL, слияние по (store, date_tab, source_name, 'manual').
--  Если записать ручной заказ в таблицу и потом импортировать таблицу обратно,
--  лист создаст параллельную g_sheet-строку = дубль. Поэтому вводим ОБЩУЮ
--  идентичность линии line_key = (store, date, нормализованное имя) независимо
--  от источника, и служебные поля для сведения/эхо-подавления:
--    • sheet_qty     — количество, которое мы последний раз сверили с таблицей (базлайн);
--    • db_edited_at  — когда линию меняли из CRM (place/qty/status/cancel);
--    • pushed_at     — когда значение ultimo уходило в таблицу.
--  Правило конфликта: если таблица разошлась с sheet_qty, а CRM правил позже
--  последней отправки (db_edited_at > pushed_at) — побеждает БД и выталкивается
--  в таблицу; иначе — это правка человека, импортируем в БД.
--
-- Идемпотентно.
-- ============================================================

alter table orders add column if not exists sheet_qty    numeric;
alter table orders add column if not exists db_edited_at timestamptz;
alter table orders add column if not exists pushed_at    timestamptz;

-- Общая идентичность линии. Выражение иммутабельно (без regexp/to_char/date::text):
-- date - date = int, store::text/lower/btrim имmutables. Хранимый generated-столбец.
alter table orders add column if not exists line_key text
  generated always as (
    store_id::text || E'\n' || (date_tab - date '2000-01-01')::text || E'\n' || lower(btrim(source_name))
  ) stored;

-- Схлопываем уже существующие дубли одной линии (та же точка/дата/имя) — остаётся
-- строка с наибольшим id (как в 018). Иначе уникальный индекс ниже не создастся.
delete from orders o
 where exists (
   select 1 from orders x
    where x.line_key = o.line_key and x.id > o.id
 );

create unique index if not exists orders_line_key_uniq on orders (line_key);

-- Базлайн: листовые строки уже отражают таблицу (sheet_qty = текущее количество);
-- ручные (ещё не отправлявшиеся) оставляем с NULL sheet_qty, чтобы ушли в таблицу.
update orders set sheet_qty = quantity where source = 'g_sheet' and sheet_qty is null;

-- Время последней правки БД и последней отправки: задаём отправной точкой updated_at,
-- чтобы до первого реального пуша g_sheet-строки считались «сверенными» (не выталкивались
-- массово на включении фичи), а ручные — требующими отправки.
update orders set db_edited_at = updated_at where db_edited_at is null;
update orders set pushed_at = now() where source = 'g_sheet' and pushed_at is null;
