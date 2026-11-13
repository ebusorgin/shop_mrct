-- Схема отдельной базы mixmarkt_sheets: только скачанные листы Google-таблицы.
-- Файл идемпотентный: выполняется при каждом старте, существующие данные не трогает.

-- Скачанный документ целиком: заголовок и когда он обновлялся.
create table if not exists google_sheets (
  spreadsheet_id text primary key,
  title          text not null,
  url            text not null,
  synced_at      timestamptz not null
);

-- Лист документа: строки как в Google (массив массивов строк), ширина — число колонок.
create table if not exists google_sheet_tabs (
  spreadsheet_id text not null references google_sheets(spreadsheet_id) on delete cascade,
  position       int not null,
  name           text not null,
  width          int not null,
  rows           jsonb not null,
  primary key (spreadsheet_id, position)
);

-- Сопоставление с продукцией CRM: для каждой строки листа id техкарты (null — позиция не найдена).
alter table google_sheet_tabs add column if not exists links jsonb not null default '[]';

-- Уникальные названия позиций, которым не нашлось техкарты (для списка в интерфейсе).
alter table google_sheets add column if not exists unmatched jsonb not null default '[]';

-- Ручные сопоставления: строка листа (по названию) -> продукция. Переживают повторную
-- синхронизацию: сопоставление по названию применяется к каждой строке листа с тем же названием.
create table if not exists google_sheet_manual_links (
  spreadsheet_id text not null,
  tab_name       text not null,
  row_name       text not null,
  -- null — позицию явно оставили без продукции (перекрывает автоподбор)
  card_id        int,
  updated_at     timestamptz not null default now(),
  primary key (spreadsheet_id, tab_name, row_name)
);
alter table google_sheet_manual_links alter column card_id drop not null;

-- Ручная связь теперь указывает на фасовку; card_id остаётся для старых записей —
-- при чтении переводим его в базовую фасовку техкарты.
alter table google_sheet_manual_links add column if not exists packaging_id int;

-- 0 — links строк хранят id техкарт (старый формат), 1 — id фасовок.
-- Старые связи читаются через фасовку по умолчанию и заменяются при следующей синхронизации.
alter table google_sheets add column if not exists links_version int not null default 0;
