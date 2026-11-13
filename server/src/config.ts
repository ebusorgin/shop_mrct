import * as path from 'path';
import * as dotenv from 'dotenv';

// .env лежит в корне сервера (рядом с src/)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // интерфейс прослушивания: за nginx на сервере — 127.0.0.1, для доступа по LAN — 0.0.0.0 (по умолчанию)
  host: process.env.HOST ?? '0.0.0.0',
  allowNegativeStock: (process.env.ALLOW_NEGATIVE_STOCK ?? 'false') === 'true',
  sqlFile: path.resolve(__dirname, '..', 'sql', 'init.sql'),
  // GPT-парсинг входящих накладных (ключ только на сервере!)
  openaiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  uploadsDir: path.resolve(__dirname, '..', 'uploads', 'waybills'),
  // ключ сервисного аккаунта Google для чтения таблицы «Микс Маркт Гастро»
  googleCredentials: path.resolve(__dirname, '..', 'credentials.json'),
  // отдельная база для скачанных листов Google-таблицы (не смешивается с данными CRM)
  sheetsDatabase: process.env.PG_SHEETS_DATABASE ?? 'mixmarkt_sheets',
  sheetsSqlFile: path.resolve(__dirname, '..', 'sql', 'sheets-init.sql'),
  // прод-режим: сервер раздаёт собранный Angular-клиент (client/dist/crm/browser)
  clientDir: process.env.CLIENT_DIR ?? path.resolve(__dirname, '..', '..', 'client', 'dist', 'crm', 'browser'),
  // вход в CRM: срок сессии и первый администратор (создаётся, только пока таблица users пуста)
  sessionDays: Number(process.env.AUTH_SESSION_DAYS ?? 7),
  authAdminLogin: process.env.AUTH_ADMIN_LOGIN ?? 'admin',
  authAdminPassword: process.env.AUTH_ADMIN_PASSWORD ?? '',
};
