import * as path from 'path';
import * as dotenv from 'dotenv';

// .env лежит в корне сервера (рядом с src/)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // интерфейс прослушивания: за nginx на сервере — 127.0.0.1, для доступа по LAN — 0.0.0.0 (по умолчанию)
  host: process.env.HOST ?? '0.0.0.0',
  allowNegativeStock: (process.env.ALLOW_NEGATIVE_STOCK ?? 'false') === 'true',
  sqlDir: path.resolve(__dirname, '..', 'sql'),
  // GPT-парсинг входящих накладных (ключ только на сервере!)
  openaiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  uploadsDir: path.resolve(__dirname, '..', 'uploads', 'waybills'),
  // прод-режим: сервер раздаёт собранный Angular-клиент (client/dist/crm/browser)
  clientDir: process.env.CLIENT_DIR ?? path.resolve(__dirname, '..', '..', 'client', 'dist', 'crm', 'browser'),
  // Google Таблица заказов магазинов (общедоступная; id из ссылки /spreadsheets/d/<id>).
  // '||' вместо '??': пустая строка в .env не должна перемывать боевой id.
  gsheetId: process.env.GSHEET_ORDERS_ID || '1tmtmBRcpDDRM5KaONo5wXo51RFcbm92nQ9GibFlHAzA',
  gsheetSyncMin: Number(process.env.GSHEET_SYNC_MIN ?? 10), // период синхронизации, мин
  gsheetRecentTabs: Number(process.env.GSHEET_RECENT_TABS ?? 10), // сколько свежих листов правим каждый цикл
  // уведомления об изменениях таблицы: вебхук Apps Script и страховочный вотчер листа
  sheetHookToken: process.env.GSHEET_HOOK_TOKEN ?? '', // пусто — вебхук выключен (503)
  sheetWatchSec: Number(process.env.GSHEET_WATCH_SEC ?? 5), // 0 — вотчер выключен
  // URL веб-приложения Apps Script, привязанного к ПРОД-таблице: кнопка «Прод → тест»
  // копированием листов прод-таблицы в тестовую (id теста — в CFG.TEST_SPREADSHEET_ID)
  sheetCopyUrl: process.env.GSHEET_COPY_WEBAPP_URL ?? '', // пусто — кнопка не показывается
  // обратная запись заказов из БД в прод-таблицу (Apps Script Web App, action='write_orders')
  sheetWriteUrl: process.env.GSHEET_WRITE_WEBAPP_URL ?? '', // пусто — запись выключена
  // главный рубильник выталкивания БД→таблица: по умолчанию ВЫКЛ (прод остаётся только читаемым)
  sheetWriteEnabled: (process.env.GSHEET_WRITE_ENABLED ?? 'false') === 'true',
  // точки, которым разрешена запись в таблицу, через запятую ('103,104'); пусто = все активные
  sheetWriteStores: (process.env.GSHEET_WRITE_STORES ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),
  // вход в CRM: срок сессии и первый администратор (создаётся, только пока таблица users пуста)
  sessionDays: Number(process.env.AUTH_SESSION_DAYS ?? 7),
  authAdminLogin: process.env.AUTH_ADMIN_LOGIN ?? 'admin',
  authAdminPassword: process.env.AUTH_ADMIN_PASSWORD ?? '',
};
