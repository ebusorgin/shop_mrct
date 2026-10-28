import { NextFunction, Request, RequestHandler, Response } from 'express';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Обёртка для асинхронных обработчиков: ловит ошибки в next(). */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function errHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  console.error('[api]', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}

// ---------- валидация ----------
export function reqNum(body: Record<string, unknown>, field: string): number {
  const v = Number(body[field]);
  if (!Number.isFinite(v)) throw new ApiError(400, `Поле «${field}» должно быть числом`);
  return v;
}

export function optNum(body: Record<string, unknown>, field: string, def = 0): number {
  if (body[field] === undefined || body[field] === null || body[field] === '') return def;
  return reqNum(body, field);
}

export function reqStr(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, `Поле «${field}» обязательно`);
  return v.trim();
}

export function reqInt(body: Record<string, unknown>, field: string): number {
  const v = reqNum(body, field);
  if (!Number.isInteger(v)) throw new ApiError(400, `Поле «${field}» должно быть целым`);
  return v;
}

export function reqArr(body: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const v = body[field];
  if (!Array.isArray(v) || v.length === 0) throw new ApiError(400, `Поле «${field}» — непустой массив`);
  return v as Record<string, unknown>[];
}

export function qInt(req: Request, field: string): number | null {
  const raw = req.query[field];
  if (typeof raw !== 'string' || raw === '') return null;
  const v = Number(raw);
  return Number.isInteger(v) ? v : null;
}
