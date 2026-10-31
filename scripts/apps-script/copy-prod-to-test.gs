/**
 * ============================================================================
 *  Копир «ПРОД → ТЕСТ» для Google Таблицы заказов
 * ============================================================================
 *
 *  ЗАЧЕМ
 *  CRM читает заказы из Google Таблицы. Чтобы тестировать на свежих боевых
 *  данных, не трогая прод: этот скрипт по кнопке из CRM (или из меню таблицы)
 *  копирует ВСЕ листы прод-таблицы в вашу тестовую копию. Прод только читаем.
 *
 *  СТАНОВИТСЯ В APPS SCRIPT ПРОД-ТАБЛИЦЫ (Extensions → Apps Script),
 *  рядом с sheet-hook.gs — один проект на прод-таблицу.
 *
 *  НАСТРОЙКА (3 шага)
 *  1. CFG.TEST_SPREADSHEET_ID — id тестовой копии из её ссылки:
 *       https://docs.google.com/spreadsheets/d/<ВОТ_ЭТОТ_ID>/edit
 *  2. CFG.TOKEN — тот же секрет, что GSHEET_HOOK_TOKEN в server/.env.
 *  3. Deploy → New deployment → Type: Web app:
 *       • Execute as: Me (важно: тогда есть доступ на запись в тестовую);
 *       • Who has access: Anyone (защищено токеном — без него копир отказывает);
 *     Скопировать URL веб-приложения (.../exec) и положить в server/.env:
 *       GSHEET_COPY_WEBAPP_URL=https://script.google.com/macros/s/…/exec
 *     После этого на «Синхронизации» в CRM появится кнопка «⬇️ Скопировать прод → тест».
 *
 *  ПРОВЕРКА БЕЗ CRM: в редакторе выполнить copyProdToTest() — меню таблицы
 *  «CRM → Копировать прод → тест» тоже делает это.
 *
 *  ВАЖНО ПРО СТАРЫЕ ДАННЫЕ
 *  Листы-дубли в тестовой перезаписываются целиком (clear + setValues), листы,
 *  которых нет в проде — удаляются, так что тестовая становится точным
 *  зеркалом прод по значениям. Оформление/формулы не копируются (парсеру CRM
 *  нужны значения; формат он и так не читает).
 * ============================================================================
 */

var COPY_CFG = {
  // id тестовой копии таблицы (не менять местами с прод!)
  TEST_SPREADSHEET_ID: '',
  // тот же секрет, что GSHEET_HOOK_TOKEN в server/.env
  TOKEN: '',
};

/**
 * Копирует все листы прод-таблицы (которой привязан этот проект) в тестовую.
 * Возвращает сводку; CRM после успешного ответа сам запускает синхронизацию.
 */
function copyProdToTest() {
  var srcId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var dstId = COPY_CFG.TEST_SPREADSHEET_ID;
  if (!dstId) return { ok: false, error: 'COPY_CFG.TEST_SPREADSHEET_ID не заполнен' };
  if (dstId === srcId) return { ok: false, error: 'тестовый id совпадает с прод — копировать себя в себя нельзя' };

  var src = SpreadsheetApp.getActiveSpreadsheet();
  var dst = SpreadsheetApp.openById(dstId); // исключит AccessException, если «Execute as: Me» не имеет права на запись

  var copied = 0, created = 0, removed = 0;
  var srcNames = {};

  src.getSheets().forEach(function (sh) {
    var name = sh.getName();
    srcNames[name] = true;
    var rng = sh.getDataRange();
    var rows = rng.getNumRows(), cols = rng.getNumColumns();
    if (!rows || !cols) return; // пустой лист — нечего копировать
    var vals = rng.getValues();

    var out = dst.getSheetByName(name);
    if (!out) { out = dst.insertSheet(name); created++; }
    out.clear(); // значения + форматирование; размеры листов оставим как есть
    if (out.getMaxRows() < rows) out.insertRowsAfter(out.getMaxRows(), rows - out.getMaxRows());
    if (out.getMaxColumns() < cols) out.insertColumnsAfter(out.getMaxColumns(), cols - out.getMaxColumns());
    out.getRange(1, 1, rows, cols).setValues(vals);
    copied++;
  });

  // зеркалим: в тестовой не должно остаться листов, которых нет в проде
  dst.getSheets().forEach(function (sh) {
    if (!srcNames[sh.getName()]) { dst.deleteSheet(sh); removed++; }
  });

  var result = {
    ok: true,
    srcId: srcId,
    dstId: dstId,
    tabsCopied: copied,
    tabsCreated: created,
    tabsRemoved: removed,
    at: new Date().toISOString(),
  };
  console.log('[copy-prod-to-test] ' + JSON.stringify(result));
  return result;
}

/** Пункт меню прод-таблицы: «CRM → Копировать прод → тест» (без CRM). */
function copyProdToTestMenu() {
  var res = copyProdToTest();
  var ui = SpreadsheetApp.getUi();
  if (res.ok) {
    ui.alert(
      'Прод → тест готов',
      'Скопировано листов: ' + res.tabsCopied +
      '\nновых создано: ' + res.tabsCreated +
      '\nудалено устаревших: ' + res.tabsRemoved,
      ui.ButtonSet.OK
    );
  } else {
    ui.alert('Копирование не удалось', res.error, ui.ButtonSet.OK);
  }
}

/**
 * Вход для кнопки из CRM: POST { action: 'copy_to_test', token: '…' }.
 * Отвечает JSON. Секрет обязателен: веб-приложение доступно всем по ссылке.
 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action !== 'copy_to_test') {
      return json_({ ok: false, error: 'неизвестное действие: ' + body.action });
    }
    var secret = COPY_CFG.TOKEN;
    if (!secret || body.token !== secret) {
      return json_({ ok: false, error: 'неверный токен' });
    }
    return json_(copyProdToTest());
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
