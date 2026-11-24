# MIX markt CRM: где хранятся данные, ключи и как записи сопоставляются

**Дата:** 2026-11-24  
**Область:** текущее состояние `shop_mrct`, ветка `main` (a4fddd6 + локальные незакоммиченные файлы)  
**Источник фактов:** `server/sql/init.sql`, `server/sql/sheets-init.sql`, `server/src`, локальная копия прод-базы от 2026-11-23.  
**Важно:** цифры объёмов ниже — локальная копия, а не production. Production не запрашивался.

## 1. Главное в одном экране

- Бизнес-данные лежат в **одной PostgreSQL-базе `mixmarkt_crm`**. Схема — единый идемпотентный файл `init.sql`, выполняется при старте.
- Скачанные листы Google-таблицы лежат в **отдельной базе `mixmarkt_sheets`** на том же PostgreSQL. С основной базой она связана только **числовыми id в JSON** — внешних ключей между базами нет.
- Фотографии накладных хранятся **в основной БД** (`waybills.file_data bytea`, дополнительные листы — base64 в `extra_files jsonb`), диск `server/uploads/waybills` — кэш. Сканы счетов поставщиков — файлы в `client/public/invoices`, в БД только путь `supplier_invoices.source_file`.
- Есть три пространства id, которые нельзя путать: **`products.id`** (складское сырьё), **`prod_nodes.id`** (узел карты), **`prod_packagings.id`** (фасовка — именно этот id лежит в заказах, отчётах и листах Google).
- Старая модель (`tech_cards`, `semi_products`, `product_packagings` и их дочерние таблицы) удалена. Рецептуры и фасовки живут только в `prod_nodes`, `prod_ops`, `prod_op_inputs` и `prod_packagings`; legacy-колонки тоже удалены.
- Часть связей карты производства и журнала склада — **программные, без FK**: `prod_nodes.ref_id`, `prod_ops.output_node_id`, `prod_op_inputs.node_id`, `prod_packagings.node_id`, `movements.doc_type/doc_id`.
- Сопоставление «строка документа → товар/фасовка» многоступенчатое: точное имя → псевдоним → товароведческий словарь → ответ ИИ → trigram-кандидаты; поставщик — PIB → GLN → счёт → название; строка Google-листа — точное название фасовки → название техкарты → базовое имя + граммовка → ручное решение.

## 2. Физическое размещение

| Хранилище | Что лежит | Где в коде/конфиге |
|---|---|---|
| PostgreSQL `mixmarkt_crm` | Все бизнес-сущности: склад, накладные, поставщики, карта, заказы, отчёты, пользователи, аудит, настройки, чат Qoder | `server/src/db.ts:3-11`, схема `server/sql/init.sql` |
| PostgreSQL `mixmarkt_sheets` | `google_sheets`, `google_sheet_tabs`, `google_sheet_manual_links` — только скачанные листы и решения сопоставления | `server/src/db-sheets.ts:13-17`, `server/sql/sheets-init.sql` |
| Google Sheets (внешний) | Живой источник листов «Микс Маркт Гастро», id `1YL2CweT4Lxjs3lPkRmfJjdY9VQ95yh7fbRFD-EhXXtE` | `server/src/services/google-sheet.ts:16-21` |
| БД: байты накладных | `waybills.file_data` (bytea), `extra_files` (jsonb, base64), `file_name`, `file_mime`, `stored_file` | `init.sql:296-335`, `waybills.ts:195-245` |
| Диск: кэш накладных | `server/uploads/waybills/<stored>` (gitignored) | `config.ts:16`, `.gitignore:15` |
| Диск: сканы счетов | `client/public/invoices/<supplier>/<number>.webp`, ссылка в `supplier_invoices.source_file` | `init.sql:727-743`, `init.sql:904-929` |
| Диск: этикетки | `client/public/labels/*.pdf` | `.gitignore:28` |
| Секреты | `server/.env`, `server/credentials.json` (Google service account); не в git | `.gitignore:5-6,35` |
| Внешний ИИ | OpenAI API или Qoder CLI; ключи в `server/.env` | `config.ts:13-15`, `services/qoder-cli.ts` |

Объёмы локальной копии: `mixmarkt_crm` ~15 МБ, `mixmarkt_sheets` ~8,9 МБ. Ключевые строки: 118 продуктов, 21 строка `stock`, 4 движения, 0 накладных, 4 поставщика, 16 счетов, 221 узел карты, 109 операций, 549 входов, 72 фасовки, 1022 заказа, 14 173 строки заказов, 673 записи аудита, 15 сообщений Qoder. В базе листов: 1 документ, 115 листов, 48 ручных связей.

## 3. Схема по доменам

### 3.1 Справочники, склад, роли

Диаграмма: [schema-core.mmd](schema-core.mmd)

| Таблица | PK / уникальность | Связи | Назначение и особенности |
|---|---|---|---|
| `units` | `id` PK; `code` UK | — | Только базовые единицы `г`, `мл`, `шт`; `base_factor = 1` закреплён CHECK |
| `products` | `id` PK; `name` UK | `unit_id → units.id` FK; `category_id → product_categories.id` FK | Складское сырьё. `category_id` — единственный ключ категории; коэффициенты `g_per_pcs`, `ml_per_pcs`, `g_per_ml`; `shelf_life_days`; `active` вместо удаления |
| `product_categories` | `id` PK; `name` UK; `icon` UK (если не пустая) | — | Справочник категорий сырья. На него ссылается `products.category_id`; имя используется только для отображения |
| `product_catalogs` | `id` PK; `name` UK; `icon` UK | — | Каталоги готовой продукции; на них ссылается `prod_nodes.catalog_id` |
| `product_aliases` | `id` PK; `alias` UK | `product_id → products.id` FK cascade | Нормализованное написание из накладной → товар. `alias_raw` — как в документе |
| `stock` | `product_id` PK | `product_id → products.id` FK cascade | Материализованный остаток и средняя. В локальной копии заполнена только у 21 из 118 продуктов |
| `movements` | `id` PK | `product_id → products.id` FK; `user_id → users.id` FK SET NULL | Журнал: `receipt` / `writeoff` / `adjustment`, `qty` со знаком в базовых единицах. `doc_type + doc_id` — полиморфная ссылка без FK |
| `stores` | `id` PK (103…110); `code` UK | — | Точка. `id` — числовой номер, `code` — `Mix 38103`; мягкое удаление `deleted_at` |
| `users` | `id` PK; `lower(login)` UK | `store_id → stores.id` FK SET NULL | `store_id = null` — офис; `is_admin` — администратор; пароль scrypt |
| `sessions` | `token_hash` PK | `user_id → users.id` FK cascade | В БД только `sha256` токена; сам токен в cookie `mix_session` |
| `audit_log` | `id` PK | `user_id → users.id` FK SET NULL | `entity + entity_id (text)` — полиморфно; `details jsonb` — diff/контекст |
| `app_settings` | `key` PK | — | JSON-настройки: `currency`, `delivery`, `gpt` |

Ключевые нюансы:

- `products.name` уникально на уровне БД, но проверка приложения (`assertNameFree`) регистронезависимая и сериализуется advisory-локом `nomenclature-name` (`server/src/services/name-check.ts:19-41`).
- Переименование категории меняет только `product_categories.name`: продукты ссылаются на неё по `category_id`, поэтому переписывать строки `products` не нужно. Удаление категории сначала переводит её продукты на id категории `прочее`, затем удаляет строку справочника.
- `stock` разрежен: при первом движении `applyMovement` создаёт нулевую строку (`stock.ts:34-43`), но при старте бэкфилла нет. Товары без строки не видны в запросах с `join stock` (например, `routes/stock.ts:13-22`).
- Для сопоставления имён включено расширение `pg_trgm`; GIN-индексы `products_name_trgm` и `product_aliases_trgm` ускоряют поиск похожих названий (`init.sql:479-480`), а сам порог `similarity > 0.30` задан в запросе (`import.ts:380-395`).

### 3.2 Закупки: накладные, поставщики, счета

| Таблица | PK / уникальность | Связи | Назначение |
|---|---|---|---|
| `waybills` | `id` PK; `btrim(number)` UK там, где `status <> 'reversed'` | `accepted_by`, `reversed_by → users.id` | Шапка прихода. Статус `posted` / `reversed`; фото/сканы в `file_data` и `extra_files`; итоги `total_*` и `doc_total_*` |
| `waybill_items` | `id` PK | `waybill_id → waybills.id` FK cascade; `product_id → products.id` FK; `unit_id → units.id` FK | Строки в **единице документа**, не в базовой. Цена без PDV, `vat_rate`, `vat_amount` |
| `suppliers` | `id` PK; `code` UK | — | Справочник продавцов: `pib`, `mb`, `gln`, `accounts jsonb`, `legal_name` |
| `supplier_invoices` | `id` PK; `(supplier_id, number)` UK | `supplier_id → suppliers.id` FK | Оцифрованный счёт — **документ, не приход**. Склад не трогает |
| `supplier_invoice_items` | `id` PK; `(invoice_id, position)` UK | `invoice_id → supplier_invoices.id` FK cascade | Позиции счёта: `unit` только `KG` / `KOM`, скидка, PDV, `net` |

Ключевые нюансы:

- Номер накладной уникален только среди неотменённых; откат освобождает номер. Это реализовано частичным уникальным индексом (`init.sql:486-499`) и проверкой в `ingestWaybill` (`waybills.ts:51-61`).
- `waybill_items.qty` хранит количество в **напечатанной** единице (кг, л, шт). При приходе оно пересчитывается в базовое; обратно из строки накладной можно получить базовое только по текущим коэффициентам товара — отдельного `qty_base` в строке нет.
- `supplier_invoices` связаны с поставщиком жёстко, а накладная `waybills.supplier` — **текст**; связь накладной с `suppliers` держится на каноническом имени/PIB, а не на FK.
- Сканы счетов: `source_file` хранит относительный путь (`wfc/26-3501-046772.webp`), сами файлы — в `client/public/invoices`.

### 3.3 Производственная карта

Диаграмма: [schema-production.mmd](schema-production.mmd)

| Таблица | PK / уникальность | Связи | Назначение |
|---|---|---|---|
| `prod_nodes` | `id` PK | `ref_id → products.id` только для `kind='product'` (soft); `catalog_id → product_catalogs.id` и `unit_id → units.id` — программно, без FK | Узел карты: сырьё (`product`), состояние/заготовка (`state`), готовое блюдо (`output`). `archived` вместо удаления |
| `prod_ops` | `id` PK | `output_node_id → prod_nodes.id` (soft) | Операция/техкарта: состав, `plan_qty`, `plan_unit_id`, `labor_hours`. `yield_pct` хранится, но в расчёте не участвует |
| `prod_op_inputs` | `id` PK; `(op_id, node_id)` UK | `op_id → prod_ops.id` (soft); `node_id → prod_nodes.id` (soft) | Вход операции: количество, `in_mass`, потери `loss_pct` |
| `prod_packagings` | `id` PK; `(node_id)` UK там, где `is_default and not archived` | `node_id → prod_nodes.id` (soft) | Продаваемая фасовка: `qty_base`, `min_order`, `price`, `price_basis`, `cost`, `available`, `archived` |
| `prod_packaging_tare` | `(packaging_id, product_id)` PK | оба FK: `prod_packagings.id`, `products.id` cascade | Тара фасовки: несколько складских позиций на упаковку |
| `map_batches` | `id` PK | — | История выпусков. Хранит **имена** `op_name`/`output_name`, а не `op_id`/`node_id` |
| `map_batch_items` | `id` PK | `batch_id → map_batches.id` (soft), `product_id → products.id` (soft) | Снимок списанного сырья и его цены |
| `map_meta` | `id` PK (всегда 1) | — | `version` — оптимистичная блокировка карты |
| Старая модель | — | — | `tech_cards`, `tech_card_items`, `semi_products`, `semi_inputs`, `product_packagings`, `production_batches` и `production_batch_items` удалены. История выпусков — только `map_batches` |

Ключевые нюансы:

- Узлы карты не имеют FK на `products`: `prod_nodes.ref_id` — просто число, смысл зависит от `kind`. Аналогично `prod_op_inputs.node_id` может указывать на сырьё, состояние или блюдо.
- `prod_packagings` — отдельное id-пространство. В заказах, отчётах, `links` Google-листов и ручных связях лежит именно `prod_packagings.id`, не `products.id`.
- Legacy-таблицы и их колонки (`legacy_id`, `legacy_kind`, `legacy_source`, `legacy_packaging_id`) удалены; миграция на карту выполнена и больше не нужна.
- `map_batches` не хранит `op_id` и `output_node_id`. После переименования операции/блюда связать историю выпуска с текущим узлом можно только по имени — это не ключ.
- `map_meta.version` увеличивается при сохранении карты; клиент присылает версию и получает 409, если карту уже изменили (`production-map.ts:440-470`).

### 3.4 Заказы, доставка, отчёты

Диаграмма: [schema-orders.mmd](schema-orders.mmd)

| Таблица | PK / уникальность | Связи | Назначение |
|---|---|---|---|
| `delivery_schedule` | `delivery_date` PK | `created_by → users.id` FK SET NULL | Только **ручные** даты доставки |
| `delivery_schedule_period` | `(kind, value)` PK | — | Повторяющееся правило: день недели или число месяца; даты не материализуются |
| `store_orders` | `id` PK; `(store_id, delivery_date)` UK; `(doc_year, doc_no)` UK (если `doc_no` не null) | `store_id → stores.id` FK; `created_by/updated_by → users.id` FK SET NULL | Заказ точки на дату. `doc_year` + `doc_no` — порядковый номер Otpremnica внутри года; `line_order int[]` — ручной порядок строк |
| `store_order_items` | `(order_id, packaging_id)` PK | `order_id → store_orders.id` FK cascade; `packaging_id → prod_packagings.id` FK | Строка заказа: целые упаковки 1…999 + слепки `price_snapshot`, `cost_snapshot`, `basis_snapshot`, названий, `qty_base_snapshot`, `dimension_snapshot` |
| `store_delivery_writeoffs` | `id` PK; `(delivery_date, coalesce(store_id,0))` UK | `store_id → stores.id` FK cascade | Факт ручного списания сырья по доставке; `store_id = null` — все магазины даты |
| `doc_counters` | `doc_year` PK | — | Последний выданный номер внутри года; в новом году начинается с 1 |

Ключевые нюансы:

- Заказ и позиции — единственное место, где `prod_packagings.id` используется как внешний ключ в заказах.
- Слепки в `store_order_items` — не отдельная таблица, а 9 nullable-колонок. Отчёт читает `coalesce(snapshot, live)`; для прошедших дат все 14 173 строки в локальной копии уже имеют `price_snapshot`.
- `doc_no` не является частью PK; печатный номер — `doc_year-doc_no`, у старых заказов без номера — `YYYY-orderId` (`order-report.ts`). Счётчик `doc_counters` сбрасывается в новом году.
- `line_order` — массив **id фасовок**, не позиций. SQL-порядок отчёта: `store code → line_order → каталог`; затем, если для даты есть лист Google, строки пересортировываются по позиции в листе, а отсутствующие в листе уходят в конец (`order-report.ts:264-275`).
- `delivery_schedule` и `delivery_schedule_period` не связаны FK: календарь — это объединение ручных дат и правила на 120 дней вперёд.

### 3.5 Служебные данные

| Таблица | PK | Связи | Назначение |
|---|---|---|---|
| `app_migrations` | `name` PK | — | Одноразовые маркеры: `rawcat_position_v1`, `packaging_tare_multi_v1` |
| `audit_log` | `id` | `user_id → users.id` FK SET NULL | `action`, `entity`, `entity_id` (text), `title`, `details jsonb` |
| `app_settings` | `key` | — | `currency`, `delivery.cutoffHours`, `gpt` (прокси) |
| `qoder_dialogs` | `id` | `user_id → users.id` FK cascade | Диалог принадлежит пользователю |
| `qoder_messages` | `id` | `dialog_id → qoder_dialogs.id` FK cascade | Роль `user` / `assistant`, содержимое |

`audit_log.entity_id` — текст, потому что одна и та же колонка хранит id продукта, накладной, заказа, партии и т. п. Ссылочной целостности нет; это журнал, а не реляционная связь.

### 3.6 База листов Google

Диаграмма: [schema-sheets.mmd](schema-sheets.mmd)

| Таблица | PK / уникальность | Связи | Назначение |
|---|---|---|---|
| `google_sheets` | `spreadsheet_id` PK | — | Один документ: `title`, `url`, `synced_at`, `unmatched jsonb` |
| `google_sheet_tabs` | `(spreadsheet_id, position)` PK | `spreadsheet_id → google_sheets` FK cascade | Лист: `name` (`DD.MM`), `width`, `rows jsonb` (строки как в Google), `links jsonb` (id фасовки на каждую строку) |
| `google_sheet_manual_links` | `(spreadsheet_id, tab_name, row_name)` PK | — | Ручное решение: нормализованное название строки → `packaging_id`; `null` — «не сопоставлять» |

Ключевые нюансы:

- `rows` и `links` — параллельные массивы: `links[i]` относится к `rows[i]`. `links` хранит **только автоподбор**; ручные решения применяются поверх при каждом чтении (`google-sheet.ts:356-420, 517-545`).
- Ключ ручной связи — нормализованное **название строки**, а не номер строки. Поэтому связь переживает повторную синхронизацию и сдвиг строк.
- `links` хранят только id `prod_packagings`; отдельной версии формата больше нет.
- Между базами нет FK: `links[]` и `google_sheet_manual_links.packaging_id` — просто числа. Удаление/архивация фасовки не ломает строку, но id может перестать находиться.

## 4. Пространства идентификаторов

| ID | Владелец | Где используется | Тип связи |
|---|---|---|---|
| `products.id` | `mixmarkt_crm.products` | `stock`, `movements`, `product_aliases`, `waybill_items`, `prod_nodes.ref_id`, `prod_packaging_tare`, `map_batch_items` | FK, кроме `prod_nodes.ref_id` и `map_batch_items` |
| `prod_nodes.id` | `prod_nodes` | `prod_ops.output_node_id`, `prod_op_inputs.node_id`, `prod_packagings.node_id`, `prod_packaging_tare` через фасовку | FK только у `prod_packaging_tare.packaging_id`; остальные — программно |
| `prod_ops.id` | `prod_ops` | `prod_op_inputs.op_id`; имя операции в `map_batches.op_name` | `prod_op_inputs` — программно; история — по имени |
| `prod_packagings.id` | `prod_packagings` | `store_order_items.packaging_id`, `prod_packaging_tare.packaging_id`, `google_sheet_tabs.links[]`, `google_sheet_manual_links.packaging_id` | FK в заказах и таре; в базе листов — без FK |
| `store_orders.id` | `store_orders` | `store_order_items.order_id` | FK cascade |
| `(order_id, packaging_id)` | `store_order_items` | — | Составной PK; одна фасовка в заказе один раз |
| `waybills.id` | `waybills` | `waybill_items.waybill_id`; `movements.doc_id` при `doc_type='waybill'` | FK; журнал — программно |
| `map_batches.id` | `map_batches` | `map_batch_items.batch_id`; `movements.doc_id` при `doc_type='map_batch'` | Программно |
| `store_delivery_writeoffs.id` | `store_delivery_writeoffs` | `movements.doc_id` при `doc_type='store_delivery'` | Программно |
| `stores.id` | `stores` | `users.store_id`, `store_orders.store_id`, `store_delivery_writeoffs.store_id` | FK |
| `users.id` | `users` | `sessions`, `audit_log`, `movements`, `qoder_dialogs`, created/updated | FK, кроме `store_delivery_writeoffs.created_by` |
| `suppliers.id` | `suppliers` | `supplier_invoices.supplier_id` | FK |
| `spreadsheet_id` | `mixmarkt_sheets` | `google_sheets`, `google_sheet_tabs`, `google_sheet_manual_links` | FK только между таблицами листов |
| `(tab_name, row_name)` | `google_sheet_manual_links` | — | Текстовый ключ; `row_name` — нормализованное название |
| `(doc_year, doc_no)` | `store_orders` | Печатный номер `doc_year-doc_no` | Уникальный индекс, не PK |
| `token_hash` | `sessions` | cookie `mix_session` | PK, sha256 |

## 5. Как записи сопоставляются

### 5.1 Строка накладной → товар склада

Порядок в `POST /api/import/parse` (`import.ts:565-647`):

1. **Точное нормализованное имя.** `normName`: нижний регистр, `ё → е`, всё не-буквенное в пробел (`import.ts:28-31`); то же для псевдонимов (`products.ts:42-45`). Сначала ищется в `products`, затем в `product_aliases`.
2. **Товароведческий словарь.** `matchByMeaning` (`product-lexicon.ts:300-327`) ищет точное имя, псевдоним, затем запись словаря. Словарь знает сербские/немецкие/английские названия и даёт либо существующий `product`, либо подсказку `newName + category + store`. Совпадение по основе допустимо только для длинных слов; более длинная фраза важнее. Готовые блюда («салат», «сырники») намеренно не сводятся к ингредиенту.
3. **Ответ ИИ** принимается, только если словарь не знает строку (`!lex`) и `productId` существует. Иначе словарь важнее модели.
4. **Кандидаты для выбора человеком.** `pg_trgm similarity > 0.30`, по имени и псевдониму, топ-4; кандидаты ИИ добавляются, только если trigram ничего не дал (`import.ts:380-395, 576-585`).
5. **Подтверждение.** `confirmImport` создаёт товар только в базовой единице и сразу строку `stock`; запоминает `product_aliases` для написания из документа. Конфликт псевдонима не перепривязывается молча (`import.ts:2040-2089`).
6. **Единицы.** `DOC_UNITS` переводит кг/л/десятки в базовые; кросс-размерность (мл → г) возможна только через коэффициенты товара, иначе строка получает предупреждение и 400 при проведении (`import.ts:60-100, 300-345`; `waybills.ts:105-147`).

### 5.2 Поставщик в накладной

`supplier-match.ts:99-154`:

1. Собственное производство исключается всегда: PIB `114917301`, MB `22090208`, название `MIX MARKT GASTRO` / `MIX markt Gastro` (`supplier-match.ts:80-93`).
2. Поиск по **PIB** (8–9 цифр) — самый сильный признак; PIB получателя (наш) игнорируется.
3. **GLN** — ровно 13 цифр.
4. **Банковский счёт** — только цифры, обычно 18 знаков.
5. **Название** из ответа модели или транскрипции; юридические формы `DOO/D.O.O./LLC/LTD` не различают.
6. Если не найден — автосоздание: `suppliers.code` — транслитерированный slug имени, дубли проверяются по имени/PIB, поля `pib/mb/gln/address/accounts` берутся из накладной, `note = «Добавлен автоматически…»` (`supplier-match.ts:261-332`).
7. В счёт поставщика номер уникален в паре `(supplier_id, number)`; накладная — по `btrim(number)` среди неотменённых.

### 5.3 Строка Google-листа → фасовка

`google-sheet.ts:279-354`:

- Загружаются только неархивные `prod_packagings` и `prod_nodes`.
- Строятся ключи:
  - `exactSale`: `normName(техкарта + фасовка)`, собственное `title`, `title_sr`, а также имя техкарты, если оно уже содержит размер фасовки;
  - `exactCard`: имя техкарты без фасовки; при равных вариантах приоритет — фасовка того же веса (`rank=2`), затем `is_default` (`rank=1`);
  - `byBase`: группа фасовок по имени техкарты без граммовки и скобок.
- Автоподбор: точное полное имя → имя техкарты → группа по базовому имени. В группе: единственная фасовка; иначе совпадение по весу/размерности; иначе единственная `is_default`; иначе `null`.
- Ручное решение `google_sheet_manual_links` перекрывает автоподбор; `null` означает «не сопоставлять». Ключ — нормализованное название строки, поэтому связь устойчива к пересортировке.
- `summaryStart` отсекает строки после «общее количество»; `itemName` отличает позицию от заголовка/итога (`google-sheet.ts:199-234`).
- `links` всегда содержат id `prod_packagings`; старый формат с id техкарт удалён.

### 5.4 Лист Google → заказы магазинов

`order-history.ts`:

1. **Дата доставки.** Имя листа `DD.MM` + в первой строке `Доставка DD.MM.YYYY`; иначе лист пропускается. Листы «копия» и дубли даты пропускаются (`order-history.ts:25-50, 120-129`).
2. **Магазины.** Заголовок ищется по `Min Заказ`; колонки справа подписаны `103` или `Mix 38103` и сопоставляются с `stores.id` / `stores.code` (`order-history.ts:52-78`).
3. **Позиции.** Строки до «общее количество»; `links[row]` даёт `prod_packagings.id`; количество из клетки округляется **вверх** до 1…999; повторы по одному магазину/фасовке суммируются (`order-history.ts:80-180`).
4. **Запись.** Upsert по `(store_id, delivery_date)`, старые позиции удаляются и вставляются заново; будущим заказам выдаются номера `ensureFutureDocNumbers` по дате/коду магазина (`order-history.ts:166-190`).

### 5.5 Legacy → карта производства

Миграция выполнена и удалена вместе со старой моделью. `tech_cards`, `semi_products`, `product_packagings` и их дочерние таблицы больше не существуют; `legacy-map-import`, `sheets-remap`, `migrate:map` и проверка `requireMapMigrated` удалены из кода.

### 5.6 Документ → движение → остаток

`movements` — единый журнал; таблицы-документы связаны через `doc_type`/`doc_id`:

| `doc_type` | `doc_id` указывает на | Кто пишет | Смысл |
|---|---|---|---|
| `waybill` | `waybills.id` | `ingestWaybill`, `reverseWaybill` | Приход или сторно прихода |
| `map_batch` | `map_batches.id` | `produceMapBatch`, `reverseMapBatch` | Списание сырья на выпуск / возврат |
| `store_delivery` | `store_delivery_writeoffs.id` | `postDeliveryWriteoff` | Списание сырья по доставке магазинам |
| `manual` | нет | `stock/adjustments` | Ручная корректировка |
| `map_ship` | нет (`doc_id` пустой) | `shipMapOutput` | Отгрузка готового без отдельного документа |

`applyMovement` блокирует строку `stock` `FOR UPDATE`, проверяет отрицательный остаток, обновляет `qty`, при приходе с `unitCost` пересчитывает `avg_cost`, затем пишет `movements` (`stock.ts:25-74`). `stock` — материализованный кэш журнала; пересчёт возможен по `movements`, но не все данные обязаны иметь входящее движение (в локальной копии 21 строка склада и всего 4 корректировки).

### 5.7 Пользователь → роль → точка

- Cookie `mix_session` содержит случайный токен; в `sessions` только `sha256(token)`; сессия живёт, пока `expires_at > now()` и `users.active` (`auth.ts:89-125`).
- `users.store_id = null` — офис; `is_admin` — администратор; `store_id != null` — магазинный пользователь.
- `requireAuth` на всём `/api`, кроме `/api/auth` и `/api/health`; `requireOffice` блокирует магазин, `requireStore` — офис, `requireAdmin` — настройки (`app.ts:41-75`, `auth.ts:147-187`).
- `storeId` для магазинных операций всегда берётся из сессии, никогда из query/body (`store.ts:32-41, 130-178, 184-263`).

### 5.8 Заказ → Otpremnica

- `ensureDeliveryDocNumbers` нумерует заказы даты в порядке печати (код магазина, id) (`order-numbering.ts:45-60`).
- `freezeOrderSnapshots` фиксирует цены/названия/единицы строк, у которых дата доставки уже наступила (`order-price-snapshot.ts:11-53`).
- Отчёт соединяет `store_orders → store_order_items → prod_packagings → prod_nodes → units`, берёт `coalesce(snapshot, live)`, считает количество по `price_basis`, PDV и вес. Базовый SQL-порядок — `line_order`, затем каталог; если у даты есть лист Google, порядок строк перезаписывается позицией в листе (`order-report.ts:166-278`).
- Магазинный отчёт вызывает тот же `orderReport` без режима `cost`, поэтому `cost` в ответ не попадает (`store.ts:166-178`).

### 5.9 Аудит и чат

- Аудит пишется либо `audit()` вне транзакции, либо `auditTx()` внутри — тогда запись откатывается вместе с операцией (`audit.ts:75-90`). `details` — произвольный JSON diff.
- `qoder_dialogs.user_id` гарантирует, что чужой диалог не читается; `qoder_messages.dialog_id` каскадно удаляется вместе с диалогом.

## 6. Целостность: где FK, а где только программа

| Связь | FK в БД | Фактическое обеспечение |
|---|---|---|
| `products.unit_id → units.id` | Да | БД |
| `stock.product_id → products.id` | Да, cascade | БД |
| `movements.product_id/user_id` | Да | БД |
| `product_aliases.product_id` | Да, cascade | БД |
| `waybill_items.waybill_id/product_id/unit_id` | Да | БД |
| `supplier_invoices.supplier_id`, `supplier_invoice_items.invoice_id` | Да | БД |
| `prod_packaging_tare.packaging_id/product_id` | Да, cascade | БД |
| `store_orders.store_id/created_by/updated_by` | Да | БД |
| `store_order_items.order_id/packaging_id` | Да | БД (после миграции) |
| `store_delivery_writeoffs.store_id` | Да | БД |
| `users.store_id`, `sessions.user_id`, `audit_log.user_id` | Да | БД |
| `prod_nodes.ref_id → products.id` | **Нет** | Только `kind='product'` и сервисы |
| `prod_nodes.catalog_id → product_catalogs.id`, `prod_nodes.unit_id → units.id` | **Нет** | `resolveRefs`/`saveMap` при сохранении карты |
| `prod_ops.output_node_id → prod_nodes.id` | **Нет** | `validateShape` при сохранении карты |
| `prod_op_inputs.op_id/node_id` | **Нет** | `validateShape`, `saveMap` |
| `prod_packagings.node_id → prod_nodes.id` | **Нет** | `saveMap`, архивация вместо удаления |
| `map_batch_items.batch_id/product_id` | **Нет** | `produceMapBatch` |
| `movements.doc_type + doc_id` | **Нет** | `applyMovement` и вызывающие сервисы |
| `audit_log.entity + entity_id` | **Нет** | `audit/auditTx` |
| `google_sheet_tabs.links[]` → `prod_packagings.id` | **Нет** (другая БД) | `loadMatchers` и проверка при чтении |
| `google_sheet_manual_links.packaging_id` | **Нет** (другая БД) | `setSheetRowLink` проверяет только наличие при записи |
| `products.category_id → product_categories.id` | **Да** | БД; удаление категории сначала переназначает продукты на `прочее` |
| `map_batches → prod_ops / prod_nodes` | **Нет** | В таблице только имена, id не хранится |

## 7. Канонические способы собрать данные

**Полный склад (с пустыми позициями):**

```sql
select p.id, p.name, coalesce(s.qty, 0) as qty, coalesce(s.avg_cost, 0) as avg_cost
  from products p
  left join stock s on s.product_id = p.id
 where p.active
 order by p.category, p.name;
```

Текущий API склада использует `join stock`, поэтому позиции без строки `stock` в ответ не попадают (`routes/stock.ts:13-22`).

**Движение с документом-источником:**

```sql
select m.*,
       case m.doc_type
         when 'waybill' then w.number
         when 'map_batch' then b.output_name
         when 'store_delivery' then d.delivery_date::text
         when 'manual' then 'ручная корректировка'
         when 'map_ship' then 'отгрузка карты'
       end as doc_label
  from movements m
  left join waybills w on m.doc_type = 'waybill' and w.id = m.doc_id
  left join map_batches b on m.doc_type = 'map_batch' and b.id = m.doc_id
  left join store_delivery_writeoffs d on m.doc_type = 'store_delivery' and d.id = m.doc_id
 order by m.id desc;
```

**Строка отчёта Otpremnica:**

```sql
select o.id as order_id, o.doc_year, o.doc_no, i.packaging_id, n.name, pk.qty_base,
       i.qty, coalesce(i.price_snapshot, pk.price) as price,
       coalesce(i.qty_base_snapshot, pk.qty_base) as qty_base,
       coalesce(i.basis_snapshot, pk.price_basis) as basis
  from store_orders o
  join store_order_items i on i.order_id = o.id
  join prod_packagings pk on pk.id = i.packaging_id
  join prod_nodes n on n.id = pk.node_id
 where o.delivery_date = $1::date
 order by o.store_id,
          coalesce(array_position(o.line_order, i.packaging_id), 2147483647);
```

**Связи листов Google с фасовками (две базы, без SQL-join):**

```sql
-- 1. mixmarkt_sheets: получить links и названия строк
select name, rows, links from google_sheet_tabs where spreadsheet_id = $1 order by position;

-- 2. mixmarkt_crm: найти фасовки по собранным id
select pk.id, pk.node_id, n.name, pk.qty_base, pk.price
  from prod_packagings pk
  join prod_nodes n on n.id = pk.node_id
 where pk.id = any($2::int[]);
```

**Состав операции карты:**

```sql
select o.id as op_id, o.name as operation, o.plan_qty, o.plan_unit_id,
       i.node_id, n.name as input_name, n.kind, i.qty, i.loss_pct, i.in_mass
  from prod_ops o
  join prod_op_inputs i on i.op_id = o.id
  join prod_nodes n on n.id = i.node_id
 order by o.id, i.id;
```

## 8. Что остаётся неопределённым

Это не выводы ревью, а границы текущей модели, которые нужно проверять перед изменениями:

- **Формат ссылок листов.** `links` и `google_sheet_manual_links.packaging_id` теперь всегда означают `prod_packagings.id`; `links_version` и `card_id` удалены.
- **Разреженный `stock`.** 97 из 118 продуктов не имеют строки; это не ошибка чтения схемы, но означает, что `stock` нельзя считать полным списком номенклатуры. `applyMovement` создаёт строку лениво.
- **Карта без FK.** `prod_nodes.ref_id`, `prod_ops.output_node_id`, `prod_op_inputs.*`, `prod_packagings.node_id` проверяются только сервисами сохранения. Прямая SQL-правка может создать висячие ссылки.
- **История выпусков по имени.** `map_batches.op_name`/`output_name` не позволяют надёжно соединить старый выпуск с текущей операцией после переименования.
- **`map_ship` без документа.** У движения отгрузки карты `doc_id` пустой; отдельной таблицы отгрузок нет, поэтому «что именно отгрузили» восстанавливается только по `comment` и `map_ship`-движениям.
- **Накладная ↔ поставщик.** Связь в `waybills.supplier` текстовая; канонический `suppliers.id` в шапке накладной не хранится.
- **Файлы накладных.** `file_data` (bytea) и `extra_files` (base64 в jsonb) могут дублировать диск; жёсткой проверки «ровно одно хранилище» нет.
- **Категория сырья.** `products.category_id` — обязательный FK на `product_categories.id`; текстовой колонки `products.category` больше нет. Имя категории хранится только в справочнике.
- **`yield_pct`.** Поле есть в `prod_ops`, но расчёт использует `loss_pct` на связях; это структура без поведения в текущей формуле.

## 9. Порядок чтения артефактов

1. [schema-core.mmd](schema-core.mmd) — справочники, склад, роли.
2. [schema-production.mmd](schema-production.mmd) — производственная карта.
3. [schema-orders.mmd](schema-orders.mmd) — заказы, номера, слепки.
4. [schema-sheets.mmd](schema-sheets.mmd) — отдельная база листов и кросс-БД ссылки.
5. [system-context.dot](system-context.dot) — кто с кем говорит.
6. [system-model.dot](system-model.dot) — потоки данных между доменами.
7. [key-mapping.dot](key-mapping.dot) — плотная карта id-пространств.
8. [system-model.evidence.md](system-model.evidence.md) — ссылки на код для каждого утверждения.