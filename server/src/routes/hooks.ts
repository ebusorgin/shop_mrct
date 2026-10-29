/**
 * Вебхук Google Таблицы (Apps Script).
 *
 * Google ходит на сервер без cookie, поэтому эндпоинт публичный, а авторизация —
 * общий секрет в заголовке `X-Sheet-Token` (или `?token=`). Секрет задаётся
 * в server/.env (GSHEET_HOOK_TOKEN) и повторяется в CFG.TOKEN скрипта таблицы.
 * Если секрет не задан, эндпоинт отвечает 503: вебхук сознательно выключен.
 *
 * POST /api/hooks/sheet  { tab?: '28.10', changeType?: 'EDIT', email?: '...' }
 *   -> 202 { ok: true } сразу, дальше — событие в журнал, плашка в браузеры и внеплановый синк.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { ApiError, wrap } from '../http';
import { config } from '../config';
import { notifySheetEvent } from '../services/sheet-watch';

export const hooksRouter = Router();

function tokenOk(given: string): boolean {
  const want = config.sheetHookToken;
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

hooksRouter.post(
  '/sheet',
  wrap(async (req, res) => {
    if (!config.sheetHookToken) {
      throw new ApiError(503, 'Вебхук не настроен: задайте GSHEET_HOOK_TOKEN в server/.env');
    }
    const header = req.get('x-sheet-token') ?? '';
    const query = typeof req.query.token === 'string' ? req.query.token : '';
    if (!tokenOk(header) && !tokenOk(query)) throw new ApiError(401, 'Неверный токен вебхука');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const tab = typeof body.tab === 'string' && body.tab.trim() ? body.tab.trim().slice(0, 120) : null;
    const changeType = typeof body.changeType === 'string' ? body.changeType.slice(0, 60) : null;
    const actor = typeof body.email === 'string' ? body.email.slice(0, 200) : null;

    // отвечаем сразу: Apps Script не должен ждать синхронизации (у UrlFetchApp свой лимит времени)
    res.status(202).json({ ok: true, tab });
    void notifySheetEvent({ source: 'apps_script', tab, changeType, actor, payload: body });
  })
);
