/**
 * ============================================================================
 *  Мост «Google Таблица заказов → CRM»
 *  Apps Script, привязанный к таблице (Extensions → Apps Script).
 * ============================================================================
 *
 *  ЧТО ДЕЛАЕТ
 *  При любой правке листа скрипт мгновенно (за ~0.5 с) отправляет на сервер CRM
 *  POST /api/hooks/sheet. Сервер рассылает браузерам событие по SSE, показывает
 *  плашку «в Google Таблице изменения» и запускает внеплановую синхронизацию.
 *
 *  ПОЧЕМУ НЕ WEBSOCKET
 *  В Apps Script нет WebSocket и нет входящих соединений: наружу можно только
 *  UrlFetchApp.fetch (HTTP-запрос), внутрь — только doGet/doPost. Порты и сокеты
 *  в песочнице Google недоступны, поэтому «постоянное соединение» строится из
 *  push-запросов на наш HTTPS-эндпоинт. Для браузера постоянный канал — SSE
 *  (/api/events), его держит уже наш сервер, а не таблица.
 *
 *  ВАЖНО ПРО АДРЕС
 *  Google должен видеть сервер по HTTPS из интернета: http://localhost:4000 и
 *  http://192.168.x.x:4000 из облака недоступны. Варианты:
 *    • прод: https://crm.example.com/api/hooks/sheet (домен + TLS);
 *    • тест: временный туннель `cloudflared tunnel --url http://localhost:4000`
 *      → https://<random>.trycloudflare.com/api/hooks/sheet
 *      (адрес меняется при каждом перезапуске туннеля — обновите CFG.ENDPOINT).
 *  Если вебхук недоступен, сервер всё равно заметит правку сам: раз в
 *  GSHEET_WATCH_SEC секунд он сверяет хэш «горячего» листа (страховочный вотчер).
 *
 *  СТАБИЛИЗАЦИЯ
 *   1. Вставьте этот файл в проект Apps Script таблицы.
 *   2. В CFG укажите ENDPOINT и TOKEN (TOKEN = GSHEET_HOOK_TOKEN из server/.env).
 *   3. Выполните installTriggers() — Apps Script попросит разрешения на таблицу
 *      и внешние запросы (это ожидаемо, скрипт работает от вашего имени).
 *   4. Выполните testHook() — в CRM должна появиться плашка, а в логах сервера
 *      строка «[sheet-events]». В таблице появится меню «CRM» с теми же кнопками.
 *
 *  ЧТО НЕ ЛОВИТСЯ
 *   - правки, сделанные другим скриптом/API без участия человека (onChange не
 *     срабатывает) — их доберёт серверный вотчер или обычный цикл синхронизации;
 *   - форматирование, если CFG.IGNORE_FORMAT = true (шум, данные не изменились).
 * ============================================================================
 */

var CFG = {
  // адрес вебхука CRM (без завершающей косой черты)
  ENDPOINT: 'https://crm.example.com/api/hooks/sheet',
  // тот же секрет, что GSHEET_HOOK_TOKEN в server/.env
  TOKEN: 'вставьте-токен-из-server-env',
  // не чаще одного запроса на лист за N секунд (onEdit и onChange приходят парой)
  MIN_INTERVAL_SEC: 3,
  // правки только оформления (заливка, шрифт) не влияют на данные — не шлём
  IGNORE_FORMAT: true,
  // писать в журнал выполнения (View → Executions / Logger)
  DEBUG: true,
};

/** installable-триггер onChange: структурные правки и правки значений человеком. */
function onSheetChange(e) {
  bridge_(e, 'change');
}

/** installable-триггер onEdit: одна ячейка/диапазон, знаем лист и адрес точно. */
function onSheetEdit(e) {
  bridge_(e, 'edit');
}

/** Меню в самой таблице — чтобы не лазить в редактор скриптов. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CRM')
    .addItem('Установить триггеры', 'installTriggers')
    .addItem('Проверить вебхук', 'testHook')
    .addItem('Статус', 'showStatus')
    .addSeparator()
    .addItem('Удалить триггеры', 'removeTriggers')
    .addToUi();
}

// ---------------------------------------------------------------------------
//  Триггеры
// ---------------------------------------------------------------------------

/** Ставит оба триггера (прежние одноимённые удаляются, дублей не будет). */
function installTriggers() {
  removeTriggers();
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  log_('триггеры установлены: onChange + onEdit');
  return showStatus();
}

function removeTriggers() {
  var names = ['onSheetChange', 'onSheetEdit'];
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (names.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  log_('удалено триггеров: ' + removed);
  return removed;
}

/** Проверка руками: шлёт событие с текущим листом и печатает ответ сервера. */
function testHook() {
  var body = {
    tab: SpreadsheetApp.getActiveSheet().getName(),
    changeType: 'manual_test',
    email: actor_(),
    at: new Date().toISOString(),
    source: 'apps_script',
  };
  var res = send_(body);
  var text = 'testHook → HTTP ' + res.code + '\n' + res.text;
  log_(text);
  try {
    SpreadsheetApp.getUi().alert(text);
  } catch (err) {
    // вызов не из интерфейса таблицы — достаточно Logger
  }
  return text;
}

/** Что настроено и что сломано — первое, что стоит смотреть, если плашки нет. */
function showStatus() {
  var problems = [];
  if (!/^https:\/\//.test(CFG.ENDPOINT)) problems.push('CFG.ENDPOINT должен начинаться с https://');
  if (!CFG.TOKEN || CFG.TOKEN.indexOf('вставьте') === 0) problems.push('CFG.TOKEN не заполнен');
  if (CFG.ENDPOINT.indexOf('/api/hooks/sheet') < 0) problems.push('в CFG.ENDPOINT нет пути /api/hooks/sheet');

  var handlers = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction();
  });
  if (handlers.indexOf('onSheetChange') < 0) problems.push('нет триггера onChange — выполните installTriggers()');
  if (handlers.indexOf('onSheetEdit') < 0) problems.push('нет триггера onEdit — выполните installTriggers()');

  var lines = [
    'Таблица: ' + SpreadsheetApp.getActive().getName(),
    'Адрес:    ' + CFG.ENDPOINT,
    'Триггеры: ' + (handlers.join(', ') || 'нет'),
    problems.length ? 'Проблемы:\n- ' + problems.join('\n- ') : 'Конфигурация в порядке',
  ];
  var text = lines.join('\n');
  log_(text);
  try {
    SpreadsheetApp.getUi().alert(text);
  } catch (err) {
    // вне интерфейса
  }
  return text;
}

// ---------------------------------------------------------------------------
//  Отправка
// ---------------------------------------------------------------------------

function bridge_(e, kind) {
  var changeType = (e && e.changeType) || kind;
  if (CFG.IGNORE_FORMAT && changeType === 'FORMAT') return;

  var tab = tabName_(e);
  // onEdit и onChange приходят на одну и ту же правку: пропускаем второй за N сек
  var gateKey = 'gate_' + tab;
  var cache = CacheService.getScriptCache();
  if (CFG.MIN_INTERVAL_SEC > 0) {
    if (cache.get(gateKey)) return;
    cache.put(gateKey, '1', CFG.MIN_INTERVAL_SEC);
  }

  var body = {
    tab: tab,
    changeType: changeType,
    email: actor_(),
    at: new Date().toISOString(),
    source: 'apps_script',
  };
  if (e && e.range) {
    // адрес правки помогает в журнале сервера; значение ячейки не отправляем
    body.payload = {
      a1: e.range.getA1Notation(),
      row: e.range.getRow(),
      col: e.range.getColumn(),
      rows: e.range.getNumRows(),
      cols: e.range.getNumColumns(),
    };
  }

  var res = send_(body);
  if (res.code !== 202 && res.code !== 200) log_('вебхук ответил ' + res.code + ': ' + res.text);
}

function send_(body) {
  try {
    var res = UrlFetchApp.fetch(CFG.ENDPOINT, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'X-Sheet-Token': CFG.TOKEN },
      payload: JSON.stringify(body),
      muteHttpExceptions: true, // 401/503 хотим увидеть телом, а не исключением
    });
    return { code: res.getResponseCode(), text: String(res.getContentText()).slice(0, 500) };
  } catch (err) {
    // нет сети / неверный URL / туннель закрыт
    var msg = 'fetch error: ' + err;
    log_(msg);
    return { code: 0, text: msg };
  }
}

function tabName_(e) {
  try {
    if (e && e.range && e.range.getSheet) return e.range.getSheet().getName();
    var src = e && e.source ? e.source : SpreadsheetApp.getActive();
    return src.getActiveSheet().getName();
  } catch (err) {
    return '';
  }
}

/** Кто правит: почта действующего пользователя (кэшируем, вызов небыстрый). */
function actor_() {
  var cache = CacheService.getScriptCache();
  var who = cache.get('actor');
  if (who) return who;
  try {
    who = Session.getEffectiveUser().getEmail() || '';
  } catch (err) {
    who = '';
  }
  cache.put('actor', who, 600);
  return who;
}

function log_(msg) {
  if (!CFG.DEBUG) return;
  console.log('[sheet-hook] ' + msg);
}
