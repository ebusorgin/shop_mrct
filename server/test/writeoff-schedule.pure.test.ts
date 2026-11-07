/**
 * Чистые юнит-тесты расписания доставок и закрытия заказов: нормализация настроек + MSK-логика слота.
 * Без БД и сети — это те же функции, что зовёт планировщик каждую минуту.
 * Запуск: npm run test:pure (из server/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeliverySchedule, DELIVERY_DEFAULTS, type DeliverySettings } from '../src/services/settings';
import { mskNow, isSlotDue, nextDue } from '../src/services/writeoff';
import { nextDeliveryDate, upcomingDeliveryDates } from '../src/services/delivery';

const dcfg = (over: Partial<DeliverySettings>): DeliverySettings => ({ ...DELIVERY_DEFAULTS, ...over });

// ==================== normalizeDeliverySchedule ====================

test('normalize: enabled, dates, time, tz', () => {
  const r = normalizeDeliverySchedule({
    enabled: true,
    dates: ['2026-11-05', '2026-11-02', '2026-11-02', 'invalid', '2026-13-40'],
    time: '18:30',
  });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.dates, ['2026-11-02', '2026-11-05']);
  assert.equal(r.time, '18:30');
  assert.equal(r.tz, 'Europe/Moscow');
});

test('normalize: enabled принимает true/"true", не принимает мусор', () => {
  assert.equal(normalizeDeliverySchedule({ enabled: true }).enabled, true);
  assert.equal(normalizeDeliverySchedule({ enabled: 'true' as unknown as boolean }).enabled, true);
  assert.equal(normalizeDeliverySchedule({ enabled: 1 as unknown as boolean }).enabled, false);
});

test('normalize: кривое время и кривая таймзона — ApiError(400)', () => {
  assert.throws(() => normalizeDeliverySchedule({ time: '25:00' }), /Время/);
  assert.throws(() => normalizeDeliverySchedule({ time: '9:5' }), /Время/);
  assert.throws(() => normalizeDeliverySchedule({ time: 'abc' }), /Время/);
  assert.throws(() => normalizeDeliverySchedule({ tz: 'Mars/Olympus' }), /часовой пояс/);
});

// ==================== mskNow / isSlotDue / nextDue ====================

test('mskNow: UTC→MSK (+3), переход через полночь сдвигает и дату, и день недели', () => {
  // 2026-11-02 — понедельник. 07:30 UTC = 10:30 MSK того же дня.
  const morning = mskNow('Europe/Moscow', new Date(Date.UTC(2026, 10, 2, 7, 30)));
  assert.deepEqual(morning, { dateIso: '2026-11-02', weekday: 1, hhmm: '10:30' });
  // 22:45 UTC 2 ноября = 01:45 MSK 3 ноября (вторник) — дата и день «переезжают» вперёд
  const afterMidnight = mskNow('Europe/Moscow', new Date(Date.UTC(2026, 10, 2, 22, 45)));
  assert.deepEqual(afterMidnight, { dateIso: '2026-11-03', weekday: 2, hhmm: '01:45' });
});

test('isSlotDue: нужен совпавший день доставки И время, и чтобы расписание было включено', () => {
  const now = { dateIso: '2026-11-02', weekday: 1, hhmm: '10:30' };
  assert.equal(isSlotDue(now, dcfg({ enabled: true, dates: ['2026-11-02'], time: '10:30' })), true);
  assert.equal(isSlotDue(now, dcfg({ enabled: true, dates: ['2026-11-03'], time: '10:30' })), false, 'не та дата');
  assert.equal(isSlotDue(now, dcfg({ enabled: true, dates: ['2026-11-02'], time: '09:00' })), false, 'не то время');
  assert.equal(isSlotDue(now, dcfg({ enabled: false, dates: ['2026-11-02'], time: '10:30' })), false, 'выключено');
});

test('nextDue: сегодня ещё время впереди -> сегодня; иначе — ближайшая будущая дата доставки', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0)); // понедельник 10:00 MSK
  const schedule = dcfg({ enabled: true, dates: ['2026-11-02', '2026-11-05'], time: '18:00' });
  const laterToday = nextDue(schedule, at);
  assert.deepEqual(laterToday, { dateIso: '2026-11-02', time: '18:00' }, 'время ещё не наступило');

  // после времени списания сегодняшнего дня -> следующая дата доставки
  const afterLast = new Date(Date.UTC(2026, 10, 2, 16, 0)); // 19:00 MSK
  assert.deepEqual(nextDue(schedule, afterLast), { dateIso: '2026-11-05', time: '18:00' });
});

test('nextDue: пусто, если выключено или расписание неполное', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0));
  assert.equal(nextDue(dcfg({ enabled: false, dates: ['2026-11-02'], time: '10:00' }), at), null);
  assert.equal(nextDue(dcfg({ enabled: true, dates: [], time: '10:00' }), at), null);
  assert.equal(nextDue(dcfg({ enabled: true, dates: ['2026-11-02'], time: '' }), at), null);
});

// ==================== nextDeliveryDate / upcomingDeliveryDates ====================

test('nextDeliveryDate: сегодня — день доставки -> сегодня; иначе ближайший вперёд', () => {
  // 2026-11-02 понедельник. at = 10:00 MSK понедельника.
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0));
  assert.equal(nextDeliveryDate(dcfg({ dates: ['2026-11-02', '2026-11-04'] }), at), '2026-11-02', 'сегодня — доставка, берём сегодня');
  assert.equal(nextDeliveryDate(dcfg({ dates: ['2026-11-04', '2026-11-10'] }), at), '2026-11-04', 'среда — ближайшая доставка вперёд');
  assert.equal(nextDeliveryDate(dcfg({ dates: [] }), at), null, 'даты не выбраны');
});

test('upcomingDeliveryDates: будущие даты доставки без дублей', () => {
  const at = new Date(Date.UTC(2026, 10, 2, 7, 0)); // понедельник 2026-11-02
  const list = upcomingDeliveryDates(dcfg({ dates: ['2026-10-30', '2026-11-02', '2026-11-04', '2026-11-06'] }), 4, at);
  assert.deepEqual(list, ['2026-11-02', '2026-11-04', '2026-11-06']);
  assert.equal(upcomingDeliveryDates(dcfg({ dates: [] }), 4, at).length, 0);
});
