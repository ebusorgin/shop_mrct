import * as path from 'path';
import * as dotenv from 'dotenv';

// .env лежит в корне сервера (рядом с src/)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export const config = {
  port: Number(process.env.PORT ?? 4000),
  allowNegativeStock: (process.env.ALLOW_NEGATIVE_STOCK ?? 'false') === 'true',
  sqlDir: path.resolve(__dirname, '..', 'sql'),
  // GPT-парсинг входящих накладных (ключ только на сервере!)
  openaiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  uploadsDir: path.resolve(__dirname, '..', 'uploads', 'waybills'),
  // прод-режим: сервер раздаёт собранный Angular-клиент (client/dist/crm/browser)
  clientDir: process.env.CLIENT_DIR ?? path.resolve(__dirname, '..', '..', 'client', 'dist', 'crm', 'browser'),
  // Google Таблица заказов магазинов (общедоступная; id из ссылки /spreadsheets/d/<id>)
  gsheetId: process.env.GSHEET_ORDERS_ID ?? '1tmtmBRcpDDRM5KaONo5wXo51RFcbm92nQ9GibFlHAzA',
  gsheetSyncMin: Number(process.env.GSHEET_SYNC_MIN ?? 10), // период синхронизации, мин
  gsheetRecentTabs: Number(process.env.GSHEET_RECENT_TABS ?? 10), // сколько свежих листов правим каждый цикл
  // вход в CRM: срок сессии и первый администратор (создаётся, только пока таблица users пуста)
  sessionDays: Number(process.env.AUTH_SESSION_DAYS ?? 7),
  authAdminLogin: process.env.AUTH_ADMIN_LOGIN ?? 'admin',
  authAdminPassword: process.env.AUTH_ADMIN_PASSWORD ?? '',
};
