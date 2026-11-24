/**
 * Нумерация отчётов-отгрузок (Otpremnica): порядковый номер внутри года.
 *
 * Год берётся из delivery_date, поэтому заказ на январь 2027, оформленный
 * в декабре 2026, сразу получает 2027-1. Счётчик года хранится в doc_counters
 * и увеличивается в той же транзакции, что и запись номера: откат транзакции
 * откатывает и номер, поэтому дыр в нумерации не остаётся.
 *
 * Номер выдаётся один раз: повторное сохранение, перестройка отчёта и
 * перестановка строк его не меняют. Старые заказы без номера сохраняют
 * прежний вид «год-id» в отчёте.
 */
import type { PoolClient } from 'pg';
import { tx } from '../db';

/** Следующий номер для года: атомарный upsert строки счётчика. */
async function nextDocNo(client: PoolClient, year: number): Promise<number> {
  const { rows } = await client.query<{ last_no: string }>(
    `insert into doc_counters (doc_year, last_no)
     values ($1, 1)
     on conflict (doc_year) do update
       set last_no = doc_counters.last_no + 1,
           updated_at = now()
     returning last_no`,
    [year]
  );
  return Number(rows[0].last_no);
}

/** Выдать номера перечисленным заказам в заданном порядке; уже выданные пропускает. */
async function assignDocNumbers(
  client: PoolClient,
  rows: { id: number; doc_year: number }[]
): Promise<number> {
  let assigned = 0;
  for (const row of rows) {
    const docNo = await nextDocNo(client, Number(row.doc_year));
    const { rowCount } = await client.query(
      `update store_orders
          set doc_no = $2, doc_year = $3
        where id = $1 and doc_no is null`,
      [row.id, docNo, row.doc_year]
    );
    if (!rowCount) {
      // Заказ уже получил номер параллельно — откатываем и счётчик, и весь транш.
      throw new Error(`Заказ #${row.id} уже получил номер`);
    }
    assigned++;
  }
  return assigned;
}

/** Номер при сохранении заказа магазином: один раз, только на сегодня и вперёд. */
export async function assignOrderDocNumber(client: PoolClient, orderId: number): Promise<boolean> {
  const { rows } = await client.query<{ doc_year: number }>(
    `select extract(year from delivery_date)::int as doc_year
       from store_orders
      where id = $1
        and doc_no is null
        and delivery_date >= current_date
      for update`,
    [orderId]
  );
  if (!rows.length) return false;
  await assignDocNumbers(client, [{ id: orderId, doc_year: Number(rows[0].doc_year) }]);
  return true;
}

/**
 * Номера для всех заказов даты доставки — в порядке печати документов
 * (код магазина, затем id). Вызывается при построении отчёта; строки
 * блокируются, чтобы параллельная печать не выдала номер дважды.
 * Нумеруется вся дата целиком, даже если отчёт открыт по одному магазину:
 * иначе выданный раньше номер сломал бы порядок печати.
 */
export async function ensureDeliveryDocNumbers(deliveryDate: string): Promise<number> {
  return tx(async (client) => {
    const { rows } = await client.query<{ id: number; doc_year: number }>(
      `select o.id, extract(year from o.delivery_date)::int as doc_year
         from store_orders o
         join stores s on s.id = o.store_id
        where o.delivery_date = $1::date
          and o.delivery_date >= current_date
          and o.doc_no is null
        order by s.code, o.id
          for update of o`,
      [deliveryDate]
    );
    return assignDocNumbers(client, rows.map((row) => ({ id: Number(row.id), doc_year: Number(row.doc_year) })));
  });
}

/**
 * Номера для всех будущих заказов без номера — после импорта Google-таблицы.
 * Порядок: дата доставки, код магазина, id. Выполняется в транзакции импорта.
 */
export async function ensureFutureDocNumbers(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ id: number; doc_year: number }>(
    `select o.id, extract(year from o.delivery_date)::int as doc_year
       from store_orders o
       join stores s on s.id = o.store_id
      where o.doc_no is null
        and o.delivery_date >= current_date
      order by o.delivery_date, s.code, o.id`
  );
  return assignDocNumbers(client, rows.map((row) => ({ id: Number(row.id), doc_year: Number(row.doc_year) })));
}