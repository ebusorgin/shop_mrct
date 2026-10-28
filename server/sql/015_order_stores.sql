-- ============================================================
-- 015: Заказы магазинов из Google Таблицы — справочники.
--   stores      витрина магазина (103…110 = последние 3 цифры «Mix 381xx»);
--   order_tabs  синхронизированные листы-даты Google Таблицы (кеш источника);
--   tech_cards.plu — внешний код товара для точного сопоставления.
-- Идемпотентно.
-- ============================================================

create table if not exists stores (
  id          int primary key,                    -- 103…110
  code        text unique not null,               -- 'Mix 38103' — как в таблице
  name        text not null,
  active      boolean not null default true,
  position    int not null default 0
);

insert into stores (id, code, name, position) values
  (103, 'Mix 38103', 'Магазин 103', 1),
  (104, 'Mix 38104', 'Магазин 104', 2),
  (105, 'Mix 38105', 'Магазин 105', 3),
  (106, 'Mix 38106', 'Магазин 106', 4),
  (107, 'Mix 38107', 'Магазин 107', 5),
  (108, 'Mix 38108', 'Магазин 108', 6),
  (109, 'Mix 38109', 'Магазин 109', 7),
  (110, 'Mix 38110', 'Магазин 110', 8)
on conflict (id) do nothing;

-- Лист Google Таблицы = дата доставки (вкладка «28.10», «04.11»…). Кеш: хэш содержимого
-- позволяет не трогать заказы, если лист с прошлой проверки не менялся.
create table if not exists order_tabs (
  id            serial primary key,
  sheet_name    text unique not null,             -- имя вкладки как в таблице
  extract_date  date,                             -- дата листа (yyyy-mm-dd, год достроен)
  content_hash  text,                             -- md5 разобранного содержимого
  row_count     int not null default 0,           -- строок-позиций после разбора
  last_sync_at  timestamptz,
  last_error    text
);

-- Внешний PLU у готовой продукции (в таблице бывает «M924»).
alter table tech_cards add column if not exists plu text;
create unique index if not exists tech_cards_plu_uniq on tech_cards (plu) where plu is not null and plu <> '';
