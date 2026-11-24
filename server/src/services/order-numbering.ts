/**
 * Сквозная нумерация отчётов-отгрузок (Otpremnica).
 *
 * Номер выдаётся один раз из последовательности store_order_doc_seq и дальше
 * не меняется: повторное сохранение заказа, перестройка отчёта и перестановка
 * строк его не трогают. Нумеруются только заказы на сегодня и вперёд — у старых
 * заказов без номера остаётся прежний вид «год-id».
 */
import type { PoolClient } from 'pg';
import { tx } from '../db';

/** Выдаёт номера перечисленным заказам в заданном порядке; уже выданные пропускает. */
async function assignDocNumbers(client: PoolClient, ids: number[]): Promise<number> {
  let assigned = 0;
  for (const id of ids) {
    const { rowCount } = await client.query(
      `update store_orders
          set doc_no = nextval('store_order_doc_seq')
        where id = $1 and doc_no is null`,
      [id]
    );
    if (rowCount) assigned++;
  }
  return assigned;
}

/** Номер при сохранении заказа магазином: один раз, только на сегодня и вперёд. */
export async function assignOrderDocNumber(client: PoolClient, orderId: number): Promise<boolean> {
  const { rowCount } = await client.query(
    `update store_orders
        set doc_no = nextval('store_order_doc_seq')
      where id = $1 and doc_no is null and delivery_date >= current_date`,
    [orderId]
  );
  return Boolean(rowCount);
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
    const { rows } = await client.query<{ id: number }>(
      `select o.id
         from store_orders o
         join stores s on s.id = o.store_id
        where o.delivery_date = $1::date
          and o.delivery_date >= current_date
          and o.doc_no is null
        order by s.code, o.id
          for update of o`,
      [deliveryDate]
    );
    return assignDocNumbers(client, rows.map((row) => row.id));
  });
}

/**
 * Номера для всех будущих заказов без doc_no — после импорта Google-таблицы.
 * Порядок: дата доставки, код магазина, id. Выполняется в транзакции импорта.
 */
export async function ensureFutureDocNumbers(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `select o.id
       from store_orders o
       join stores s on s.id = o.store_id
      where o.doc_no is null
        and o.delivery_date >= current_date
      order by o.delivery_date, s.code, o.id`
  );
  return assignDocNumbers(client, rows.map((row) => row.id));
}
