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
  packaging_id   int,
  updated_at     timestamptz not null default now(),
  primary key (spreadsheet_id, tab_name, row_name)
);

-- Старый формат связей хранил id техкарты; после удаления legacy-модели колонка не нужна.
alter table if exists google_sheet_manual_links drop column if exists card_id;
alter table if exists google_sheet_manual_links add column if not exists packaging_id int;
alter table if exists google_sheets drop column if exists links_version;

-- ---------- Комментарии к таблицам ----------
-- Идемпотентно: descriptions обновляются при каждом старте сервера.

comment on table google_sheets is
  'Один скачанный документ Google Sheets: заголовок, URL, время синхронизации, список несопоставленных названий и версия формата ссылок на фасовки.';

comment on table google_sheet_tabs is
  'Листы Google-таблицы: имя вида DD.MM, ширина, строки как в Google и массив ссылок links на фасовки по индексам строк.';

comment on table google_sheet_manual_links is
  'Ручные решения сопоставления строк листа: нормализованное название строки и фасовка карты либо явное «не сопоставлять» (packaging_id = null).';

-- ---------- Комментарии к колонкам (mixmarkt_sheets) ----------
-- Идемпотентно: описания обновляются при каждом старте.
comment on column google_sheet_manual_links.spreadsheet_id is 'Идентификатор документа Google Sheets.';
comment on column google_sheet_manual_links.tab_name is 'Имя листа.';
comment on column google_sheet_manual_links.row_name is 'Нормализованное название строки листа.';
comment on column google_sheet_manual_links.updated_at is 'Когда ручное решение изменено.';
comment on column google_sheet_manual_links.packaging_id is 'Фасовка карты (prod_packagings.id); null — не сопоставлять.';
comment on column google_sheet_tabs.spreadsheet_id is 'Идентификатор документа Google Sheets.';
comment on column google_sheet_tabs.position is 'Порядок листа в документе.';
comment on column google_sheet_tabs.name is 'Имя листа, обычно DD.MM.';
comment on column google_sheet_tabs.width is 'Ширина листа в колонках.';
comment on column google_sheet_tabs.rows is 'Строки листа как в Google, в JSON.';
comment on column google_sheet_tabs.links is 'id фасовок по индексам строк, в JSON.';
comment on column google_sheets.spreadsheet_id is 'Идентификатор документа Google Sheets; первичный ключ.';
comment on column google_sheets.title is 'Заголовок документа.';
comment on column google_sheets.url is 'URL документа.';
comment on column google_sheets.synced_at is 'Когда документ последний раз синхронизирован.';
comment on column google_sheets.unmatched is 'Названия строк без сопоставления, в JSON.';
