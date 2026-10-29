/**
 * Настройки CRM (только администратор).
 *
 * Сейчас здесь один блок — транспорт запросов к OpenAI: напрямую или через
 * SOCKS/HTTP-прокси (Tor). Нужно, потому что из ряда стран api.openai.com
 * отвечает 403 unsupported_country_region_territory.
 */
import { Router } from 'express';
import { wrap } from '../http';
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
      // 8 токенов рабочая модель не вывозит (у неё их съедает размышление) — берём запас,
      // иначе тест вернёт пустой content и «связь есть» будет выглядеть как поломка.
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
      // SDK прячет причину за «Connection error.» — достаём её из cause и подсказываем, что смотреть
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
