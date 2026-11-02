/**
 * Настройки CRM (только администратор).
 *
 * Блоки: транспорт GPT + категории товаров (CRUD, привязка/отвязка tech_cards).
 */
import { Router } from 'express';
import { pool, tx } from '../db';
import { wrap, reqStr, ApiError } from '../http';
import { config } from '../config';
import { audit } from '../services/audit';
import {
  GPT_DEFAULTS,
  gptSettings,
  normalizeProxyUrl,
  normalizeWriteoffSchedule,
  normalizeDeliverySchedule,
  deliverySettings,
  saveDeliverySettings,
  DELIVERY_DEFAULTS,
  proxyTarget,
  saveGptSettings,
  saveWriteoffSettings,
  tcpProbe,
  WRITEOFF_DEFAULTS,
  writeoffSettings,
} from '../services/settings';
import { nextDue, runWriteOff, writeOffReport, recentWriteOffRuns } from '../services/writeoff';
import { upcomingDeliveryDates, nextDeliveryDate } from '../services/delivery';
import { ensureDeliveryTab } from '../services/sheet-tabs';
import { createGptClient } from '../services/gpt-transport';

export const settingsRouter = Router();

/** Что включено сейчас + доступен ли порт прокси (для индикатора на странице). */
settingsRouter.get(
  '/',
  wrap(async (_req, res) => {
    const gpt = await gptSettings();
    const target = proxyTarget(gpt.proxyUrl);
    const writeoff = await writeoffSettings();
    const delivery = await deliverySettings();
    res.json({
      gpt,
      defaults: GPT_DEFAULTS,
      openai: { keyConfigured: Boolean(config.openaiKey), model: config.openaiModel },
      proxy: { ...target, reachable: await tcpProbe(target.host, target.port) },
      writeoff,
      writeoffDefaults: WRITEOFF_DEFAULTS,
      writeoffNext: nextDue(writeoff),
      delivery,
      deliveryDefaults: DELIVERY_DEFAULTS,
      deliveryUpcoming: upcomingDeliveryDates(delivery, 4),
    });
  })
);

/** Сохранить транспорт GPT: галочка «через Tor» и адрес прокси. */
settingsRouter.patch(
  '/gpt',
  wrap(async (req, res) => {
    const body = req.body ?? {};
    const before = await gptSettings();
    const gpt = await saveGptSettings(
      {
        viaProxy: body.viaProxy === true || body.viaProxy === 'true',
        proxyUrl: normalizeProxyUrl(body.proxyUrl),
      },
      req.user
    );
    await audit(req.user, {
      action: 'update',
      entity: 'setting',
      entityId: 'gpt',
      title: gpt.viaProxy ? `GPT через прокси ${gpt.proxyUrl}` : 'GPT напрямую',
      details: { from: before, to: gpt },
    });
    res.json({ ok: true, gpt });
  })
);

/**
 * Проверка связи с GPT текущим транспортом: настоящий (короткий) запрос к модели.
 * Через Tor это может занять десятки секунд — кнопка в интерфейсе это переживает.
 */
settingsRouter.post(
  '/gpt/test',
  wrap(async (_req, res) => {
    const gpt = await gptSettings();
    const started = Date.now();
    const transport = gpt.viaProxy ? gpt.proxyUrl : 'напрямую';
    try {
      const oa = await createGptClient();
      const r = await oa.chat.completions.create({
        model: config.openaiModel,
        max_completion_tokens: 300,
        messages: [{ role: 'user', content: 'ответь одним словом: работает' }],
      });
      const reply = String(r.choices[0]?.message?.content ?? '').trim();
      res.json({
        ok: true,
        ms: Date.now() - started,
        transport,
        reply: (reply || `связь есть, текст пустой (${r.choices[0]?.finish_reason ?? 'без choice'})`).slice(0, 80),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cause = (e as { cause?: { message?: string } }).cause?.message;
      const detail = [msg, cause].filter(Boolean).join(' · ');
      const hint =
        gpt.viaProxy && /connection error|fetch failed|ECONN/i.test(detail)
          ? ` — проверьте, что прокси ${gpt.proxyUrl} запущен (для Tor: systemctl status tor)`
          : '';
      res.json({ ok: false, ms: Date.now() - started, transport, error: (detail + hint).slice(0, 400) });
    }
  })
);

// ============ РАСПИСАНИЕ АВТОСПИСАНИЯ ЗАКАЗОВ ============

/** Сохранить расписание: вкл/выкл, дни недели, список времён, таймзона. */
settingsRouter.patch(
  '/writeoff',
  wrap(async (req, res) => {
    const before = await writeoffSettings();
    const next = normalizeWriteoffSchedule(req.body ?? {});
    const writeoff = await saveWriteoffSettings(next, req.user);
    await audit(req.user, {
      action: 'update',
      entity: 'setting',
      entityId: 'writeoff',
      title: writeoff.enabled
        ? `Автосписание: ${writeoff.weekdays.length} дн. × ${writeoff.times.join(', ') || '—'}`
        : 'Автосписание выключено',
      details: { from: before, to: writeoff },
    });
    res.json({ ok: true, writeoff, writeoffNext: nextDue(writeoff) });
  })
);

/**
 * Ручной прогон списания (админ): по умолчанию — за сегодняшнюю MSK-дату.
 * firedSlot уникализируется временем запуска, чтобы не упираться в автослот.
 */
settingsRouter.post(
  '/writeoff/run',
  wrap(async (req, res) => {
    const body = req.body ?? {};
    const cfg = await writeoffSettings();
    // дата доставки по таймзоне расписания (en-CA => YYYY-MM-DD); без тела — сегодняшняя
    const msk = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const deliveryDate = typeof body.deliveryDate === 'string' && body.deliveryDate ? body.deliveryDate : msk;
    const firedSlot =
      typeof body.firedSlot === 'string' && body.firedSlot
        ? body.firedSlot
        : `manual-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
    const result = await runWriteOff(deliveryDate, firedSlot, req.user);
    await audit(req.user, {
      action: 'post',
      entity: 'setting',
      entityId: `writeoff:${deliveryDate}`,
      title: `Ручное автосписание ${deliveryDate} (${firedSlot})`,
      details: { deliveryDate, firedSlot, skipped: result.skipped, linesWritten: result.linesWritten, batches: result.batches },
    });
    res.json({
      ok: !result.error,
      skipped: result.skipped,
      deliveryDate,
      firedSlot,
      linesWritten: result.linesWritten,
      batches: result.batches,
      error: result.error,
    });
  })
);

// ============ РАСПИСАНИЕ ДОСТАВОК ============

/** Сохранить дни доставки: какие дни недели + таймзона. */
settingsRouter.patch(
  '/delivery',
  wrap(async (req, res) => {
    const before = await deliverySettings();
    const next = normalizeDeliverySchedule(req.body ?? {});
    const delivery = await saveDeliverySettings(next, req.user);
    await audit(req.user, {
      action: 'update',
      entity: 'setting',
      entityId: 'delivery',
      title: `Дни доставки: ${delivery.weekdays.length} дн.`,
      details: { from: before, to: delivery },
    });
    res.json({ ok: true, delivery, deliveryUpcoming: upcomingDeliveryDates(delivery, 4) });
  })
);

/**
 * Завести следующий обнулённый лист доставки в прод-таблице (админ).
 * Тело: { date?: 'YYYY-MM-DD' }; без даты — ближайшая доставка от сегодня.
 * Требует рубильник GSHEET_WRITE_ENABLED; идемпотентно — существующий лист не трогает.
 */
settingsRouter.post(
  '/delivery/tab',
  wrap(async (req, res) => {
    const body = req.body ?? {};
    const cfg = await deliverySettings();
    const date =
      typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : nextDeliveryDate(cfg);
    if (!date) return res.status(400).json({ error: 'Дата не задана, а расписание доставок пустое' });
    const result = await ensureDeliveryTab(date);
    await audit(req.user, {
      action: 'post',
      entity: 'setting',
      entityId: `delivery-tab:${date}`,
      title: `Лист доставки ${result.sheetName ?? date}: ${result.ok ? (result.created ? 'создан' : 'уже был') : 'не создан'}`,
      details: { date, ...result },
    });
    res.status(result.ok ? 200 : 502).json({ date, ...result });
  })
);

/** Отчёт по автосписанию за дату доставки (админ): готовая продукция + сырьё + стоимость. */
settingsRouter.get(
  '/writeoff/report',
  wrap(async (req, res) => {
    const cfg = await writeoffSettings();
    const date =
      typeof req.query.date === 'string' && req.query.date
        ? req.query.date
        : new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    res.json(await writeOffReport(date));
  })
);

/** Последние прогоны списания (для журнала/архива). */
settingsRouter.get(
  '/writeoff/runs',
  wrap(async (_req, res) => {
    res.json(await recentWriteOffRuns());
  })
);

// ============ КАТЕГОРИИ ТОВАРОВ ============

/** Список категорий с количеством привязанных tech_cards. */
settingsRouter.get(
  '/categories',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select oc.id, oc.name, count(tc.id)::int as "cardCount"
         from order_categories oc
         left join tech_cards tc on tc.category_id = oc.id
        group by oc.id, oc.name
        order by oc.name`
    );
    res.json(rows);
  })
);

/** Создать категорию. */
settingsRouter.post(
  '/categories',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name').toLowerCase().trim();
    if (!name) return res.status(400).json({ error: 'Пустое имя' });
    const { rows } = await pool.query(
      `insert into order_categories (name) values ($1) on conflict (name) do nothing returning id, name`,
      [name]
    );
    if (!rows.length) return res.status(409).json({ error: 'Уже существует' });
    await audit(req.user, { action: 'create', entity: 'setting', entityId: `cat:${rows[0].id}`, title: `Категория «${name}»` });
    res.status(201).json(rows[0]);
  })
);

/** Переименовать. */
settingsRouter.patch(
  '/categories/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = reqStr(req.body, 'name').toLowerCase().trim();
    if (!name) return res.status(400).json({ error: 'Пустое имя' });
    await pool.query('update order_categories set name = $2 where id = $1', [id, name]);
    await audit(req.user, { action: 'update', entity: 'setting', entityId: `cat:${id}`, title: `Категория → «${name}»` });
    res.json({ ok: true });
  })
);

/** Удалить (tech_cards.category_id и orders.category_id обнуляются ON DELETE SET NULL). */
settingsRouter.delete(
  '/categories/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query('select name from order_categories where id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Не найдена' });
    await pool.query('delete from order_categories where id = $1', [id]);
    await audit(req.user, { action: 'delete', entity: 'setting', entityId: `cat:${id}`, title: `Категория «${rows[0].name}»` });
    res.json({ ok: true });
  })
);

/** Товары в категории (для редактирования привязок). */
settingsRouter.get(
  '/categories/:id/cards',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select tc.id, tc.name, tc.plu from tech_cards tc where tc.category_id = $1 order by tc.name`,
      [Number(req.params.id)]
    );
    res.json(rows);
  })
);

/** Привязать товары к категории (массовая замена). */
settingsRouter.put(
  '/categories/:id/cards',
  wrap(async (req, res) => {
    const catId = Number(req.params.id);
    const raw = Array.isArray(req.body?.cardIds) ? req.body.cardIds : [];
    const ids = (raw as unknown[]).map(Number).filter((n) => Number.isFinite(n));
    await tx(async (client) => {
      // отвязать все, кто был в категории, но не в новом списке
      await client.query(
        `update tech_cards set category_id = null where category_id = $1 and not (id = any($2::int[]))`,
        [catId, ids]
      );
      // привязать указанных
      for (const id of ids) {
        await client.query('update tech_cards set category_id = $1 where id = $2', [catId, id]);
      }
    });
    await audit(req.user, { action: 'update', entity: 'setting', entityId: `cat:${catId}`, title: `Привязка товаров (${ids.length})` });
    res.json({ ok: true });
  })
);

/** Не привязанные к категории tech_cards (для пикера). */
settingsRouter.get(
  '/cards-unassigned',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select tc.id, tc.name, tc.plu from tech_cards tc where tc.category_id is null order by tc.name`
    );
    res.json(rows);
  })
);

/** Все tech_cards (в т.ч. с категорией) для выбора. */
settingsRouter.get(
  '/all-cards',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select tc.id, tc.name, tc.plu, tc.category_id as "categoryId"
         from tech_cards tc order by tc.name`
    );
    res.json(rows);
  })
);

// ============ КАТЕГОРИИ СЫРЬЯ (номенклатура склада, products) ============
// Словарь product_categories задаёт набор имён; products.category — текст-носитель.
// «прочее» — корзина нераспределённого (не заносится в словарь). Matching — без регистра.

/** Список категорий сырья с количеством активных позиций. */
settingsRouter.get(
  '/raw-categories',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select pc.id, pc.name,
              count(p.id) filter (where p.active)::int as "productCount"
         from product_categories pc
         left join products p on lower(btrim(p.category)) = pc.name
        group by pc.id, pc.name
        order by pc.name`
    );
    res.json(rows);
  })
);

/** Создать категорию сырья. */
settingsRouter.post(
  '/raw-categories',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name').toLowerCase().trim();
    if (!name || name === 'прочее') return res.status(400).json({ error: 'Некорректное имя' });
    const { rows } = await pool.query(
      `insert into product_categories (name) values ($1) on conflict (name) do nothing returning id, name`,
      [name]
    );
    if (!rows.length) return res.status(409).json({ error: 'Уже существует' });
    await audit(req.user, { action: 'create', entity: 'setting', entityId: `rawcat:${rows[0].id}`, title: `Категория сырья «${name}»` });
    res.status(201).json(rows[0]);
  })
);

/** Переименовать категорию сырья (каскадно правит products.category). */
settingsRouter.patch(
  '/raw-categories/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = reqStr(req.body, 'name').toLowerCase().trim();
    if (!name || name === 'прочее') return res.status(400).json({ error: 'Некорректное имя' });
    await tx(async (client) => {
      const { rows: cur } = await client.query('select name from product_categories where id = $1', [id]);
      if (!cur.length) throw new ApiError(404, 'Категория не найдена');
      const old = cur[0].name as string;
      if (old === name) return;
      const { rows: clash } = await client.query('select 1 from product_categories where name = $2 and id <> $1', [id, name]);
      if (clash.length) throw new ApiError(409, 'Такая категория уже есть');
      await client.query('update product_categories set name = $2 where id = $1', [id, name]);
      await client.query('update products set category = $2 where lower(btrim(category)) = $1', [old, name]);
    });
    await audit(req.user, { action: 'update', entity: 'setting', entityId: `rawcat:${id}`, title: `Категория сырья → «${name}»` });
    res.json({ ok: true });
  })
);

/** Удалить категорию сырья (позиции уходят в «прочее»). */
settingsRouter.delete(
  '/raw-categories/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const { rows: cur } = await client.query('select name from product_categories where id = $1', [id]);
      if (!cur.length) return;
      await client.query("update products set category = 'прочее' where lower(btrim(category)) = $1", [cur[0].name]);
      await client.query('delete from product_categories where id = $1', [id]);
    });
    await audit(req.user, { action: 'delete', entity: 'setting', entityId: `rawcat:${id}`, title: 'Категория сырья удалена' });
    res.json({ ok: true });
  })
);

/** Позиции сырья в категории (активные) — для дерева. */
settingsRouter.get(
  '/raw-categories/:id/products',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select p.id, p.name
         from products p
         join product_categories pc on pc.id = $1 and lower(btrim(p.category)) = pc.name
        where p.active
        order by p.name`,
      [Number(req.params.id)]
    );
    res.json(rows);
  })
);

/** Замена набора позиций категории: перечисленные → в категорию, прочие активные из неё → «прочее». */
settingsRouter.put(
  '/raw-categories/:id/products',
  wrap(async (req, res) => {
    const catId = Number(req.params.id);
    const raw = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const ids = (raw as unknown[]).map(Number).filter((n) => Number.isFinite(n));
    await tx(async (client) => {
      const { rows: cur } = await client.query('select name from product_categories where id = $1', [catId]);
      if (!cur.length) throw new ApiError(404, 'Категория не найдена');
      const name = cur[0].name as string;
      await client.query(
        `update products set category = 'прочее'
          where active and lower(btrim(category)) = $1 and not (id = any($2::int[]))`,
        [name, ids]
      );
      if (ids.length) {
        await client.query('update products set category = $1 where id = any($2::int[]) and active', [name, ids]);
      }
    });
    await audit(req.user, { action: 'update', entity: 'setting', entityId: `rawcat:${catId}`, title: `Привязка сырья (${ids.length})` });
    res.json({ ok: true });
  })
);

/** Все активные позиции сырья с категорией (null — «прочее»/вне словаря) для дерева и пикера. */
settingsRouter.get(
  '/raw-products-all',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select p.id, p.name, pc.id as "categoryId"
         from products p
         left join product_categories pc on pc.name = lower(btrim(p.category))
        where p.active
        order by p.name`
    );
    res.json(rows);
  })
);
