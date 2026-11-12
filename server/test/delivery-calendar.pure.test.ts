/** Календарь производства: чистая валидация и обработчики с подменённым pg, без БД/.env. */
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../src/http';
import { pool } from '../src/db';

// settings.ts загружает config.ts: не позволяем dotenv читать локальные секреты.
const dotenv = require('dotenv') as typeof import('dotenv');
const dotenvMock = mock.method(dotenv, 'config', () => ({ parsed: {} }));
const noDatabase = () => { throw new Error('Настоящая БД запрещена в этих тестах'); };
mock.method(pool, 'query', noDatabase);
mock.method(pool, 'connect', noDatabase);
const { deliveryDate, deliveryRange, deliveryEnabled, settingsRouter } =
  require('../src/routes/settings') as typeof import('../src/routes/settings');
const { requireOffice } = require('../src/services/auth') as typeof import('../src/services/auth');
after(() => mock.restoreAll());

function badRequest(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) =>
    err instanceof ApiError && err.status === 400 && /[а-яА-Я]/.test(err.message));
}

test('загрузка маршрута не читает .env и не подключается к БД', () => {
  assert.equal(dotenvMock.mock.callCount(), 1);
});

test('даты: реальные даты, прошлые годы, високосные годы и границы 0001–9999', () => {
  for (const date of [
    '0001-01-01', '0004-02-29', '0099-12-31', '0100-01-01', '0400-02-29',
    '1582-10-10', '1900-02-28', '2000-02-29', '2024-02-29', '2026-11-30', '9999-12-31',
  ]) {
    assert.equal(deliveryDate(date), date);
  }
});

test('даты: невозможные дни/месяцы, невисокосные века и нулевой год дают 400', () => {
  for (const date of [
    '0000-01-01', '0000-02-29', '0001-02-29', '0100-02-29', '1900-02-29', '2100-02-29',
    '2025-02-29', '2024-02-30', '2026-04-31', '2026-11-31', '2026-00-10', '2026-13-10',
    '2026-01-00', '2026-01-32', '9999-12-32', '9999-99-99',
  ]) {
    badRequest(() => deliveryDate(date));
  }
});

test('даты: только строка YYYY-MM-DD, без времени, пробелов и нормализации', () => {
  for (const value of [
    undefined, null, true, 20261101, {}, ['2026-11-01'], new Date('2026-11-01T00:00:00Z'),
    '', '2026-1-01', '2026-11-1', '26-11-01', '10000-01-01', '-0001-01-01', '+2026-11-01',
    '2026/11/01', '2026-11-01T00:00:00Z', '2026-11-01 00:00:00', '2026-11-01T00:00:00+03:00',
    ' 2026-11-01', '2026-11-01 ', '2026-11-01\n', '２０２６-１１-０１',
  ]) {
    badRequest(() => deliveryDate(value));
  }
});

test('диапазоны: включительные границы, смена месяца/года/века, ранние годы', () => {
  for (const [from, to] of [
    ['0001-01-01', '0001-01-01'], ['0099-12-31', '0100-01-01'],
    ['2024-02-28', '2024-03-01'], ['2025-02-28', '2025-03-01'],
    ['2026-12-31', '2027-01-01'], ['9999-12-31', '9999-12-31'],
  ]) {
    assert.deepEqual(deliveryRange(from, to), { from, to });
  }
});

test('диапазоны: 93 дня разрешены, 94 запрещены, в том числе через Новый год и DST', () => {
  for (const [from, lastAllowed, firstRejected] of [
    ['0001-01-01', '0001-04-03', '0001-04-04'],
    ['0099-12-01', '0100-03-03', '0100-03-04'],
    ['2024-01-01', '2024-04-02', '2024-04-03'],
    ['2025-01-01', '2025-04-03', '2025-04-04'],
    ['2026-10-01', '2027-01-01', '2027-01-02'],
  ]) {
    assert.deepEqual(deliveryRange(from, lastAllowed), { from, to: lastAllowed });
    badRequest(() => deliveryRange(from, firstRejected));
  }
});

test('диапазоны: обратный порядок, слишком большой интервал и неверные query-параметры', () => {
  for (const [from, to] of [
    ['2026-12-01', '2026-11-30'], ['0001-01-01', '9999-12-31'],
    [undefined, '2026-01-01'], ['2026-01-01', undefined],
    [['2026-01-01'], '2026-01-01'], ['2026-01-01', { to: '2026-01-01' }],
    ['2026-02-30', '2026-03-01'], ['2026-01-01', '0000-01-01'],
  ]) {
    badRequest(() => deliveryRange(from, to));
  }
});

test('payload: enabled принимает только настоящие boolean', () => {
  assert.equal(deliveryEnabled({ enabled: true }), true);
  assert.equal(deliveryEnabled({ enabled: false }), false);
  for (const enabled of [undefined, null, 'true', 'false', 1, 0, [], {}, new Boolean(false)]) {
    badRequest(() => deliveryEnabled({ enabled }));
  }
  for (const body of [undefined, null, true, false, 'true', 0, [], [true], {}, Object.create({ enabled: true })]) {
    badRequest(() => deliveryEnabled(body));
  }
});

type Route = { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };
const officeAdmin = { id: 7, login: 'admin', fullName: 'Администратор', isAdmin: true, storeId: null, storeName: null };

function route(method: 'get' | 'put'): Route {
  const path = method === 'get' ? '/delivery-calendar' : '/delivery-calendar/:date';
  const layers = settingsRouter.stack as { route?: Route }[];
  const found = layers.find((layer) => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(found, `Маршрут ${method} ${path} существует`);
  return found;
}

// Исполняем реальные middleware без HTTP-сервера; родительский requireAdmin остаётся в app.ts.
function invoke(method: 'get' | 'put', input: Partial<Request> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const handlers = route(method).stack;
    const req = { params: {}, query: {}, user: officeAdmin, ...input } as Request;
    let status = 200;
    const res = {
      status(code: number) { status = code; return res; },
      json(body: unknown) { resolve({ status, body }); return res; },
    } as Response;
    let index = 0;
    const next: NextFunction = (err?: unknown) => {
      if (err) { reject(err); return; }
      const handler = handlers[index++]?.handle;
      if (!handler) { reject(new Error('Обработчик не вернул ответ')); return; }
      try { handler(req, res, next); } catch (error) { reject(error); }
    };
    next();
  });
}

test('оба маршрута запрещены магазину, даже если пользователь одновременно admin', async () => {
  for (const method of ['get', 'put'] as const) {
    assert.equal(route(method).stack[0].handle, requireOffice);
    for (const isAdmin of [false, true]) {
      const response = await invoke(method, { user: { ...officeAdmin, storeId: 3, isAdmin } });
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: 'Доступно только сотрудникам офиса' });
    }
  }
});

test('GET: возвращает дату БД и сортированные ISO-даты, включая прошлые доставки', async (t) => {
  const dates = ['0099-12-31', '0100-01-01'];
  const today = '2026-11-12';
  t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /to_char\(current_date, 'YYYY-MM-DD'\) as today/);
    assert.match(sql, /array_agg\(to_char\(delivery_date, 'YYYY-MM-DD'\) order by delivery_date\)/);
    assert.match(sql, /coalesce\(.*'\{\}'::text\[\]\) as dates/);
    assert.match(sql, /from delivery_schedule/);
    assert.match(sql, /between \$1::date and \$2::date/);
    assert.deepEqual(values, dates);
    return { rows: [{ today, dates }] };
  });
  assert.deepEqual(await invoke('get', { query: { from: dates[0], to: dates[1] } }), {
    status: 200, body: { today, dates },
  });
});

test('GET: пустой календарь возвращает пустой массив и сегодняшнюю дату', async (t) => {
  const today = '2026-11-12';
  t.mock.method(pool, 'query', async () => ({ rows: [{ today, dates: [] }] }));
  assert.deepEqual(await invoke('get', { query: { from: '2026-01-01', to: '2026-01-01' } }), {
    status: 200, body: { today, dates: [] },
  });
});

test('невалидные запросы отклоняются до обращения к БД', async () => {
  for (const [method, input] of [
    ['get', { query: {} }],
    ['get', { query: { from: '2026-01-01', to: '2026-04-04' } }],
    ['put', { params: { date: '2026-02-29' }, body: { enabled: true } }],
    ['put', { params: { date: '2026-01-01' }, body: { enabled: 'false' } }],
    ['put', { params: { date: '2026-01-01' }, body: null }],
  ] as const) {
    await assert.rejects(invoke(method, input), (err: unknown) => err instanceof ApiError && err.status === 400);
  }
});

for (const enabled of [true, false]) {
  test(`PUT enabled=${enabled}: вчера и сегодня запрещены до изменения расписания и аудита`, async (t) => {
    let today = '';
    let calls: string[] = [];
    t.mock.method(pool, 'connect', async () => ({
      async query(sql: string) {
        calls.push(sql);
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        assert.equal(sql, "select to_char(current_date, 'YYYY-MM-DD') as today");
        return { rows: [{ today }] };
      },
      release() { calls.push('RELEASE'); },
    }));
    for (const [current, yesterday] of [
      ['2026-11-12', '2026-11-11'],
      ['2027-01-01', '2026-12-31'],
      ['2028-03-01', '2028-02-29'],
    ]) {
      today = current;
      for (const date of [yesterday, today, '0001-01-01']) {
        calls = [];
        await assert.rejects(invoke('put', { params: { date }, body: { enabled } }),
          (err: unknown) => err instanceof ApiError && err.status === 400 && /Сегодняшнюю и прошедшие/.test(err.message));
        assert.deepEqual(calls, ['BEGIN', "select to_char(current_date, 'YYYY-MM-DD') as today", 'ROLLBACK', 'RELEASE']);
      }
    }
  });

  for (const changed of [true, false]) {
    test(`PUT enabled=${enabled}, изменение=${changed}: завтра разрешено, аудит только при изменении`, async (t) => {
      const date = '2028-02-29';
      const calls: string[] = [];
      const client = {
        async query(sql: string, values?: unknown[]) {
          calls.push(sql);
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
          if (sql.includes('current_date')) {
            assert.equal(sql, "select to_char(current_date, 'YYYY-MM-DD') as today");
            return { rows: [{ today: '2028-02-28' }] };
          }
          if (sql.includes('delivery_schedule')) {
            assert.match(sql, /returning to_char\(delivery_date, 'YYYY-MM-DD'\) as date/);
            if (enabled) {
              assert.match(sql, /insert into delivery_schedule \(delivery_date, created_by\) values \(\$1::date, \$2\)/);
              assert.match(sql, /on conflict \(delivery_date\) do nothing/);
              assert.deepEqual(values, [date, officeAdmin.id]);
            } else {
              assert.match(sql, /delete from delivery_schedule where delivery_date = \$1::date/);
              assert.deepEqual(values, [date]);
            }
            return { rows: changed ? [{ date }] : [] };
          }
          assert.match(sql, /insert into audit_log/);
          assert.equal(changed, true, 'Нет фантомного аудита');
          assert.equal(values?.[0], officeAdmin.id);
          assert.deepEqual(values?.slice(3, 6), ['update', 'setting', 'delivery-calendar']);
          assert.deepEqual(JSON.parse(values?.[7] as string), { date, enabled });
          return { rows: [] };
        },
        release() { calls.push('RELEASE'); },
      };
      t.mock.method(pool, 'connect', async () => client);
      assert.deepEqual(await invoke('put', { params: { date }, body: { enabled } }), {
        status: 200, body: { date, enabled },
      });
      assert.equal(calls[0], 'BEGIN');
      assert.deepEqual(calls.slice(-2), ['COMMIT', 'RELEASE']);
      assert.equal(calls.filter((sql) => sql.includes('delivery_schedule')).length, 1);
      assert.equal(calls.filter((sql) => sql.includes('audit_log')).length, changed ? 1 : 0);
    });
  }
}

test('PUT: ошибка аудита откатывает изменение, успешный ответ не отправляется', async (t) => {
  const calls: string[] = [];
  const failure = new Error('audit failed');
  t.mock.method(pool, 'connect', async () => ({
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('current_date')) return { rows: [{ today: '2025-12-31' }] };
      if (sql.includes('audit_log')) throw failure;
      return { rows: sql.includes('delivery_schedule') ? [{ date: '2026-01-01' }] : [] };
    },
    release() { calls.push('RELEASE'); },
  }));
  await assert.rejects(invoke('put', { params: { date: '2026-01-01' }, body: { enabled: true } }), failure);
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  assert.equal(calls.includes('COMMIT'), false);
});
