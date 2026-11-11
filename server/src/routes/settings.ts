/**
 * Настройки CRM (только администратор).
 *
 * Блоки: транспорт GPT + категории сырья (номенклатура склада).
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
  proxyTarget,
  saveGptSettings,
  tcpProbe,
} from '../services/settings';
import { createGptClient } from '../services/gpt-transport';

export const settingsRouter = Router();

/** Что включено сейчас + доступен ли порт прокси (для индикатора на странице). */
settingsRouter.get(
  '/',
  wrap(async (_req, res) => {
    const gpt = await gptSettings();
    const target = proxyTarget(gpt.proxyUrl);
    res.json({
      gpt,
      defaults: GPT_DEFAULTS,
      openai: { keyConfigured: Boolean(config.openaiKey), model: config.openaiModel },
      proxy: { ...target, reachable: await tcpProbe(target.host, target.port) },
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
