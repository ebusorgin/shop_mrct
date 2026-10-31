/**
 * Копир данных между Google Таблицами: все листы источника -> таблица назначения.
 *
 * Запуск (из корня проекта, после npm i -D googleapis):
 *   node scripts/copy-gsheet.js --creds path\to\sa.json
 * Опционально:
 *   --src    id таблицы-источника   (по умолчанию ниже)
 *   --dst    id таблицы-приёмника   (по умолчанию ниже)
 *
 * Перед записью одноимённый лист приёмника очищается, поэтому старых хвостов не остаётся;
 * листов-дубликатов (с суффиксами «копия 2») скрипт не плодит.
 *
 * Что нужно подготовить (один раз):
 *  1. console.cloud.google.com -> проект -> API "Google Sheets API" + "Google Drive API" вкл.
 *  2. Service account -> создать ключ JSON -> сохранить как sa.json (вне git!)
 *  3. Обе таблицы расшарить на mail сервиса (xxx@yyy.iam.gserviceaccount.com) —
 *     источнику достаточно "Просмотр", приёмнику "Редактор".
 *
 * Копируются значения (числа/текст/даты как в источнике); форматирование и формулы не переносятся.
 */

const { google } = require('googleapis');

// id берутся из ссылок /spreadsheets/d/<id>/edit
const DEFAULT_SRC = '1YL2CweT4Lxjs3lPkRmfJjdY9VQ95yh7fbRFD-EhXXtE';
const DEFAULT_DST = '1tmtmBRcpDDRM5KaONo5wXo51RFcbm92nQ9GibFlHAzA';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const CREDS = arg('creds', 'sa.json');
const SRC = arg('src', DEFAULT_SRC);
const DST = arg('dst', DEFAULT_DST);

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const srcMeta = (await sheets.spreadsheets.get({ spreadsheetId: SRC })).data;
  const dstMeta = (await sheets.spreadsheets.get({ spreadsheetId: DST })).data;
  console.log(`Источник: "${srcMeta.properties.title}", листов: ${srcMeta.sheets.length}`);
  console.log(`Приёмник: "${dstMeta.properties.title}", листов: ${dstMeta.sheets.length}`);

  const dstTitles = new Set(dstMeta.sheets.map((s) => s.properties.title));

  for (const sh of srcMeta.sheets) {
    const title = sh.properties.title;

    // листы-пустышки в источнике не копируем
    const grid = (await sheets.spreadsheets.values.get({
      spreadsheetId: SRC,
      range: `'${title.replace(/'/g, "''")}'!A1:ZZZZ`,
    })).data.values ?? [];
    if (!grid.length) {
      console.log(`— "${title}": источник пуст, пропускаем`);
      continue;
    }

    // в приёмнике создаём лист с тем же именем, если такого нет
    if (!dstTitles.has(title)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: DST,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      });
      dstTitles.add(title);
      console.log(`+ создан лист "${title}"`);
    } else {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: DST,
        range: `'${title.replace(/'/g, "''")}'`,
      });
    }

    // запись частями по 1000 строк — лимит запроса + прогресс на больших листах
    const CHUNK = 1000;
    const range = `'${title.replace(/'/g, "''")}'`;
    for (let off = 0; off < grid.length; off += CHUNK) {
      const part = grid.slice(off, off + CHUNK);
      await sheets.spreadsheets.values.update({
        spreadsheetId: DST,
        range: `${range}!A${off + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: part },
      });
    }
    const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
    console.log(`✓ "${title}": ${grid.length} строк × ${cols} кол.`);
  }

  console.log('Готово.');
}

main().catch((e) => {
  console.error('Ошибка:', e.response?.data?.error?.message || e.message);
  process.exit(1);
});
