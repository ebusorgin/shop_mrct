# MIX markt CRM — аудит и план исправлений

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ: используйте `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans`, чтобы выполнять план задача-за-задачей. Шаги отмечены чекбоксами (`- [ ]`) для учёта прогресса.

**Goal:** Сделать проект проверяемым и устранить найденные дефекты: перенумерация отчётов, гонки/дедлоки склада и заказов, ложные номера старых документов, перезапись алиасов, непрозрачный вес и PDV, риск падения production при старте.

**Architecture:** Без новых слоёв: правки в `server/src/routes/*`, `server/src/services/*`, `server/sql/init.sql`, `client/src/app/*`. Схема остаётся единым идемпотентным `init.sql`; клиентские зеркала расчётов меняются вместе с серверными.

**Tech Stack:** Express 4 + TypeScript, PostgreSQL 16+, Angular 19, node:test + tsx, GitHub Actions (сборка и деплой на прод).

**Spec:** Отдельного ТЗ нет — раздел «Результаты аудита» ниже является спецификацией. Все утверждения помечены как проверенные по коду/сборке либо как непроверенные из-за недоступной БД.

## Статус выполнения (2026-11-17)

- Локальный контур поднят: portable PostgreSQL 18.2 в `.devtools/pg18` на данных `.devtools/data`, PM2, скрипты `local-db.ps1`, `start-crm.ps1`, `ensure-crm.ps1`, задачи автозапуска и сторожа зарегистрированы. Проверен холодный старт одной командой.
- Ручная перенумерация **удалена по решению владельца**: эндпоинт `PUT /api/orders/report/numbering`, клиентский вызов и поле «Индекс документа» убраны. В отчёте осталась только справочная строка с диапазоном номеров.
- Прошлые документы 2026 пронумерованы скриптом `server/scripts/backfill-past-2026-doc-no.sql`: 820 документов получили 23…842, магазин 103 сохранил 843, 2025 год не тронут, дублей нет. Скрипт идемпотентен через `app_migrations`.
- Исправлены: порядок блокировок накладной (дедлок), 23505→409 на дубле номера, проверка фасовок внутри транзакции заказа, алиасы без перепривязки, минус в количествах, `Secure` cookie через `COOKIE_SECURE`, защищённое создание уникального индекса и реестр `app_migrations` в `init.sql`.
- Не выполнено: восстановление `npm test` (в репозитории по-прежнему нет файлов тестов из `package.json`) и браузерная проверка печати отчёта.

## Global Constraints

- Не деплоить и не писать в production без явной просьбы. Пуш в `main` автоматически выкатывает прод (`.github/workflows/deploy.yml`), поэтому работа — только в ветке, пуш — только по разрешению.
- Любая мутация склада — только внутри транзакции через `applyMovement` (`server/src/services/stock.ts`).
- Блокировать склад в детерминированном порядке (по возрастанию `product_id`).
- `server/sql/init.sql` — единственный источник схемы, выполняется при каждом старте; изменения только аддитивные и идемпотентные.
- `storeId` магазина берётся только из сессии; `cost`/`avg_cost` не попадают в магазинные ответы.
- Формулы раскрытия (`expansion.ts`) и клиентские зеркала (`semi-calc.ts`, `units.ts`, `packaging-label.ts`) меняются синхронно.
- Модель ИИ не меняет числа в накладной; арифметика — только детерминированный код.
- Локальная БД — копия production; не полагаться на неё как на «безопасную песочницу» для разрушительных проверок.

---

## Результаты аудита (факты)

### Что проверено фактически

| Проверка | Результат |
|---|---|
| `cd server && npm run build` | PASS |
| `cd client && npm run build` | PASS (bundle собран за 3.7 с) |
| `cd server && npm test` | FAIL: `Could not find 'test/delivery-calendar.pure.test.ts, …'` |
| PostgreSQL `127.0.0.1:5432` | ECONNREFUSED |
| API `http://127.0.0.1:4000/api/health` | пустой ответ, порт не слушается |
| Dev-клиент `:4200` | слушает, но без API работать не может |
| Незакоммиченные изменения | 7 файлов модуля отчёта (`git diff --stat`) |
| Секреты в git | `.env`, `credentials.json`, `uploads/` не отслеживаются |
| Паритет эндпоинтов клиент↔сервер | расхождений не найдено |
| `packaging-label.ts` / `units.ts` против сервера | зеркала совпадают |
| Изоляция магазина, guards, отсутствие `cost` в store-ответах | подтверждено по коду |
| Инварианты склада в БД (`stock.qty = Σ movements`) | **не проверены** — БД недоступна |

### Дефекты и риски (по убыванию)

| # | Приоритет | Проблема | Где |
|---|---|---|---|
| 1 | P0 | Локальный контур не поднимается: нет PostgreSQL и API; `4200` работает вхолостую | окружение |
| 2 | P0 | `npm test` ссылается на 5 отсутствующих файлов; CI тесты не запускает | `server/package.json`, `.github/workflows/deploy.yml` |
| 3 | P0 | Перенумерация «вперёд» внутри занятого диапазона падает: `843→844` при существующем `844` нарушает немедленный уникальный индекс (23505 → 409), хотя конфликт-проверка его пропускает | `server/src/routes/orders.ts:104-107` |
| 4 | P1 | Старые документы без `doc_no` показываются как `год-id`; UI берёт `id` за индекс и может перенумеровать дату в диапазон `id…` | `server/src/services/order-report.ts:154`, `client/src/app/orders/report.component.ts:127,252` |
| 5 | P1 | `ingestWaybill` применяет движения в порядке строк запроса без предблокировки — две многострочные накладные дают дедлок → 500 | `server/src/routes/waybills.ts:95` |
| 6 | P1 | Проверка дубля номера накладной и вставка не сериализованы; 23505 не маппится в 409 → 500 | `waybills.ts:55`, `server/src/http.ts:28` |
| 7 | P1 | Доступность фасовок проверяется вне транзакции заказа; удаление фасовки между проверкой и вставкой → FK 500 | `server/src/routes/store.ts:196-235` |
| 8 | P1 | `confirmImport` при конфликте алиаса перезаписывает `product_id` (`do update set product_id`) — портит будущий матчинг | `server/src/routes/import.ts:1903` |
| 9 | P2 | Вес отчёта: штучные позиции дают `0`, объём считается как `1 л = 1 кг`; итог «Общий вес» выглядит полным, но неполон | `order-report.ts:187` |
| 10 | P2 | PDV применяется только по Enter/кнопке; `0 %` сохраняется в `localStorage` без предупреждения; store-режим читает офисную ставку | `report.component.ts`, `report.component.html:46-48` |
| 11 | P2 | `init.sql` применяется на старте прода: любая ошибка DDL/уникального индекса = CRM не стартует; бэкфиллы не отмечены как применённые | `server/src/init-db.ts:16`, `init.sql:458,564` |
| 12 | P3 | `fmtQty` скрывает знак: списание и отрицательный остаток выглядят положительными | `client/src/app/core/format.ts:2` |
| 13 | P3 | Cookie сессии без `Secure`; на проде HTTPS, но флаг не выставляется | `server/src/services/auth.ts:74` |
| 14 | P3 | README описывает старый срез (нет заказов, поставщиков, авторизации, отчётов) | `README.md` |

### Что требует особого внимания (не «баги», а правила работы)

- **Пуш в `main` = релиз на прод.** Сейчас ветка `main` и 7 незакоммиченных файлов. Любая работа — в отдельной ветке; `git push` — только после явного разрешения.
- **Нет staging.** Проверки ролей и печати делать локально; прод трогать только чтением.
- **`init.sql` — единственная миграция.** Он крутится в одной транзакции при каждом старте. Новая DDL-ошибка останавливает весь сервис; новые `UNIQUE` по живым данным надо делать безопасно.
- **В Otpremnica нет снимка цен.** Отчёт строится по текущим `price`/`cost` фасовок: правка цены меняет прошлые документы. Любая «историческая» логика должна это учитывать.
- **Нумерация документов общая на все даты.** Ручной диапазон может пересечься с будущими автоматическими номерами; последовательность `store_order_doc_seq` нужно двигать вперёд.
- **Клиентские зеркала.** Правка формулы только на сервере или только в клиенте — регресс предпросмотра; менять обе стороны и сверять цифры.
- **Магазин и себестоимость.** Не добавлять `cost`/`avg_cost` в store-эндпоинты и не показывать переключатель себестоимости в store-режиме.
- **Локальная БД — копия прода.** Не запускать разрушительные эксперименты без бэкапа.

---

## Задача 0: Рабочая ветка и честная проверка

**Files:**
- Modify: `server/package.json`
- Create: `server/test/units.pure.test.ts`
- Create: `server/test/delivery-rule.pure.test.ts`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `toBaseCross`, `convertAcross` из `server/src/services/expansion.ts`; `deliveryRuleInput` из `server/src/services/delivery-rule.ts`.
- Produces: работоспособная команда `npm test`; CI-гейт, блокирующий деплой при падении тестов.

- [ ] **Шаг 0.1: Создать ветку и зафиксировать текущую WIP-работу**

```bash
cd A:/projects/shop_mrct
git switch -c fix/crm-audit
git add client/src/app/core/api.service.ts client/src/app/core/models.ts \
  client/src/app/orders/report.component.css client/src/app/orders/report.component.html \
  client/src/app/orders/report.component.ts server/src/routes/orders.ts \
  server/src/services/order-report.ts
git commit -m "wip(orders): настройки отчёта, PDV, вес и нумерация"
```

- [ ] **Шаг 0.2: Написать падающие тесты единиц**

`server/test/units.pure.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBaseCross, convertAcross } from '../src/services/expansion';
import { ApiError } from '../src/http';

const units = new Map<number, { dimension: string; factor: number }>([
  [1, { dimension: 'mass', factor: 1 }],
  [2, { dimension: 'volume', factor: 1 }],
  [3, { dimension: 'count', factor: 1 }],
]);

test('шт → г по g_per_pcs', () => {
  const conv = { gPerPcs: 50, mlPerPcs: null, gPerMl: null };
  assert.equal(toBaseCross(10, 3, 1, units, conv), 500);
});

test('г → шт обратно', () => {
  const conv = { gPerPcs: 50, mlPerPcs: null, gPerMl: null };
  assert.equal(toBaseCross(500, 1, 3, units, conv), 10);
});

test('г → мл через плотность', () => {
  const conv = { gPerPcs: null, mlPerPcs: null, gPerMl: 1.03 };
  assert.equal(Math.round(convertAcross('mass', 'volume', 1000, conv) * 100) / 100, 970.87);
});

test('без коэффициента — ApiError 400', () => {
  assert.throws(
    () => toBaseCross(1, 3, 1, units, null),
    (e: unknown) => e instanceof ApiError && e.status === 400
  );
});
```

`server/test/delivery-rule.pure.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryRuleInput } from '../src/services/delivery-rule';

test('правило: дубликаты убираются, порядок по возрастанию', () => {
  assert.deepEqual(deliveryRuleInput({ weekdays: [5, 1, 5], monthDays: [31, 1, 15] }), {
    weekdays: [1, 5],
    monthDays: [1, 15, 31],
  });
});

test('правило: пустые списки — выключено', () => {
  assert.deepEqual(deliveryRuleInput({ weekdays: [], monthDays: [] }), { weekdays: [], monthDays: [] });
});

test('правило: день недели 8 отклоняется', () => {
  assert.throws(() => deliveryRuleInput({ weekdays: [8], monthDays: [] }));
});

test('правило: отсутствие поля отклоняется', () => {
  assert.throws(() => deliveryRuleInput({ weekdays: [1] }));
});
```

- [ ] **Шаг 0.3: Убрать из скриптов отсутствующие файлы**

В `server/package.json` заменить блок тестовых скриптов на:

```json
"test": "node --import tsx --test test/units.pure.test.ts test/delivery-rule.pure.test.ts",
"test:pure": "npm test"
```

Скрипты `test:fake`, `test:integration`, `test:all` удалить: соответствующих файлов в репозитории нет, и они создают ложное впечатление покрытия. Файл `test/report-numbering.pure.test.ts` будет добавлен в скрипт в Задаче 2, шаг 2.8.

- [ ] **Шаг 0.4: Прогнать тесты**

Run: `cd server && npm test`
Expected: 8 тестов PASS (4 в `units.pure` + 4 в `delivery-rule.pure`).

- [ ] **Шаг 0.5: Добавить тесты в CI перед сборкой**

В `.github/workflows/deploy.yml`, в job `build`, после шага «Сервер — зависимости и сборка»:

```yaml
      - name: Сервер — тесты
        working-directory: server
        run: npm test
```

- [ ] **Шаг 0.6: Коммит**

```bash
git add server/package.json server/test .github/workflows/deploy.yml
git commit -m "test: восстановить запускаемый набор тестов и гейт в CI"
```

---

## Задача 1: Поднять локальный контур

**Files:**
- Modify: `server/.env` (локально, не коммитить)
- Create: `.devtools/start-db.ps1` (локальный, gitignored)

**Interfaces:**
- Consumes: данные PostgreSQL в `.devtools/data` (`PG_VERSION` = 18) или `docker-compose.yml`.
- Produces: доступные `:5432` и `:4000`; зелёный `GET /api/health`.

- [ ] **Шаг 1.1: Определить способ запуска БД**

На машине нет Docker и сервиса PostgreSQL, но есть каталог данных `.devtools/data` версии 18. Установить PostgreSQL 18 (или portable-сборку) и запускать её на этом каталоге.

- [ ] **Шаг 1.2: Запустить PostgreSQL и проверить порт**

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D "A:\projects\shop_mrct\.devtools\data" `
  -l "A:\projects\shop_mrct\.devtools\pg.log" start
& "C:\Program Files\PostgreSQL\18\bin\pg_isready.exe" -h 127.0.0.1 -p 5432
```

Expected: `accepting connections`.

- [ ] **Шаг 1.3: Запустить API и проверить health**

```bash
cd A:/projects/shop_mrct/server
npm run dev
```

В другом терминале:

```bash
curl -s http://127.0.0.1:4000/api/health
```

Expected: `{"ok":true,"service":"mixmarkt-crm"}`. Если старт падает на `init.sql` — это подтверждение риска P2 из таблицы; выполнять Задачу 5 до дальнейших проверок.

- [ ] **Шаг 1.4: Проверить инварианты склада (read-only)**

```sql
select s.product_id, p.name, s.qty, coalesce(sum(m.qty), 0) as mov
  from stock s
  join products p on p.id = s.product_id
  left join movements m on m.product_id = s.product_id
 group by s.product_id, p.name, s.qty
having abs(s.qty - coalesce(sum(m.qty), 0)) > 0.001;

select s.product_id, p.name, s.qty
  from stock s join products p on p.id = s.product_id
 where s.qty < 0;

select doc_no, count(*) from store_orders
 where doc_no is not null group by doc_no having count(*) > 1;
```

Expected: все три запроса — 0 строк. Если есть расхождения — зафиксировать в задаче, но не «чинить» данные без бэкапа.

---

## Задача 2: Перенумерация отчётов — корректность и старые номера

**Files:**
- Create: `server/src/services/report-numbering.ts`
- Create: `server/test/report-numbering.pure.test.ts`
- Modify: `server/src/routes/orders.ts:54-137`
- Modify: `server/src/services/order-report.ts` (`ReportDoc`, формирование `number`)
- Modify: `client/src/app/core/models.ts` (`ReportDoc.docNo`)
- Modify: `client/src/app/orders/report.component.ts` (`firstIndex`, `lastIndex`, `applyNumbering`, prefill)

**Interfaces:**
- Produces:
  - `planDocNumbers(count: number, startIndex: number): number[]`
  - `docNumber(deliveryDate: string, docNo: number | null, orderId: number): string`
  - `ReportDoc.docNo: number | null` в серверном и клиентском типах.

- [ ] **Шаг 2.1: Написать падающие тесты**

`server/test/report-numbering.pure.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { planDocNumbers, docNumber } from '../src/services/report-numbering';
import { ApiError } from '../src/http';

test('planDocNumbers: последовательные номера', () => {
  assert.deepEqual(planDocNumbers(3, 844), [844, 845, 846]);
});

test('planDocNumbers: выход за 999999 запрещён', () => {
  assert.throws(
    () => planDocNumbers(3, 999998),
    (e: unknown) => e instanceof ApiError && e.status === 400
  );
});

test('docNumber: сквозной номер', () => {
  assert.equal(docNumber('2026-11-18', 843, 17), '2026-843');
});

test('docNumber: старый заказ без номера сохраняет прежний вид', () => {
  assert.equal(docNumber('2026-11-18', null, 17), '2026-17');
});
```

- [ ] **Шаг 2.2: Убедиться, что тесты падают**

Run: `cd server && npx tsx --test test/report-numbering.pure.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Шаг 2.3: Реализовать чистый модуль**

`server/src/services/report-numbering.ts`:

```ts
import { ApiError } from '../http';

export const MAX_DOC_INDEX = 999999;

/** Последовательные номера для count документов начиная с startIndex. */
export function planDocNumbers(count: number, startIndex: number): number[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new ApiError(400, 'Нет документов для нумерации');
  }
  if (!Number.isInteger(startIndex) || startIndex <= 0 || startIndex > MAX_DOC_INDEX) {
    throw new ApiError(400, `startIndex: требуется целое число 1…${MAX_DOC_INDEX}`);
  }
  if (startIndex + count - 1 > MAX_DOC_INDEX) {
    throw new ApiError(400, `Диапазон номеров выходит за ${MAX_DOC_INDEX}`);
  }
  return Array.from({ length: count }, (_, i) => startIndex + i);
}

/** Печатный номер: год-номер; старый заказ без doc_no сохраняет вид год-id. */
export function docNumber(deliveryDate: string, docNo: number | null, orderId: number): string {
  return `${deliveryDate.slice(0, 4)}-${docNo ?? orderId}`;
}
```

- [ ] **Шаг 2.4: Прогнать тесты**

Run: `cd server && npx tsx --test test/report-numbering.pure.test.ts`
Expected: 4 теста PASS.

- [ ] **Шаг 2.5: Переписать маршрут нумерации в одну транзакцию с блокировкой и двумя фазами**

Заменить тело `ordersRouter.put('/report/numbering', …)` на:

```ts
ordersRouter.put(
  '/report/numbering',
  wrap(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const date = String(raw.date ?? '');
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new ApiError(400, 'date: требуется дата в формате YYYY-MM-DD');
    }
    const startIndex = Number(raw.startIndex);

    const client = await pool.connect();
    try {
      await client.query('begin');
      // 1) сериализуем перенумерации даты и фиксируем порядок строк
      await client.query(
        `select 1 from store_orders o
          where o.delivery_date = $1::date
            and exists (select 1 from store_order_items i where i.order_id = o.id)
          order by o.id
          for update of o`,
        [date]
      );

      const { rows } = await client.query<{ id: number; code: string }>(
        `select o.id, s.code
           from store_orders o
           join stores s on s.id = o.store_id
          where o.delivery_date = $1::date
            and exists (select 1 from store_order_items i where i.order_id = o.id)
          order by s.code, o.id`,
        [date]
      );
      if (!rows.length) throw new ApiError(404, 'На эту дату нет документов для нумерации');

      const targets = planDocNumbers(rows.length, startIndex);
      const ids = rows.map((r) => r.id);
      const { rows: conflicts } = await client.query<{ docNo: string }>(
        `select doc_no as "docNo"
           from store_orders
          where doc_no = any($1::bigint[])
            and not (id = any($2::int[]))`,
        [targets, ids]
      );
      if (conflicts.length) {
        throw new ApiError(409, `Индекс пересекается с другими документами: ${conflicts.map((c) => c.docNo).join(', ')}`);
      }

      // 2) две фазы: временные уникальные отрицательные, затем целевые.
      //    Одна фаза падает на 23505 при сдвиге вперёд (843,844 -> 844,845).
      for (const r of rows) {
        await client.query('update store_orders set doc_no = $2 where id = $1', [r.id, -(1_000_000 + r.id)]);
      }
      for (let i = 0; i < rows.length; i++) {
        await client.query('update store_orders set doc_no = $2 where id = $1', [rows[i].id, targets[i]]);
      }

      // 3) следующий автоматический номер не должен пересечься с ручным диапазоном
      await client.query(
        `select setval('store_order_doc_seq', greatest((select last_value from store_order_doc_seq), $1::bigint), true)`,
        [targets[targets.length - 1]]
      );

      // 4) аудит — в той же транзакции, чтобы повтор не перенумеровывал дважды
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'store_order',
        entityId: date,
        title: `Нумерация отчётов на ${date}`,
        details: { first: targets[0], last: targets[targets.length - 1], documents: rows.length },
      });
      await client.query('commit');

      res.json({ ok: true, first: targets[0], last: targets[targets.length - 1], documents: rows.length });
    } catch (e) {
      await client.query('rollback').catch(() => {});
      if ((e as { code?: string }).code === '23505') {
        throw new ApiError(409, 'Индекс уже занят другим документом');
      }
      throw e;
    } finally {
      client.release();
    }
  })
);
```

Добавить импорты: `import { planDocNumbers } from '../services/report-numbering';` и `auditTx` из `../services/audit` (рядом с существующим `audit`).

- [ ] **Шаг 2.6: Отдавать `docNo` отдельно от печатного номера**

В `server/src/services/order-report.ts`:

1. В интерфейс `ReportDoc` добавить:

```ts
  /** Числовая часть сквозного номера; null — старый документ без номера. */
  docNo: number | null;
```

2. При создании документа заменить формирование `number`:

```ts
        docNo: r.docNo === null ? null : Number(r.docNo),
        number: docNumber(r.deliveryDate, r.docNo === null ? null : Number(r.docNo), r.orderId),
```

3. Импортировать `docNumber` из `./report-numbering`.

- [ ] **Шаг 2.7: Обновить клиент**

В `client/src/app/core/models.ts` в `ReportDoc` добавить:

```ts
  /** Числовая часть сквозного номера; null — старый документ. */
  docNo: number | null;
```

В `client/src/app/orders/report.component.ts`:

1. Заменить `firstIndex`/`lastIndex` на вычисление по `docNo`:

```ts
  private docIndexes = computed(() =>
    this.documents()
      .map((d) => d.docNo)
      .filter((n): n is number => n != null)
  );
  /** Минимум/максимум реальных сквозных номеров; null — номеров нет. */
  firstIndex = computed(() => (this.docIndexes().length ? Math.min(...this.docIndexes()) : null));
  lastIndex = computed(() => (this.docIndexes().length ? Math.max(...this.docIndexes()) : null));
  /** В дате есть документы без сквозного номера — диапазон нельзя считать непрерывным. */
  hasLegacyDocs = computed(() => this.docIndexes().length !== this.documents().length);
```

2. Prefill делать только реальным номером:

```ts
          this.docIndexInput = report.documents[0]?.docNo ?? null;
```

3. В `applyNumbering()` до запроса добавить защиту от бессмысленного повтора:

```ts
    const indexes = this.docIndexes();
    const sorted = [...indexes].sort((a, b) => a - b);
    const contiguous =
      !this.hasLegacyDocs() &&
      sorted.length > 0 &&
      sorted.every((n, i) => n === sorted[0] + i);
    if (contiguous && start === sorted[0]) {
      this.indexNote.set('Номера уже совпадают — изменения не нужны');
      return;
    }
```

4. В шаблоне `report.component.html` показывать предупреждение о старых документах:

```html
        <small class="muted">
          @if (firstIndex() != null && lastIndex() != null) {
            Номера на дату: {{ docYear }}-{{ firstIndex() }} … {{ docYear }}-{{ lastIndex() }}
            @if (hasLegacyDocs()) { · есть документы без сквозного номера }
          } @else {
            Нет сквозных номеров — задайте первый индекс
          }
        </small>
```

- [ ] **Шаг 2.8: Добавить новый тест в `npm test`, собрать и проверить**

В `server/package.json`:

```json
"test": "node --import tsx --test test/units.pure.test.ts test/delivery-rule.pure.test.ts test/report-numbering.pure.test.ts",
"test:pure": "npm test"
```

```bash
cd server && npm run build && npm test
cd ../client && npm run build
```

Expected: сборки зелёные, все 12 тестов PASS.

- [ ] **Шаг 2.9: Проверить сценарий сдвига на локальной БД**

Подготовка (локальная копия): у даты два документа `843`, `844`. Запрос:

```bash
curl -s -X PUT http://127.0.0.1:4000/api/orders/report/numbering \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"date":"2026-11-18","startIndex":844}'
```

Expected: `{ "ok": true, "first": 844, "last": 845 }`, в БД номера `844` и `845`, без 409/500.

- [ ] **Шаг 2.10: Коммит**

```bash
git add server/src/services/report-numbering.ts server/test/report-numbering.pure.test.ts \
  server/src/routes/orders.ts server/src/services/order-report.ts \
  client/src/app/core/models.ts client/src/app/orders/report.component.ts \
  client/src/app/orders/report.component.html
git commit -m "fix(orders): двухфазная перенумерация и честный docNo старых документов"
```

---

## Задача 3: Отчёт — PDV, вес и настройки

**Files:**
- Modify: `client/src/app/orders/report.component.ts`
- Modify: `client/src/app/orders/report.component.html`
- Modify: `server/src/services/order-report.ts` (только комментарий/семантика веса)

**Interfaces:**
- Consumes: `ReportDoc.docNo`, `ReportDoc.weightKg` из Задачи 2.
- Produces: предсказуемое применение ставки, отсутствие утечки офисной ставки в store-режим, честная подпись веса.

- [ ] **Шаг 3.1: Применять PDV по потере фокуса**

В `report.component.html` заменить input ставки:

```html
          <input type="number" min="0" max="100" step="0.5" [(ngModel)]="vatInput"
                 (keydown.enter)="applyVat(vatInput)" (blur)="applyVat(vatInput)"
                 aria-label="Ставка налога, %" />
```

- [ ] **Шаг 3.2: Не запоминать 0 % молча**

В `applyVat()` заменить блок сохранения:

```ts
    if (rate === 0) {
      this.settingsErr.set('Ставка 0 % отключит PDV в документе — проверьте, что это намеренно');
    } else {
      this.settingsErr.set('');
    }
    this.vatInput = rate;
    if (this.vatRate() === rate) return;
    this.vatRate.set(rate);
    try {
      if (rate > 0) localStorage.setItem('report.vatRate', String(rate));
      else localStorage.removeItem('report.vatRate');
    } catch {
      /* приватный режим — просто не запоминаем */
    }
    this.load();
```

- [ ] **Шаг 3.3: Не читать офисную ставку в store-режиме**

В `ngOnInit()` обернуть чтение `localStorage`:

```ts
    if (!this.storeMode) {
      try {
        const raw = localStorage.getItem('report.vatRate');
        const saved = raw == null ? NaN : Number(raw);
        if (Number.isFinite(saved) && saved > 0 && saved <= 100) {
          this.vatRate.set(saved);
          this.vatInput = saved;
        }
      } catch {
        /* приватный режим — остаётся 20 % */
      }
    }
```

И заменить fallback:

```ts
  docVatRate = computed(() => this.documents()[0]?.vatRate ?? 20);
```

- [ ] **Шаг 3.4: Честно подписать вес**

В `report.component.html` заменить подпись плитки:

```html
          <span class="sum-label">Вес, кг (кроме штучных)</span>
```

В `order-report.ts` уточнить комментарий:

```ts
    // Вес считаем только для весовых и объёмных позиций (1 л ≈ 1 кг).
    // Для штучных техкарт вес упаковки не хранится, поэтому 0 — не «нет товара», а «нет данных».
    const weightKg = r.dimension === 'count' ? 0 : Math.round(r.qty * r.qtyBase) / 1000;
```

- [ ] **Шаг 3.5: Проверить вручную в браузере**

Открыть `http://127.0.0.1:4200/orders/report?date=…` офисом:
1. Ввести `7,5` в ставку и кликнуть в сторону — сумма PDV меняется на 7,5 %.
2. Ввести `0`, применить — появляется предупреждение, ставка не сохраняется после перезагрузки.
3. Войти магазином — блока настроек нет, ставка в документах `20`.

- [ ] **Шаг 3.6: Сборка и коммит**

```bash
cd client && npm run build
cd .. && git add client/src/app/orders/report.component.ts client/src/app/orders/report.component.html server/src/services/order-report.ts
git commit -m "fix(orders): PDV по blur, защита от 0 % и честная подпись веса"
```

---

## Задача 4: Транзакционная безопасность склада, накладных и заказов

**Files:**
- Modify: `server/src/routes/waybills.ts` (`ingestWaybill`)
- Modify: `server/src/routes/store.ts` (`PUT /orders/current`)
- Modify: `server/src/routes/import.ts` (`confirmImport`, алиасы)
- Modify: `server/src/http.ts` (маппинг 23505, опционально)

**Interfaces:**
- Consumes: `applyMovement`, `ApiError`, `tx`.
- Produces: детерминированный порядок блокировок; 409 вместо 500 на дублях; проверка фасовок внутри транзакции; алиас не перепривязывается.

- [ ] **Шаг 4.1: Движения накладной — в порядке product_id**

В `ingestWaybill` собрать движения и применить их отсортированными:

```ts
  const moves: { productId: number; qtyBase: number; costBase: number }[] = [];
  for (const it of items) {
    if (it.qty <= 0) throw new ApiError(400, 'Количество должно быть > 0');
    const u = units.get(it.unitId);
    if (!u) throw new ApiError(400, `Единица #${it.unitId} не найдена — приход только в базовых единицах (г/мл/шт)`);
    if (u.factor !== 1) throw new ApiError(400, `Приход в «${it.unitId}» запрещён: хранение только в базовых (г/мл/шт)`);
    // базовая единица продукта + коэффициенты пересчёта размерностей
    const { rows: pr } = await client.query(
      'select unit_id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from products where id = $1',
      [it.productId]
    );
    if (!pr.length) throw new ApiError(400, `Продукт #${it.productId} не найден`);
    const conv: ProdConv = {
      gPerPcs: pr[0].gp == null ? null : Number(pr[0].gp),
      mlPerPcs: pr[0].mp == null ? null : Number(pr[0].mp),
      gPerMl: pr[0].gm == null ? null : Number(pr[0].gm),
    };
    const qtyBase = toBaseCross(it.qty, it.unitId, pr[0].unit_id, units, conv);
    // себестоимость за каноничную базовую единицу — из денег строки
    const money = it.qty * (it.price ?? 0);
    const costBase = qtyBase > 0 ? money / qtyBase : 0;
    const vatAmount = round2((money * (it.vatRate ?? 0)) / 100);

    await client.query(
      'insert into waybill_items (waybill_id, product_id, qty, unit_id, price, vat_rate, vat_amount) values ($1,$2,$3,$4,$5,$6,$7)',
      [waybillId, it.productId, it.qty, it.unitId, it.price ?? 0, it.vatRate ?? null, vatAmount]
    );
    moves.push({ productId: it.productId, qtyBase, costBase });
  }

  // Склад блокируем в детерминированном порядке — против дедлоков между накладными.
  for (const m of [...moves].sort((a, b) => a.productId - b.productId)) {
    await applyMovement(client, {
      productId: m.productId,
      type: 'receipt',
      delta: m.qtyBase,
      unitCost: m.costBase,
      docType: 'waybill',
      docId: waybillId,
      comment: `Приход по накладной №${head.number}`,
      actor: head.actor ?? null,
    });
  }
```

Удалить прежний вызов `applyMovement` из цикла строк: движения применяются только вторым, отсортированным циклом.

- [ ] **Шаг 4.2: Дубль номера накладной — 409, а не 500**

Обернуть вставку шапки:

```ts
  let wb;
  try {
    wb = await client.query(
      `insert into waybills (number, supplier, doc_date, file_name, stored_file, file_data, file_mime, extra_files,
                             currency, supplier_pib, total_net, total_vat, total_gross,
                             doc_total_net, doc_total_vat, doc_total_gross,
                             accepted_by, accepted_login, accepted_at)
       values ($1, $2, coalesce($3::date, current_date), $4, $5, $6, $7, $8,
               coalesce($9, 'RSD'), $10, $11, $12, $13, $14, $15, $16,
               $17, $18, now())
       returning id`,
      [
        head.number, head.supplier, head.docDate, head.fileName ?? null, head.storedFile ?? null,
        head.fileData ?? null, head.fileMime ?? null,
        extras ? JSON.stringify(extras) : null,
        head.currency ?? null, head.supplierPib ?? null,
        round2(totalNet), round2(totalVat), round2(round2(totalNet) + round2(totalVat)),
        head.docTotalNet ?? null, head.docTotalVat ?? null, head.docTotalGross ?? null,
        head.actor?.id ?? null, head.actor?.login ?? null,
      ]
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new ApiError(409, `Накладная №${head.number} уже проведена — документы с одним номером принимать нельзя`);
    }
    throw e;
  }
```

- [ ] **Шаг 4.3: Проверять фасовки внутри транзакции заказа**

В `store.ts`, в колбэке `tx` обработчика `PUT /orders/current`, перед `delete from store_order_items`:

```ts
      const { rows: availableInTx } = await client.query<{ id: number }>(
        'select id from product_packagings where available and id = any($1::int[]) for share',
        [ids]
      );
      if (availableInTx.length !== ids.length) {
        throw new ApiError(400, 'Часть позиций больше не доступна для заказа');
      }
```

Внешнюю проверку можно оставить как быстрый отказ, но она больше не является гарантией.

- [ ] **Шаг 4.4: Алиас не должен перепривязываться к другому товару**

В `confirmImport` заменить upsert:

```ts
      const inserted = await client.query(
        `insert into product_aliases (product_id, alias, alias_raw) values ($1, $2, $3)
         on conflict (alias) do nothing
         returning product_id`,
        [productId, alias, rawName.trim()]
      );
      if (inserted.rowCount) aliasesSaved++;
```

Удалить предварительный `select 1 from product_aliases where alias = $1` — он больше не нужен. Если нужно предупреждение о конфликте, сравнить `inserted.rowCount === 0` с `select product_id from product_aliases where alias = $1` и добавить запись в лог импорта, не меняя привязку.

- [ ] **Шаг 4.5: Сборка и проверки**

```bash
cd server && npm run build && npm test
```

Проверки на локальной БД:
1. Две накладные с одинаковым номером, отправленные параллельно (два curl), — одна 201, вторая 409.
2. Накладная из 3+ строк — movements в порядке возрастания `product_id`; повтор под нагрузкой не даёт 500.
3. Заказ магазина: пометить фасовку `available=false` между проверкой и сохранением (вторая сессия) — сохранение даёт 400, не 500.
4. Импорт: подтвердить строку с уже известным алиасом другого товара — `product_aliases.product_id` не меняется.

- [ ] **Шаг 4.6: Коммит**

```bash
git add server/src/routes/waybills.ts server/src/routes/store.ts server/src/routes/import.ts
git commit -m "fix(server): порядок блокировок, 409 на дублях, проверки в транзакции и безопасные алиасы"
```

---

## Задача 5: `init.sql` не должен ронять production

**Files:**
- Modify: `server/sql/init.sql` (начало файла, бэкфилл `doc_no`, уникальный индекс накладных)
- Modify: `server/src/init-db.ts` (только комментарий/сообщение, если нужно)

**Interfaces:**
- Produces: таблица `schema_migrations(name text primary key, applied_at timestamptz)`; безопасное создание уникального индекса; одноразовые бэкфиллы.

- [ ] **Шаг 5.1: Добавить реестр миграций**

В начало `init.sql`, после `create extension if not exists pg_trgm;`:

```sql
-- Реестр одноразовых бэкфиллов: init.sql выполняется при каждом старте,
-- но data-миграции должны применяться ровно один раз.
create table if not exists schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
```

- [ ] **Шаг 5.2: Защитить бэкфилл `doc_no`**

Заменить `do $$ … backfill … $$;` (строки ~564-575) на:

```sql
do $$
declare r record;
begin
  if exists (select 1 from schema_migrations where name = 'backfill_doc_no_843') then
    return;
  end if;

  for r in
    select id
      from store_orders
     where doc_no is null and delivery_date >= current_date
     order by delivery_date, store_id, id
  loop
    update store_orders set doc_no = nextval('store_order_doc_seq') where id = r.id;
  end loop;

  insert into schema_migrations (name) values ('backfill_doc_no_843')
  on conflict (name) do nothing;
end $$;
```

- [ ] **Шаг 5.3: Создавать уникальный индекс без риска падения старта**

Заменить строку:

```sql
create unique index if not exists waybills_number_active_uniq on waybills (btrim(number)) where status <> 'reversed';
```

на:

```sql
do $$
begin
  if not exists (select 1 from pg_class where relname = 'waybills_number_active_uniq') then
    begin
      execute 'create unique index waybills_number_active_uniq
                 on waybills (btrim(number)) where status <> ''reversed''';
    exception when unique_violation then
      raise warning 'waybills_number_active_uniq не создан: в данных есть дубли номеров. Устраните дубли и перезапустите.';
    end;
  end if;
end $$;
```

Если индекс не создан, приложение продолжает работать (код всё равно проверяет дубли), а старт не падает.

- [ ] **Шаг 5.4: Проверить идемпотентность на тестовой БД**

```bash
createdb -h 127.0.0.1 -U postgres mixmarkt_init_test
psql -h 127.0.0.1 -U postgres -d mixmarkt_init_test -v ON_ERROR_STOP=1 -f server/sql/init.sql
psql -h 127.0.0.1 -U postgres -d mixmarkt_init_test -v ON_ERROR_STOP=1 -f server/sql/init.sql
```

Expected: оба запуска завершаются без ошибок; во втором нет повторного бэкфилла (`select count(*) from schema_migrations` = 1).

Проверка деградации: вставить две накладные с одинаковым номером и `status='posted'` в чистую БД, затем выполнить `init.sql` — ожидается WARNING, но не ошибка.

- [ ] **Шаг 5.5: Коммит**

```bash
git add server/sql/init.sql server/src/init-db.ts
git commit -m "fix(sql): реестр миграций и безопасное создание индексов при старте"
```

---

## Задача 6: Отображение знака, cookie и README

**Files:**
- Modify: `client/src/app/core/format.ts`
- Modify: `client/src/app/pages/stock.component.ts:114`
- Modify: `client/src/app/pages/dashboard.component.ts:147`
- Modify: `server/src/services/auth.ts`
- Modify: `server/.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `fmtQty(baseQty, unitCode, signed = false)`; cookie с `Secure` при `COOKIE_SECURE=true`.

- [ ] **Шаг 6.1: Показывать минус у отрицательных количеств**

`format.ts`:

```ts
export function fmtQty(baseQty: number, unitCode: string, signed = false): string {
  const abs = Math.abs(baseQty);
  const sign = signed && baseQty < 0 ? '−' : '';
  if (unitCode === 'г') {
    return abs >= 1000 ? `${sign}${trim(abs / 1000)} кг` : `${sign}${trim(abs)} г`;
  }
  if (unitCode === 'мл') {
    return abs >= 1000 ? `${sign}${trim(abs / 1000)} л` : `${sign}${trim(abs)} мл`;
  }
  return `${sign}${trim(abs)} ${unitCode}`;
}
```

В `stock.component.ts:114` и `dashboard.component.ts:147` передать третий аргумент `true`:

```html
{{ m.qty > 0 ? '+' : '' }}{{ fmtQty(m.qty, m.unitCode, true) }}
```

- [ ] **Шаг 6.2: Добавить Secure для cookie**

`server/src/services/auth.ts`:

```ts
const cookieSecure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionDays * 24 * 60 * 60}${cookieSecure}`;
```

и в `clearSessionCookie`:

```ts
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure}`);
```

В `server/.env.example` добавить:

```dotenv
# Выставлять флаг Secure у cookie сессии (включать на production за HTTPS)
COOKIE_SECURE=false
```

- [ ] **Шаг 6.3: Обновить README**

Добавить в раздел возможностей и API то, что уже есть в коде: заказы магазинов и окно приёма, отчёты-отгрузки с PDV и нумерацией, поставщики и оцифрованные документы (склад не трогают), авторизация и роли офис/магазин, аудит, Google Sheets только на чтение. Убрать утверждения, которых нет в коде. Не переписывать весь документ — только разделы, вводящие в заблуждение.

- [ ] **Шаг 6.4: Сборка и коммит**

```bash
cd client && npm run build
cd ../server && npm run build
cd .. && git add client/src/app/core/format.ts client/src/app/pages/stock.component.ts \
  client/src/app/pages/dashboard.component.ts server/src/services/auth.ts server/.env.example README.md
git commit -m "fix(ui): знак количества, Secure cookie и актуальный README"
```

---

## Задача 7: Финальная проверка перед релизом

**Files:**
- No changes.

**Interfaces:**
- Consumes: результаты Задач 0–6.
- Produces: доказательства работоспособности и список непроверенного.

- [ ] **Шаг 7.1: Полная сборка и тесты**

```bash
cd A:/projects/shop_mrct/server && npm run build && npm test
cd ../client && npm run build
```

Expected: обе сборки PASS, все тесты PASS.

- [ ] **Шаг 7.2: Двойной старт сервера**

```bash
cd server && npm start
# остановить, затем снова
npm start
```

Expected: оба старта успешны; второй не падает на `init.sql`.

- [ ] **Шаг 7.3: Проверка ролей**

Офис:
- `/api/orders/report?date=…` возвращает документы и `docNo`.
- Перенумерация вперёд (`844` при существующих `843,844`) возвращает 200 и номера `844,845`.
- Ставка PDV `7,5` применяется после blur.

Магазин:
- `/api/store` отдаёт только свою точку.
- `/api/stock` и `/api/orders` → 403.
- `/api/store/orders/report` не содержит `cost`/`avgCost`, PDV всегда 20.

- [ ] **Шаг 7.4: Инварианты БД**

Повторить три SQL-запроса из Шага 1.4. Дополнительно:

```sql
select count(*) from store_orders o
 where not exists (select 1 from store_order_items i where i.order_id = o.id);

select count(*) from product_packagings
 where price <= 0 or cost <= 0;
```

Expected: 0 строк (нулевые цены допустимы только если бизнес это подтвердил; зафиксировать решение).

- [ ] **Шаг 7.5: Отчёт о результате**

Сообщить: какие файлы изменены, какие проверки выполнены фактически, что не проверено (например, откат реальной накладной на живых данных) и что пуш в `main` не выполнялся без разрешения.

---

## Порядок выполнения

1. Задача 0 — без неё нельзя доказать, что остальное не сломано.
2. Задача 1 — локальный контур; если БД поднять нельзя, Задачи 2–4 проверяются только сборкой и код-ревью, о чём нужно честно сообщить.
3. Задача 2 — P0-дефект и основа для UI-нумерации.
4. Задача 3 — отчёт в целом.
5. Задача 4 — транзакционная безопасность.
6. Задача 5 — защита production от падения на старте; выполнять до любого релиза.
7. Задачи 6–7 — полировка и доказательства.

## Явно не входит в план

- Миграция на Supabase или смена хостинга.
- Добавление снимка цен в Otpremnica (меняет бизнес-модель отчёта — требует отдельного решения владельца).
- Массовая чистка исторических данных склада.
- Пересборка всех тестов склада с фейковой БД — в репозитории нет соответствующей инфраструктуры, а создание полноценного набора — отдельная задача.
