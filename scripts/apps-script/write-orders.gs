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
 *
 *  ============================================================================
 *  ДЕЙСТВИЕ 'new_delivery_tab' — следующий лист доставки (обнулённый)
 *  ============================================================================
 *
 *  После автосписания CRM просит завести на дату следующей доставки НОВУЮ вкладку:
 *  копия самого свежего датированного листа (шапка, форматирование, formulas, список
 *  товаров и «Min»-нормы сохраняются), но ВСЕ количество точек в ней обнулены.
 *  Магазины начинают новый цикл заказа на чистом листе, не размечая таблицу руками.
 *
 *  ЗАПРОС, POST application/json:
 *    { action: 'new_delivery_tab', token: '<GSHEET_HOOK_TOKEN>',
 *      name: '05.11',            // обязательное: имя новой вкладки (dd.MM)
 *      from: '04.11',            // необязательное: лист-шаблон; пусто — самый свежий датированный
 *      stores: [103, 104],       // необязательное: какой точки колонки чистить; пусто — все
 *      mode: 'clear' | 'zero',   // по умолчанию 'clear' (пустые ячейки), 'zero' — ставить нули
 *      year: 2026                // необязательное: год даты доставки — для подмены дат в шапке
 *    }
 *  ОТВЕТ: { ok, sheetName, created: bool, template, clearedCells, dataRows,
 *           storeCols: [103..], note?, error? }
 *  Идемпотентно: вкладка с таким именем уже есть -> { ok: true, created: false }
 *  (ничего не удаляем и не перезаписываем — боевые данные бережём; при переданном year
 *  всё равно обновляем даты в служебной строке над шапкой — «Заказ/Доставка дд.мм.гг»).
 *
 *  ДЕЙСТВИЕ 'list_tabs' — { ok, tabs: [{ name, index, hidden }] } для диагностики
 *  (кнопка «Проверить связку» в Настройках CRM).
 *
 *  Там же, где и раньше, скрипт живёт в одном проекте с sheet-hook.gs /
 *  copy-prod-to-test.gs и деплоится тем же Web App — новый код действий
 *  существующий write_orders не затрагивает.
 * ============================================================================
 */

var WRITE_CFG = {
  // тот же секрет, что GSHEET_HOOK_TOKEN в server/.env
  TOKEN: '',
};

/** Единая точка входа: разбор токена и диспетчер по action. */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!WRITE_CFG.TOKEN || body.token !== WRITE_CFG.TOKEN) return json_({ ok: false, error: 'неверный токен' });
    if (body.action === 'write_orders') return handleWriteOrders(body);
    if (body.action === 'new_delivery_tab') return handleNewDeliveryTab(body);
    if (body.action === 'list_tabs') return handleListTabs();
    return json_({ ok: false, error: 'неизвестное действие: ' + body.action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Обратная запись количеств в существующий лист (прежний протокол write_orders). */
function handleWriteOrders(body) {
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
}

/**
 * Новый лист доставки: копия свежего датированного листа с обнулёнными количествами.
 * Ошибку считаем ошибкой только если лист реально не создан; существование — успех.
 */
function handleNewDeliveryTab(body) {
  var name = normTabName(body.name);
  if (!name) return json_({ ok: false, error: 'нужно имя вкладки в виде dd.MM' });

  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var existing = findSheetByName(ss, name);
    if (existing) {
      // лист уже есть — не трогаем данные, но даты в служебной строке над шапкой свежим
      if (body.year) {
        var exVals = existing.getDataRange().getValues();
        rewriteHeaderDates(existing, exVals, allStoreCols(exVals).headerRow, name, Number(body.year));
        SpreadsheetApp.flush();
      }
      return json_({ ok: true, sheetName: name, created: false, note: 'вкладка уже существует' });
    }

    var src = body.from ? findSheetByName(ss, normTabName(body.from)) : latestDatedSheet(ss);
    if (!src) return json_({ ok: false, error: 'не найден лист-шаблон (from пуст или не датированный лист не найден)' });
    if (src.getName() === name) return json_({ ok: false, error: 'шаблон и новая вкладка — один лист' });

    var nsh = src.copyTo(ss); // в конец стека вкладок — CRM считает самым свежим последний датированный
    nsh.setName(name);

    var values = nsh.getDataRange().getValues();
    var cols = allStoreCols(values);
    if (!cols.list.length) {
      ss.deleteSheet(nsh); // шаблон без подписей точек — обнулять нечего, не оставляем мусор
      return json_({ ok: false, error: 'в шаблоне «' + src.getName() + '» не найдено ни одной колонки точки' });
    }

    var want = (body.stores || []).map(Number).filter(function (n) { return n > 0; });
    var list = want.length
      ? cols.list.filter(function (c) { return want.indexOf(c.store) >= 0; })
      : cols.list;
    if (!list.length) {
      ss.deleteSheet(nsh);
      return json_({ ok: false, error: 'указанных точек (' + want.join(',') + ') в шаблоне нет' });
    }

    var layout = detectLayout(values, list[0].store);
    var rowFrom = cols.headerRow + 1;
    var rowTo = layout && layout.lastData > rowFrom ? layout.lastData : lastDataRow(values, layout ? layout.nameCol : -1);
    var nRows = Math.max(0, rowTo - rowFrom + 1);
    var zero = String(body.mode || 'clear') === 'zero';

    if (nRows > 0) {
      list.forEach(function (c) {
        var rng = nsh.getRange(rowFrom + 1, c.col + 1, nRows, 1); // 1-based
        if (zero) rng.setValue(0); else rng.clearContent();
      });
      // «Сумма» — если это напечатанное число (не формула), оно останется устаревшим: чистим
      clearLiteralSums(nsh, values, cols.headerRow, rowFrom, nRows);
    }
    // шаблон несёт даты прошлой доставки («Заказ 02.11.26») — ставим дату нового листа
    if (body.year) rewriteHeaderDates(nsh, values, cols.headerRow, name, Number(body.year));

    SpreadsheetApp.flush();
    return json_({
      ok: true, sheetName: name, created: true, template: src.getName(),
      clearedCells: nRows * list.length, dataRows: nRows,
      storeCols: list.filter(function (c) { return !c.plus; }).map(function (c) { return c.store; }),
    });
  } finally {
    lock.releaseLock();
  }
}

/** Список вкладок для диагностики связки. */
function handleListTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return json_({
    ok: true,
    tabs: ss.getSheets().map(function (s, i) {
      return { name: s.getName(), index: i, hidden: s.isSheetHidden() };
    }),
  });
}

/**
 * Подмена дат в служебных строках НАД шапкой точек («Заказ 02.11.26», «Доставка 04.11.26»).
 * Меняем дд и мм (и гг, если были) на дату нового листа; формат года сохраняем.
 * Пишем только реально изменившиеся ячейки — остальные строки не трогаем.
 */
function rewriteHeaderDates(sh, values, headerRow, tabName, year) {
  var m = /^(\d{2})\.(\d{2})$/.exec(String(tabName || ''));
  if (!m || headerRow < 1) return;
  var dd = m[1], mm = m[2];
  var yy2 = String(year).slice(-2);
  for (var r = 0; r < headerRow && r < values.length; r++) {
    var row = values[r] || [];
    for (var c = 0; c < row.length; c++) {
      var v = row[c];
      if (typeof v !== 'string') continue;
      var nv = v.replace(/(\d{1,2})[.,](\d{1,2})(?:[.,](\d{2,4}))?/g, function (whole, d, mo, yr) {
        var out = dd + '.' + mm;
        if (yr) out += '.' + (yr.length >= 4 ? String(year) : yy2);
        return out;
      });
      if (nv !== v) sh.getRange(r + 1, c + 1).setValue(nv);
    }
  }
}

/** Все колонки точек сразу (а не одной): { headerRow, list:[{store,col,plus}] }. */
function allStoreCols(values) {
  var out = { headerRow: -1, list: [] };
  for (var r = 0; r < Math.min(values.length, 12); r++) {
    var row = values[r] || [];
    var found = [];
    for (var c = 0; c < row.length; c++) {
      var t = storeToken(String(row[c] || ''));
      if (t) found.push({ store: t.store, col: c, plus: t.plus });
    }
    if (found.length > out.list.length) { out.headerRow = r; out.list = found; }
  }
  return out;
}

/**
 * Колонка «Сумма» — контрольная сумма строки. Если в ней формула, она пересчитается
 * сама после обнуления; если напечатанное число — его надо снять, иначе лист
 * показывает остаток прошлой доставки.
 */
function clearLiteralSums(sh, values, headerRow, rowFrom, nRows) {
  var hdr = values[headerRow] || [];
  var sumCol = -1;
  for (var c = 0; c < hdr.length; c++) {
    if (/сумм/i.test(String(hdr[c] || '').toLowerCase())) { sumCol = c; break; }
  }
  if (sumCol < 0) return;
  var formulas;
  try { formulas = sh.getDataRange().getFormulas(); } catch (e) { return; }
  for (var r = rowFrom; r < rowFrom + nRows && r < values.length; r++) {
    var isFormula = formulas && formulas[r] && String(formulas[r][sumCol] || '').charAt(0) === '=';
    if (isFormula) continue;
    if (typeof values[r][sumCol] === 'number') sh.getRange(r + 1, sumCol + 1).clearContent();
  }
}

/** Самый свежий датированный лист: последний по порядку вкладок с именем dd.MM (не скрытый). */
function latestDatedSheet(ss) {
  var all = ss.getSheets();
  var best = null;
  for (var i = 0; i < all.length; i++) {
    var sh = all[i];
    if (sh.isSheetHidden()) continue;
    if (tabToDateNum(sh.getName()) === null) continue;
    best = sh; // листы идут хронологически — берём последний встреченный
  }
  return best;
}

/** dd.MM / dd,M -> число d*100+m для порядка; null — имя не дата-лист. */
function tabToDateNum(name) {
  var m = /^\s*(\d{1,2})[.,](\d{1,2})\s*$/.exec(String(name || ''));
  if (!m) return null;
  var dd = Number(m[1]), mm = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return mm * 100 + dd;
}

/** Вкладка по имени с запасом на хвостовые пробелы (в проде бывают «17.12  »). */
function findSheetByName(ss, name) {
  if (!name) return null;
  var direct = ss.getSheetByName(name);
  if (direct) return direct;
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].getName()).trim() === String(name).trim()) return all[i];
  }
  return null;
}

/** Имя вкладки: только dd.MM, с нулями («5.11» -> «05.11»); мусор -> ''. */
function normTabName(s) {
  var n = tabToDateNum(s);
  if (n === null) return '';
  var dd = n % 100, mm = Math.floor(n / 100);
  return (dd < 10 ? '0' : '') + dd + '.' + (mm < 10 ? '0' : '') + mm;
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
