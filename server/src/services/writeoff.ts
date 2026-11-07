/**
 * Автосписание заказов со склада по расписанию.
 *
 * В заданный слот (день недели + время по MSK) берём ВСЕ непустые строки доски за дату
 * доставки (date_tab) с привязанной техкартой, группируем по card_id, переводим граммы
 * в порции (sum(quantity) / portion_qty) и гасим через postBatch — он раскрывает техкарту
 * в чистое сырьё (через заготовки, с учётом уварки/граммовки) и списывает со склада.
 *
 * Идемпотентность двуслойная:
 *  • writeoff_runs unique(delivery_date, fired_slot) — один прогон на слот;
 *  • orders.written_off_at — строка списывается ровно один раз.
 * Ошибка по одной карточке (например недостача сырья) не блокирует прочие: каждая карточка
 * проводится в своей транзакции, а прогон помечается 'error' с деталями в raw.
 */
import { pool, tx } from '../db';
import { postBatch } from '../routes/batches';
import type { Actor } from './audit';
import { writeoffSettings, deliverySettings, type WriteoffSettings } from './settings';
import { mskNow, type TzNow } from './tz';
import { nextDeliveryDate } from './delivery';

// часы по таймзоне живут в tz (общий для delivery/sheet-tabs); реэкспорт — прежние импортеры
export { mskNow } from './tz';
export type { TzNow } from './tz';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Пора ли гасить списание в этот момент? */
export function isSlotDue(now: TzNow, cfg: WriteoffSettings): boolean {
  return cfg.enabled && cfg.dates.includes(now.dateIso) && now.hhmm === cfg.time;
}

/** Ближайший срабатывающий слот для превью на странице настроек. */
export function nextDue(cfg: WriteoffSettings, at: Date = new Date()): { dateIso: string; time: string } | null {
  if (!cfg.enabled || !cfg.dates.length || !cfg.time) return null;
  const now = mskNow(cfg.tz, at);
  if (cfg.dates.includes(now.dateIso)) {
    if (cfg.time > now.hhmm) return { dateIso: now.dateIso, time: cfg.time };
  }
  const futureDates = cfg.dates.filter((d) => d > now.dateIso);
  if (futureDates.length > 0) {
    return { dateIso: futureDates[0], time: cfg.time };
  }
  return null;
}

export interface WriteOffResult {
  skipped: boolean;
  runId: number | null;
  linesWritten: number;
  batches: number;
  raw: Record<string, unknown>;
  error?: string;
}

/**
 * Прогон списания за дату доставки в указанный слот.
 * Вызывается и планировщиком (firedSlot = 'HH:MM'), и ручной кнопкой (firedSlot = 'manual-…').
 */
export async function runWriteOff(
  deliveryDate: string,
  firedSlot: string,
  actor: Actor,
  runTx: typeof tx = tx
): Promise<WriteOffResult> {
  // 1) занимаем слот: конфликт => этот слот уже гасили, ничего не делаем
  const claimed = await runTx(async (client) => {
    const { rows } = await client.query(
      `insert into writeoff_runs (delivery_date, fired_slot, status, created_by)
       values ($1::date, $2, 'running', $3)
       on conflict (delivery_date, fired_slot) do nothing
       returning id`,
      [deliveryDate, firedSlot, actor?.login ?? 'system']
    );
    return rows.length ? (rows[0].id as number) : null;
  });
  if (claimed == null) {
    return { skipped: true, runId: null, linesWritten: 0, batches: 0, raw: { reason: 'already-run' } };
  }

  const raw: { cards: unknown[]; skipped: unknown[] } = { cards: [], skipped: [] };
  let linesWritten = 0;
  let batches = 0;
  let error: string | undefined;

  try {
    // 2) сводим доску за дату по техкартам (активные магазины, необнуленные непустые строки)
    const { rows } = await runTx(async (client) =>
      client.query(
        `select o.card_id,
                sum(o.quantity)::float8        as sum_qty,
                tc.portion_qty::float8         as portion_qty,
                tc.name                        as card_name
           from orders o
           join stores s     on s.id = o.store_id and s.active
           join tech_cards tc on tc.id = o.card_id
          where o.date_tab = $1::date
            and o.card_id is not null
            and o.quantity > 0
            and o.status <> 'cancelled'
            and o.written_off_at is null
          group by o.card_id, tc.portion_qty, tc.name
          order by o.card_id`,
        [deliveryDate]
      )
    );

    // 3) каждая карточка — своя транзакция: недостача по одной не отменяет прочие
    for (const r of rows) {
      const cardId = r.card_id as number;
      const portionQty = Number(r.portion_qty);
      const sumQty = Number(r.sum_qty);
      if (!(portionQty > 0)) {
        raw.skipped.push({ cardId, name: r.card_name, reason: 'portion_qty <= 0' });
        continue;
      }
      const portions = sumQty / portionQty;
      if (!(portions > 0)) {
        raw.skipped.push({ cardId, name: r.card_name, reason: 'portions <= 0' });
        continue;
      }
      try {
        const b = await postBatch({ cardId, portions, batchDate: deliveryDate, note: `Автосписание ${firedSlot}`, actor });
        // 4) гасим строки доски — повторный прогон их больше не увидит
        const marked = await pool.query(
          `update orders set written_off_at = now(), updated_at = now()
            where card_id = $1 and date_tab = $2::date
              and written_off_at is null and status <> 'cancelled' and quantity > 0`,
          [cardId, deliveryDate]
        );
        linesWritten += marked.rowCount ?? 0;
        batches += 1;
        raw.cards.push({ cardId, name: r.card_name, portions: round3(portions), batchId: b.id, costTotal: b.costTotal });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        raw.cards.push({ cardId, name: r.card_name, portions: round3(portions), error: msg.slice(0, 300) });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const cardErrors = raw.cards.filter((c) => (c as { error?: string }).error).length;
  const status = error || cardErrors ? 'error' : 'ok';

  // лист доставки закрыт только при чистом прогоне: частично несписанный лист остаётся открытым,
  // чтобы недобранное можно было дописать и списать следующим прогоном.
  let nextTab: NewTabResult | null = null;
  if (status === 'ok') {
    await pool.query(
      "update order_tabs set status = 'locked', locked_at = now() where extract_date = $1::date and status = 'open'",
      [deliveryDate]
    );
    nextTab = await openNextDeliveryTab(deliveryDate);
  }

  await pool.query(
    `update writeoff_runs
        set status = $2, finished_at = now(), lines_written = $3, batches = $4, raw = $5::jsonb, error = $6
      where id = $1`,
    [claimed, status, linesWritten, batches, JSON.stringify(nextTab ? { ...raw, nextTab } : raw), error ?? (cardErrors ? `ошибок по карточкам: ${cardErrors}` : null)]
  );

  return { skipped: false, runId: claimed, linesWritten, batches, raw: nextTab ? { ...raw, nextTab } : raw, error };
}

/**
 * После закрытия листа — завести следующий обнулённый лист доставки (best-effort:
 * расписание пустое / рубильник выключен / Google отказал — прогон от этого не падает).
 * Берём ближайшую дату доставки строго после списанной.
 */
async function openNextDeliveryTab(deliveryDate: string): Promise<NewTabResult | null> {
  try {
    const cfg = await deliverySettings();
    // сутки спустя после полуночи списываемой даты — чтобы считался следующий день, а не сегодня
    const dayAfter = new Date(Date.parse(`${deliveryDate}T00:00:00Z`) + 86_400_000);
    const next = nextDeliveryDate(cfg, dayAfter);
    if (!next) return null;
    return await ensureDeliveryTab(next);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Фоновый планировщик: раз в минуту сверяемся с MSK-часами и, если сейчас совпал
 * включённый слот, гасим списание за сегодняшнюю дату доставки. Сбой прогона не роняет процесс.
 */
export function startWriteOffLoop(intervalMs = 60_000): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const cfg = await writeoffSettings();
      if (!cfg.enabled || !cfg.dates.length || !cfg.time) return;
      const now = mskNow(cfg.tz);
      if (!isSlotDue(now, cfg)) return;
      const res = await runWriteOff(now.dateIso, cfg.time, null);
      console.log(
        `[writeoff] слот ${now.dateIso} ${cfg.time}: списано строк ${res.linesWritten}, партий ${res.batches}` +
          (res.skipped ? ' (слот уже был закрыт)' : '')
      );
    } catch (e) {
      console.error('[writeoff] ошибка прогона:', e instanceof Error ? e.message : e);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return timer;
}

// ============ ОТЧЁТ О СПИСАНИИ (архив по дате доставки) ============

export interface WriteOffReport {
  deliveryDate: string;
  /** выданная готовая продукция: партия = техкарта × порции */
  goods: { cardId: number; name: string; portions: number; costTotal: number }[];
  /** списанное сырьё, свёрнутое по позициям склада */
  raw: { productId: number; name: string; unitCode: string; qty: number; cost: number }[];
  totalCost: number;
}

/**
 * Сводка по автосписанию за дату доставки: что выдали (партии по「Автосписание …」) и
 * какое сырьё на это ушло (позиции партий, свёрнутые по товару). Берём из production_batches,
 * отдельного хранилища отчёта нет — он производный от состоявшихся партий.
 */
export async function writeOffReport(deliveryDate: string): Promise<WriteOffReport> {
  const { rows: batches } = await pool.query(
    `select b.id, b.card_id as "cardId", tc.name, b.portions::float8 as portions, b.cost_total::float8 as "costTotal"
       from production_batches b join tech_cards tc on tc.id = b.card_id
      where b.batch_date = $1::date and b.note like 'Автосписание%'
      order by tc.name`,
    [deliveryDate]
  );
  const ids = batches.map((b) => b.id as number);
  let raw: WriteOffReport['raw'] = [];
  if (ids.length) {
    const { rows } = await pool.query(
      `select i.product_id as "productId", p.name, u.code as "unitCode",
              sum(i.qty)::float8 as qty, sum(i.qty * i.unit_cost)::float8 as cost
         from production_batch_items i
         join products p on p.id = i.product_id
         join units u on u.id = p.unit_id
        where i.batch_id = any($1::int[])
        group by i.product_id, p.name, u.code
        order by p.name`,
      [ids]
    );
    raw = rows.map((r) => ({
      productId: r.productId as number,
      name: r.name as string,
      unitCode: r.unitCode as string,
      qty: Math.round(Number(r.qty) * 1000) / 1000,
      cost: Math.round(Number(r.cost) * 100) / 100,
    }));
  }
  const goods = batches.map((b) => ({
    cardId: b.cardId as number,
    name: b.name as string,
    portions: Number(b.portions),
    costTotal: Math.round(Number(b.costTotal) * 100) / 100,
  }));
  const totalCost = Math.round(batches.reduce((s, b) => s + Number(b.costTotal), 0) * 100) / 100;
  return { deliveryDate, goods, raw, totalCost };
}

/** Последние прогоны списания — список для раздела «архив». */
export async function recentWriteOffRuns(limit = 30): Promise<{
  id: number; deliveryDate: string; firedSlot: string; status: string;
  linesWritten: number; batches: number; startedAt: string; finishedAt: string | null;
  createdBy: string; error: string | null;
}[]> {
  const { rows } = await pool.query(
    `select id, delivery_date::text as "deliveryDate", fired_slot as "firedSlot", status,
            lines_written as "linesWritten", batches, started_at as "startedAt", finished_at as "finishedAt",
            created_by as "createdBy", error
       from writeoff_runs order by started_at desc limit $1`,
    [Math.min(100, Math.max(1, limit | 0))]
  );
  return rows;
}
