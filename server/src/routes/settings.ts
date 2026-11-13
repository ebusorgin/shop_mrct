/**
 * Настройки CRM (только администратор).
 *
 * Блоки: календарь доставок производства, транспорт GPT и каталоги.
 */
import { Router } from 'express';
import { pool, tx } from '../db';
import { wrap, reqStr, ApiError } from '../http';
import { config } from '../config';
import { audit, auditTx } from '../services/audit';
import { requireOffice } from '../services/auth';
import {
  deliveryRule,
  deliveryRuleInput,
  writeDeliveryRule,
  type DeliveryRule,
} from '../services/delivery-rule';
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

// ============ КАЛЕНДАРЬ ДОСТАВОК ПРОИЗВОДСТВА ============

/** Строгая календарная дата без часового пояса, включая годы 0001–0099. */
export function deliveryDate(value: unknown, field = 'date'): string {
  const invalid = () => new ApiError(400, `Поле «${field}»: укажите существующую дату в формате YYYY-MM-DD, год от 0001 до 9999`);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid();
  const [year, month, day] = value.split('-').map(Number);
  if (year === 0) throw invalid();
  // Date.UTC(1, ...) означал бы 1901 год; setUTCFullYear сохраняет исходный год.
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  if (utc.toISOString().slice(0, 10) !== value) throw invalid();
  return value;
}

export function deliveryEnabled(body: unknown): boolean {
  if (
    body === null || typeof body !== 'object' || Array.isArray(body) ||
    !Object.prototype.hasOwnProperty.call(body, 'enabled') ||
    typeof (body as Record<string, unknown>).enabled !== 'boolean'
  ) {
    throw new ApiError(400, 'Поле «enabled» обязательно и должно быть логическим значением true или false');
  }
  return (body as { enabled: boolean }).enabled;
}

/**
 * Все ручные даты расписания. Окно календаря серверу не нужно: клиент рисует любые
 * три месяца сам, а даты правила в базе не лежат — их он тоже считает сам.
 */
settingsRouter.get(
  '/delivery-calendar',
  requireOffice,
  wrap(async (_req, res) => {
    const { rows } = await pool.query<{ today: string; dates: string[] }>(
      `select to_char(current_date, 'YYYY-MM-DD') as today,
              coalesce(array_agg(to_char(delivery_date, 'YYYY-MM-DD') order by delivery_date),
                       '{}'::text[]) as dates
         from delivery_schedule`
    );
    res.json({ today: rows[0].today, dates: rows[0].dates });
  })
);

/**
 * Одна дата вручную. Ручная отметка ставится и снимается независимо от правила:
 * день может идти и по правилу, и быть отмеченным руками — это разные источники.
 */
settingsRouter.put(
  '/delivery-calendar/:date',
  requireOffice,
  wrap(async (req, res) => {
    const date = deliveryDate(req.params.date);
    const enabled = deliveryEnabled(req.body);
    const result = await tx(async (client) => {
      const { rows: [clock] } = await client.query<{ today: string }>(
        "select to_char(current_date, 'YYYY-MM-DD') as today"
      );
      if (date <= clock.today) throw new ApiError(400, 'Сегодняшнюю и прошедшие даты доставки нельзя изменять');
      const { rows } = enabled
        ? await client.query<{ date: string }>(
          `insert into delivery_schedule (delivery_date, created_by) values ($1::date, $2)
           on conflict (delivery_date) do nothing
           returning to_char(delivery_date, 'YYYY-MM-DD') as date`,
          [date, req.user?.id ?? null]
        )
        : await client.query<{ date: string }>(
          `delete from delivery_schedule where delivery_date = $1::date
           returning to_char(delivery_date, 'YYYY-MM-DD') as date`,
          [date]
        );
      if (rows.length) {
        await auditTx(client, req.user, {
          action: 'update',
          entity: 'setting',
          entityId: 'delivery-calendar',
          title: enabled ? `Доставка ${date} включена` : `Доставка ${date} отключена`,
          details: { date, enabled },
        });
      }
      return { date: rows[0]?.date ?? date, enabled };
    });
    res.json(result);
  })
);

/** Сохранённое правило повторяющихся доставок: дни недели ИЛИ числа месяца. */
settingsRouter.get(
  '/delivery-rule',
  requireOffice,
  wrap(async (_req, res) => {
    res.json(await deliveryRule());
  })
);

/**
 * Правило — активные элементы справочника периодов. Дат в расписании оно не оставляет,
 * но ручные отметки на тех же днях не трогает: источники могут пересекаться.
 */
settingsRouter.patch(
  '/delivery-rule',
  requireOffice,
  wrap(async (req, res) => {
    const rule: DeliveryRule = deliveryRuleInput(req.body);
    const before = await deliveryRule();
    await tx(async (client) => {
      await writeDeliveryRule(client, rule);
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'setting',
        entityId: 'delivery-rule',
        title: rule.weekdays.length || rule.monthDays.length
          ? `Правило доставок: ${rule.weekdays.length} дн. недели, ${rule.monthDays.length} чисел месяца`
          : 'Правило доставок выключено',
        details: { from: before, to: rule },
      });
    });
    res.json({ ok: true, rule });
  })
);

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
      `select pc.id, pc.name, pc.icon, pc.color,
              count(p.id) filter (where p.active)::int as "productCount"
         from product_categories pc
         left join products p on lower(btrim(p.category)) = pc.name
        group by pc.id, pc.name, pc.icon, pc.color
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
    const icon = catalogIcon(req.body.icon);
    const color = catalogColor(req.body.color);
    if (icon) {
      const { rows: busy } = await pool.query('select name from product_categories where icon = $1', [icon]);
      if (busy.length) throw new ApiError(409, `Иконка ${icon} уже используется категорией «${busy[0].name}»`);
    }
    const { rows } = await pool.query(
      `insert into product_categories (name, icon, color) values ($1, $2, $3)
       on conflict (name) do nothing returning id, name, icon, color`,
      [name, icon, color]
    );
    if (!rows.length) return res.status(409).json({ error: 'Уже существует' });
    await audit(req.user, { action: 'create', entity: 'setting', entityId: `rawcat:${rows[0].id}`, title: `Категория сырья «${name}»` });
    res.status(201).json(rows[0]);
  })
);

/** Изменить категорию сырья: имя, иконку и/или цвет (поле отсутствует — не трогаем). */
settingsRouter.patch(
  '/raw-categories/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows: cur } = await pool.query('select name, icon, color from product_categories where id = $1', [id]);
    if (!cur.length) throw new ApiError(404, 'Категория не найдена');
    const has = (field: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field);
    const name = has('name') ? reqStr(req.body, 'name').toLowerCase().trim() : (cur[0].name as string);
    if (!name || name === 'прочее') return res.status(400).json({ error: 'Некорректное имя' });
    const icon = has('icon') ? catalogIcon(req.body.icon) : (cur[0].icon as string);
    const color = has('color') ? catalogColor(req.body.color) : (cur[0].color as string);
    if (icon) {
      const { rows: busy } = await pool.query(
        'select name from product_categories where icon = $1 and id <> $2',
        [icon, id]
      );
      if (busy.length) throw new ApiError(409, `Иконка ${icon} уже используется категорией «${busy[0].name}»`);
    }
    await tx(async (client) => {
      if (name !== cur[0].name) {
        const { rows: clash } = await client.query('select 1 from product_categories where name = $2 and id <> $1', [id, name]);
        if (clash.length) throw new ApiError(409, 'Такая категория уже есть');
        await client.query('update products set category = $2 where lower(btrim(category)) = $1', [cur[0].name, name]);
      }
      await client.query('update product_categories set name = $2, icon = $3, color = $4 where id = $1', [id, name, icon, color]);
    });
    await audit(req.user, { action: 'update', entity: 'setting', entityId: `rawcat:${id}`, title: `Категория сырья → «${name}»` });
    res.json({ ok: true, name, icon, color });
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

/** Все активные позиции сырья с категорией (null — «прочее»/вне словаря) и параметрами карточки. */
settingsRouter.get(
  '/raw-products-all',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select p.id, p.name, pc.id as "categoryId", u.code as "unitCode",
              p.min_stock::float8 as "minStock", p.shelf_life_days as "shelfLifeDays"
         from products p
         left join product_categories pc on pc.name = lower(btrim(p.category))
         left join units u on u.id = p.unit_id
        where p.active
        order by p.name`
    );
    res.json(rows);
  })
);

// ============ КАТАЛОГ ПРОДУКЦИИ (готовые продукты, tech_cards) ============

/** Иконка каталога — эмодзи, не больше нескольких символов. */
function catalogIcon(v: unknown): string {
  return typeof v === 'string' ? Array.from(v.trim()).slice(0, 8).join('') : '';
}

/** Фоновый цвет каталога — только #rrggbb (пустая строка = без цвета). */
function catalogColor(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : '';
}

/** Список каталогов продукции с количеством продуктов. */
settingsRouter.get(
  '/product-catalogs',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select pc.id, pc.name, pc.icon, pc.color, count(tc.id)::int as "cardCount"
         from product_catalogs pc
         left join tech_cards tc on tc.catalog_id = pc.id
        group by pc.id, pc.name, pc.position, pc.icon, pc.color
        order by pc.position, pc.name`
    );
    res.json(rows);
  })
);

/** Создать каталог продукции. */
settingsRouter.post(
  '/product-catalogs',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name').toLowerCase().trim();
    if (!name) return res.status(400).json({ error: 'Некорректное имя' });
    const icon = catalogIcon(req.body.icon);
    const color = catalogColor(req.body.color);
    if (icon) {
      const { rows: busy } = await pool.query('select name from product_catalogs where icon = $1', [icon]);
      if (busy.length) throw new ApiError(409, `Иконка ${icon} уже используется каталогом «${busy[0].name}»`);
    }
    const { rows } = await pool.query(
      `insert into product_catalogs (name, position, icon, color)
       values ($1, coalesce((select max(position) + 1 from product_catalogs), 1), $2, $3)
       on conflict (name) do nothing
       returning id, name, icon, color`,
      [name, icon, color]
    );
    if (!rows.length) return res.status(409).json({ error: 'Уже существует' });
    await audit(req.user, { action: 'create', entity: 'setting', entityId: `prodcat:${rows[0].id}`, title: `Каталог продукции «${name}»` });
    res.status(201).json(rows[0]);
  })
);

/** Изменить каталог продукции: имя, иконку и/или цвет (поле отсутствует — не трогаем). */
settingsRouter.patch(
  '/product-catalogs/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows: cur } = await pool.query('select name, icon, color from product_catalogs where id = $1', [id]);
    if (!cur.length) throw new ApiError(404, 'Каталог не найден');
    const has = (field: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field);
    const name = has('name') ? reqStr(req.body, 'name').toLowerCase().trim() : cur[0].name;
    if (!name) return res.status(400).json({ error: 'Некорректное имя' });
    const icon = has('icon') ? catalogIcon(req.body.icon) : cur[0].icon;
    const color = has('color') ? catalogColor(req.body.color) : cur[0].color;
    if (icon) {
      const { rows: busy } = await pool.query(
        'select name from product_catalogs where icon = $1 and id <> $2',
        [icon, id]
      );
      if (busy.length) throw new ApiError(409, `Иконка ${icon} уже используется каталогом «${busy[0].name}»`);
    }
    if (name !== cur[0].name) {
      const { rows: clash } = await pool.query('select 1 from product_catalogs where name = $2 and id <> $1', [id, name]);
      if (clash.length) throw new ApiError(409, 'Такой каталог уже есть');
    }
    if (name === cur[0].name && icon === cur[0].icon && color === cur[0].color) return res.json({ ok: true });
    await pool.query('update product_catalogs set name = $2, icon = $3, color = $4 where id = $1', [id, name, icon, color]);
    await audit(req.user, { action: 'update', entity: 'setting', entityId: `prodcat:${id}`, title: `Каталог продукции → «${name}»` });
    res.json({ ok: true, name, icon, color });
  })
);

/** Удалить каталог продукции (продукты остаются, но без каталога). */
settingsRouter.delete(
  '/product-catalogs/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query('delete from product_catalogs where id = $1 returning id, name', [id]);
    if (!rows.length) return res.json({ ok: true });
    await audit(req.user, { action: 'delete', entity: 'setting', entityId: `prodcat:${id}`, title: `Каталог продукции «${rows[0].name}» удалён` });
    res.json({ ok: true });
  })
);
