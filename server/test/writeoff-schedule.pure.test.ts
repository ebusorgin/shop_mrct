/**
 * Чистые юнит-тесты расписания автосписания: нормализация настроек + MSK-логика слота.
 * Без БД и сети — это те же функции, что зовёт планировщик каждую минуту.
 * Запуск: npm run test:pure (из server/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWriteoffSchedule, normalizeDeliverySchedule, WRITEOFF_DEFAULTS, DELIVERY_DEFAULTS, type WriteoffSettings, type DeliverySettings } from '../src/services/settings';
import { mskNow, isSlotDue, nextDue } from '../src/services/writeoff';
import { nextDeliveryDate, upcomingDeliveryDates } from '../src/services/delivery';
import { tabNameForDate } from '../src/services/sheet-tabs';
import { tabToDate } from '../src/services/gsheet';

const cfg = (over: Partial<WriteoffSettings>): WriteoffSettings => ({ ...WRITEOFF_DEFAULTS, ...over });

// ==================== normalizeWriteoffSchedule ====================

test('normalize: добивает дефолтами, чистит дни (0..6, уникальные, по порядку)', () => {
  const r = normalizeWriteoffSchedule({ weekdays: [6, 1, 1, 9, -3, 3.5, 0] as number[] });
  assert.deepEqual(r.weekdays, [0, 1, 6], 'не-целые и вне 0..6 отброшены, дубли сняты, сортировка');
  assert.equal(r.enabled, false);
  assert.equal(r.tz, 'Europe/Moscow');
  assert.deepEqual(r.times, []);
});

test('normalize: времена к канону HH:MM, дедуп и сортировка', () => {
  const r = normalizeWriteoffSchedule({ times: ['9:05', '18:30', '09:05', '0:00'] });
  assert.deepEqual(r.times, ['00:00', '09:05', '18:30']);
});

test('normalize: enabled принимает true/"true", не принимает мусор', () => {
  assert.equal(normalizeWriteoffSchedule({ enabled: true }).enabled, true);
  assert.equal(normalizeWriteoffSchedule({ enabled: 'true' as unknown as boolean }).enabled, true);
  assert.equal(normalizeWriteoffSchedule({ enabled: 1 as unknown as boolean }).enabled, false);
});

test('normalize: таймзона по умолчанию и валидная IANA', () => {
  assert.equal(normalizeWriteoffSchedule({}).tz, 'Europe/Moscow');
  assert.equal(normalizeWriteoffSchedule({ tz: 'Europe/Moscow' }).tz, 'Europe/Moscow');
});

test('normalize: кривое время и кривая таймзона — ApiError(400)', () => {
  assert.throws(() => normalizeWriteoffSchedule({ times: ['25:00'] }), /Время/);
  assert.throws(() => normalizeWriteoffSchedule({ times: ['9:5'] }), /Время/);
  assert.throws(() => normalizeWriteoffSchedule({ times: ['abc'] }), /Время/);
  assert.throws(() => normalizeWriteoffSchedule({ tz: 'Mars/Olympus' }), /часовой пояс/);
});

// ==================== mskNow / isSlotDue ====================

test('mskNow: UTC→MSK (+3), переход через полночь сдвигает и дату, и день недели', () => {
  // 2026-11-02 — понедельник. 07:30 UTC = 10:30 MSK того же дня.
  const morning = mskNow('Europe/Moscow', new Date(Date.UTC(2026, 10, 2, 7, 30)));
  assert.deepEqual(morning, { dateIso: '2026-11-02', weekday: 1, hhmm: '10:30' });
  // 22:45 UTC 2 ноября = 01:45 MSK 3 ноября (вторник) — дата и день «переезжают» вперёд
  const afterMidnight = mskNow('Europe/Moscow', new Date(Date.UTC(2026, 10, 2, 22, 45)));
  assert.deepEqual(afterMidnight, { dateIso: '2026-11-03', weekday: 2, hhmm: '01:45' });
});

test('isSlotDue: нужен совпавший день И время, и чтобы расписание было включено', () => {
  const now = { dateIso: '2026-11-02', weekday: 1, hhmm: '10:30' };
  assert.equal(isSlotDue(now, cfg({ enabled: true, weekdays: [1], times: ['10:30'] })), true);
  assert.equal(isSlotDue(now, cfg({ enabled: true, weekdays: [2], times: ['10:30'] })), false, 'не тот день');
  assert.equal(isSlotDue(now, cfg({ enabled: true, weekdays: [1], times: ['09:00'] })), false, 'не то время');
  assert.equal(isSlotDue(now, cfg({ enabled: false, weekdays: [1], times: ['10:30'] })), false, 'выключено');
});

// ==================== nextDue ====================

test('nextDue: сегодня ещё есть поздний слот -> сегодня; иначе — ближайший подходящий день', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0)); // понедельник 10:00 MSK
  const schedule = cfg({ enabled: true, weekdays: [1], times: ['09:00', '18:00'] });
  const laterToday = nextDue(schedule, at);
  assert.deepEqual(laterToday, { dateIso: '2026-11-02', time: '18:00' }, '09:00 уже прошёл, 18:00 — впереди');

  // после последнего слота понедельника -> следующий понедельник, раннее время
  const afterLast = new Date(Date.UTC(2026, 10, 2, 16, 0)); // 19:00 MSK
  assert.deepEqual(nextDue(schedule, afterLast), { dateIso: '2026-11-09', time: '09:00' });
});

test('nextDue: пусто, если выключено или расписание неполное', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0));
  assert.equal(nextDue(cfg({ enabled: false, weekdays: [1], times: ['10:00'] }), at), null);
  assert.equal(nextDue(cfg({ enabled: true, weekdays: [], times: ['10:00'] }), at), null);
  assert.equal(nextDue(cfg({ enabled: true, weekdays: [1], times: [] }), at), null);
});

// ==================== Доставка: normalizeDeliverySchedule ====================

const dcfg = (over: Partial<DeliverySettings>): DeliverySettings => ({ ...DELIVERY_DEFAULTS, ...over });

test('delivery normalize: дни 0..6 уникальные по порядку, дефолт tz', () => {
  const r = normalizeDeliverySchedule({ weekdays: [6, 1, 1, 9, -3, 3.5, 0] as number[] });
  assert.deepEqual(r.weekdays, [0, 1, 6]);
  assert.equal(r.tz, 'Europe/Moscow');
});

test('delivery normalize: кривая таймзона — ApiError(400)', () => {
  assert.throws(() => normalizeDeliverySchedule({ tz: 'Mars/Olympus' }), /часовой пояс/);
});

// ==================== nextDeliveryDate / upcomingDeliveryDates ====================

test('nextDeliveryDate: сегодня — день доставки -> сегодня; иначе ближайший вперёд', () => {
  // 2026-11-02 понедельник. at = 10:00 MSK понедельника.
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0));
  assert.equal(nextDeliveryDate(dcfg({ weekdays: [1] }), at), '2026-11-02', 'понедельник — доставка, берём сегодня');
  assert.equal(nextDeliveryDate(dcfg({ weekdays: [3] }), at), '2026-11-04', 'среда — ближайшая доставка вперёд');
  assert.equal(nextDeliveryDate(dcfg({ weekdays: [] }), at), null, 'дни не выбраны');
});

test('upcomingDeliveryDates: несколько дат по ритму, без дублей', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0)); // понедельник
  // доставка по вторникам и четвергам
  const list = upcomingDeliveryDates(dcfg({ weekdays: [2, 4] }), 4, at);
  assert.deepEqual(list, ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12']);
  assert.equal(upcomingDeliveryDates(dcfg({ weekdays: [] }), 4, at).length, 0);
});

// ==================== Имя вкладки следующего листа ====================

test('tabNameForDate: YYYY-MM-DD -> dd.MM с нулями; имя понимает tabToDate из gsheet', () => {
  assert.equal(tabNameForDate('2026-11-05'), '05.11');
  assert.equal(tabNameForDate('2026-11-12'), '12.11');
  assert.equal(tabNameForDate('2027-01-02'), '02.01');
  assert.equal(tabNameForDate('05.11'), null);
  assert.equal(tabNameForDate(''), null);
  // круг: сгенерированное имя читается парсером листов как та же дата
  assert.deepEqual(tabToDate(tabNameForDate('2026-11-05')!), { dd: 5, mm: 11 });
});
