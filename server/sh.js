
const { google } = require('googleapis');

// ID Google-таблицы
const SPREADSHEET_ID = '1YL2CweT4Lxjs3lPkRmfJjdY9VQ95yh7fbRFD-EhXXtE';

// Путь к файлу авторизации
const CREDENTIALS_FILE = './credentials.json';

// Извлечение даты из названия вкладки
function parseDate(title) {
    // Формат DD.MM.YYYY
    let match = title.match(/(\d{2})\.(\d{2})\.(\d{4})/);

    if (match) {
        const [, day, month, year] = match;

        return `${year}-${month}-${day}`;
    }

    // Формат YYYY-MM-DD
    match = title.match(/(\d{4})-(\d{2})-(\d{2})/);

    if (match) {
        return match[0];
    }

    return null;
}

async function main() {
    try {
        // Авторизация
        const auth = new google.auth.GoogleAuth({
            keyFile: CREDENTIALS_FILE,
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets.readonly'
            ],
        });

        const client = await auth.getClient();

        const sheets = google.sheets({
            version: 'v4',
            auth: client,
        });

        // Получаем список всех вкладок
        const response = await sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            fields: 'sheets.properties(sheetId,title,index)',
        });

        const tabs = response.data.sheets.map(
            sheet => sheet.properties
        );

        if (!tabs.length) {
            console.log('Вкладки не найдены');
            return;
        }
        console.table(tabs);
        for (const tab of tabs) {
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `'${tab.title.replace(/'/g, "''")}'!B:B`,
            });

            const columnA = result.data.values ?? [];

            console.log(`\nВкладка: ${tab.title}`);

            for (const row of columnA) {
                console.log(row[0] ?? '');
            }

        }
    } catch (error) {
        console.error('Ошибка:', error.message);

        if (error.response?.data) {
            console.error(
                JSON.stringify(error.response.data, null, 2)
            );
        }
    }
}

main();
