/**
 * ============================================================================
 *  Обратная запись заказов из CRM в ПРОД-таблицу
 * ============================================================================
 *
 *  ЗАЧЕМ
 *  CRM хранит заказы (источник истины — БД). Когда магазин оформляет/меняет заказ
 *  в интерфейсе, сервер просит этот скрипт записать количество в нужную ячейку
 *  прод-таблицы (колонка его точки, строка товара). Модель «БД приоритетнее»:
 *  значение из БД вытесняет то, что стоит в таблице.
 *
 *  СТАНОВИТСЯ В APPS SCRIPT ПРОД-ТАБЛИЦЫ (Extensions → Apps Script). Может лежать
 *  в одном проекте с sheet-hook.gs / copy-prod-to-test.gs (все привязаны к проду).
 *
 *  DEPLOY (Web app)
 *  Deploy → New deployment → Type: Web app:
 *    • Execute as: Me  (только тогда есть право писать в прод);
 *    • Who has access: Anyone (защищено токеном — без него скрипт отказывает);
 *  Скопировать URL (.../exec) в server/.env:
 *    GSHEET_WRITE_WEBAPP_URL=https://script.google.com/macros/s/…/exec
 *    GSHEET_WRITE_ENABLED=true
 *    GSHEET_WRITE_STORES=103      (раскатка точечно; пусто = все точки)
 *
 *  ПРОТОКОЛ (сервер -> скрипт), POST application/json:
 *    { action: 'write_orders', token: '<GSHEET_HOOK_TOKEN>', tab: '04.11',
 *      ops: [ { tab, storeId, storeCode, name, plu, unit, value, base } ] }
 *  value — печатное число для ячейки; null — очистить (отменённый заказ).
 *  ОТВЕТ: { ok, applied: [{ storeId, name, ok }], error? }
 *
 *  РАЗМЕЩЕНИЕ ЯЧЕЙКИ (полностью на живом листе, как видит его человек):
 *   • колонка точки — заголовок-токен «Mix 381NN» / «NN» / «NN+», предпочитаем не-plus;
 *   • строка товара — поиск в колонке «Наименование» по нормализованному имени;
 *   • нет строки и разрешено дописывать — вставляем новую строку в конец данных блока,
 *     заполняя «Наименование / PLU / Ед-ца» и количество точки.
 * ============================================================================
 */

var WRITE_CFG = {
  // тот же секрет, что GSHEET_HOOK_TOKEN в server/.env
  TOKEN: '',
};

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action !== 'write_orders') return json_({ ok: false, error: 'неизвестное действие: ' + body.action });
    if (!WRITE_CFG.TOKEN || body.token !== WRITE_CFG.TOKEN) return json_({ ok: false, error: 'неверный токен' });
    var ops = body.ops || [];
    if (!ops.length) return json_({ ok: true, applied: [] });

    var lock = LockService.getScriptLock();
    lock.waitLock(60000); // .people правят таблицу руками — не мешаем друг другу
    var applied = [];
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheetCache = {};
      ops.forEach(function (op) {
        var res = { storeId: op.storeId, name: op.name, ok: false };
        try {
          var sh = sheetCache[op.tab] || ss.getSheetByName(op.tab);
          if (!sh) { res.error = 'лист не найден: ' + op.tab; applied.push(res); return; }
          sheetCache[op.tab] = sh;
          res.ok = writeOneOp(sh, op);
          if (!res.ok) res.error = 'не удалось разместить ячейку';
        } catch (err) {
          res.error = String(err);
        }
        applied.push(res);
      });
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    var failed = applied.filter(function (a) { return !a.ok; });
    return json_({ ok: failed.length === 0, applied: applied, error: failed.length ? (failed[0].error || 'часть op не применилась') : undefined });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Одна запись: найти колонку точки и строку товара, поставить/очистить значение. */
function writeOneOp(sh, op) {
  var values = sh.getDataRange().getValues();
  var layout = detectLayout(values, op.storeId);
  if (!layout || layout.col < 0) return false;

  var nameCol = layout.nameCol;
  var rowIndex = nameCol >= 0 ? findProductRow(values, nameCol, op.name) : -1;

  // товара нет в листе — дописываем новую строку (в конце данных, до служебного хвоста)
  if (rowIndex < 0) {
    rowIndex = appendProductRow(values, layout, op);
    if (rowIndex < 0) return false;
    // пересвеживаем колонку, если вставка сдвинула индексы (вставляем в конец — сдвигов нет)
  }

  var cell = sh.getRange(rowIndex + 1, layout.col + 1); // 1-based
  if (op.value === null || op.value === undefined) {
    cell.clearContent();
  } else {
    cell.setValue(Number(op.value));
  }
  return true;
}

/**
 * Поиск шапки и колонок: колонка «Наименование», колонка точки storeId,
 * колонки PLU / Ед-ца (для дописывания строк). Индексы 0-based.
 */
function detectLayout(values, storeId) {
  var out = { headerRow: -1, col: -1, plusCol: -1, nameCol: -1, pluCol: -1, unitCol: -1, lastData: 0 };
  for (var r = 0; r < Math.min(values.length, 12); r++) {
    var row = values[r];
    for (var c = 0; c < row.length; c++) {
      var t = storeToken(String(row[c] || ''));
      if (t && t.store === storeId) {
        out.headerRow = r;
        if (t.plus) { if (out.plusCol < 0) out.plusCol = c; }
        else if (out.col < 0) out.col = c;
      }
    }
    if (out.headerRow >= 0) break;
  }
  if (out.headerRow < 0) return null;
  if (out.col < 0) out.col = out.plusCol; // у точки только plus-колонка — пишем в неё

  // служебные колонки ищем по подписям (в той же строке-шапке)
  var hdr = values[out.headerRow];
  for (var c2 = 0; c2 < hdr.length; c2++) {
    var s = String(hdr[c2] || '').toLowerCase();
    if (out.nameCol < 0 && /наименовани|товар|product|название/.test(s)) out.nameCol = c2;
    if (out.pluCol < 0 && /\bplu\b/.test(s)) out.pluCol = c2;
    if (out.unitCol < 0 && /ед.{0,3}ца|unit/.test(s)) out.unitCol = c2;
  }
  if (out.nameCol < 0) out.nameCol = guessNameCol(values, out.headerRow);
  out.lastData = lastDataRow(values, out.nameCol);
  return out;
}

/** Фолбэк колонки товара: первая колонка слева от шапки, где чаще всего текст (не числа). */
function guessNameCol(values, headerRow) {
  var best = 1, bestText = -1;
  for (var c = 0; c < (values[headerRow] || []).length; c++) {
    var text = 0, total = 0;
    for (var r = headerRow + 1; r < Math.min(values.length, headerRow + 20); r++) {
      var v = values[r][c];
      if (v === '' || v === null || v === undefined) continue;
      total++;
      if (typeof v === 'string') text++;
    }
    if (total >= 3 && text === total && c < 6 && text > bestText) { bestText = text; best = c; }
  }
  return best;
}

/** Последняя «живая» строка данных: до пустого хвоста и до служебного блока «общее количество». */
function lastDataRow(values, nameCol) {
  var last = 0;
  for (var r = 0; r < values.length; r++) {
    var nm = String((values[r] || [])[nameCol] || '');
    if (/общее количество/i.test(nm)) break; // служебный хвост — выше него
    var any = (values[r] || []).some(function (x) { return x !== '' && x !== null && x !== undefined; });
    if (any) last = r;
  }
  return last;
}

/** Индекс 0-based строки, где в колонке товара нормализованное имя совпадает с op.name. */
function findProductRow(values, nameCol, wantName) {
  var want = normName(wantName);
  if (!want) return -1;
  for (var r = 0; r < values.length; r++) {
    if (normName(String((values[r] || [])[nameCol] || '')) === want) return r;
  }
  return -1;
}

/** Дописать новую строку товара в конец данных; вернуть 0-based индекс новой строки. */
function appendProductRow(values, layout, op) {
  var insertAt = layout.lastData + 1; // 0-based строка после последней с данными
  sh_insertRow(op, insertAt);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(op.tab);
  var row = insertAt + 1; // 1-based
  if (layout.nameCol >= 0) sh.getRange(row, layout.nameCol + 1).setValue(op.name);
  if (layout.pluCol >= 0 && op.plu) sh.getRange(row, layout.pluCol + 1).setValue(op.plu);
  if (layout.unitCol >= 0 && op.unit) sh.getRange(row, layout.unitCol + 1).setValue(op.unit);
  // вставка в конец данных не сдвигает существующие строки → индекс точки тот же
  return insertAt;
}

/** Вставить одну строку в лист на позицию insertAt (0-based) с запасом по высоте. */
function sh_insertRow(op, insertAt) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(op.tab);
  var max = sh.getMaxRows();
  if (insertAt >= max) sh.insertRowsAfter(max, insertAt - max + 2);
  sh.insertRowsAfter(insertAt, 1);
}

/** Номер точки из подписи колонки: «Mix 38103»->103, «103»->103, «109+»->109(plus). */
function storeToken(s) {
  var toks = s.replace(/\s+/g, ' ').trim().split(' ');
  for (var i = 0; i < toks.length; i++) {
    var tok = toks[i];
    var t = tok.replace(/\+$/, '');
    if (!t) continue;
    var plus = t.length !== tok.length;
    if (/^38\d{3}$/.test(t)) return { store: Number(t.slice(2)), plus: plus };
    if (/^\d{3}$/.test(t)) {
      var id = Number(t);
      if (id >= 100 && id <= 199) return { store: id, plus: plus };
    }
  }
  return null;
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s\u00A0]+/g, ' ')
    .replace(/^ | $/g, '')
    .trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
