import type { PoolClient } from 'pg';

/**
 * Автогенерация «стола» (блок-схемы) из рецепта заготовки.
 *
 * Редактор рецептов правит состав (semi_inputs), но стол не рисует — чтобы у каждой
 * заготовки всё же была визуальная блок-схема, раскладываем рецепт на блоки+связи:
 *   • центральный блок-сборка (note) с именем заготовки;
 *   • по блоку-ингредиенту на вход, связью в сборку;
 *   • на связи — «выход после обработки» (%), в блоке — грубое количество до потерь
 *     (net ÷ выход/100) — так повторное сохранение стола воспроизводит тот же рецепт.
 *
 * геометрия карточек синхронизирована с client constructor (W_ING=260, W_NOTE=220).
 */

/** Вход рецепта как его передаёт маршрут semis (qty — чистое, в базовых единицах входа). */
export interface BoardInput {
  sourceType: 'raw' | 'semi';
  refId: number;
  qty: number;
  yieldPct: number | null;
}

interface ResolvedInput {
  sourceType: 'raw' | 'semi';
  refId: number;
  name: string;
  unitCode: string;
  qty: number;
  yieldPct: number | null;
}

// те же числа раскладки, что в клиентском скрипте генерации и в CSS конструктора
const PER_COL = 9;
const CARD_W = 260;
const CARD_H = 96;
const GAP_X = 48;
const GAP_Y = 36;
const LEFT = 40;
const TOP = 40;

/** net → gross: сколько грубо клали, чтобы после % осталось net. */
function grossQty(net: number, yieldPct: number | null): string {
  const y = Number(yieldPct);
  const val = Number.isFinite(y) && y > 0 && y <= 100 ? net / (y / 100) : net;
  return String(parseFloat(val.toFixed(6)));
}

/** Подтянуть имена и базовые единицы входов (сырьё — products, заготовки — semi_products). */
async function resolveInputs(client: PoolClient, inputs: BoardInput[]): Promise<ResolvedInput[]> {
  const rawIds = inputs.filter((i) => i.sourceType === 'raw').map((i) => i.refId);
  const semiIds = inputs.filter((i) => i.sourceType === 'semi').map((i) => i.refId);

  const nameByRaw = new Map<number, { name: string; unitCode: string }>();
  const nameBySemi = new Map<number, { name: string; unitCode: string }>();
  if (rawIds.length) {
    const { rows } = await client.query(
      `select p.id, p.name, u.code as unitcode
         from products p join units u on u.id = p.unit_id where p.id = any($1::int[])`,
      [rawIds]
    );
    for (const r of rows) nameByRaw.set(Number(r.id), { name: String(r.name), unitCode: String(r.unitcode) });
  }
  if (semiIds.length) {
    const { rows } = await client.query(
      `select sp.id, sp.name, u.code as unitcode
         from semi_products sp join units u on u.id = sp.unit_id where sp.id = any($1::int[])`,
      [semiIds]
    );
    for (const r of rows) nameBySemi.set(Number(r.id), { name: String(r.name), unitCode: String(r.unitcode) });
  }

  return inputs.map((i) => {
    const meta = i.sourceType === 'raw' ? nameByRaw.get(i.refId) : nameBySemi.get(i.refId);
    return {
      ...i,
      name: meta?.name ?? '',
      unitCode: meta?.unitCode ?? '',
    };
  });
}

/**
 * Собрать стол из рецепта. Возвращает объект {blocks, links} или null, если состав пуст.
 * Блок-сборка (note) — «выход», ингредиенты веером слева, связиIngredient → note.
 */
export async function buildBoardFromInputs(
  client: PoolClient,
  inputs: BoardInput[],
  semiName: string,
  semiUnitCode: string,
): Promise<{ blocks: unknown[]; links: unknown[] } | null> {
  if (!inputs.length) return null;
  const resolved = await resolveInputs(client, inputs);

  const cols = Math.ceil(resolved.length / PER_COL);
  const rows = Math.min(resolved.length, PER_COL);

  const blocks: unknown[] = [];
  const links: unknown[] = [];

  // центральный блок-сборка (uid = 1), по центру высоты колонки ингредиентов
  const noteX = LEFT + cols * (CARD_W + GAP_X);
  const colH = rows * CARD_H + (rows - 1) * GAP_Y;
  const noteY = Math.max(TOP, TOP + Math.round(colH / 2) - 60);
  blocks.push({
    uid: 1,
    kind: 'note',
    sourceType: 'raw',
    refId: 0,
    name: '',
    title: String(semiName ?? ''),
    x: noteX,
    y: noteY,
    qty: '',
    unitCode: String(semiUnitCode ?? ''),
  });

  resolved.forEach((inp, i) => {
    const col = Math.floor(i / PER_COL);
    const row = i % PER_COL;
    const uid = i + 2;
    blocks.push({
      uid,
      kind: 'ingredient',
      sourceType: inp.sourceType === 'semi' ? 'semi' : 'raw',
      refId: inp.refId,
      name: inp.name,
      title: '',
      x: LEFT + col * (CARD_W + GAP_X),
      y: TOP + row * (CARD_H + GAP_Y),
      qty: grossQty(Number(inp.qty) || 0, inp.yieldPct),
      unitCode: inp.unitCode,
    });
    links.push({
      id: i + 1,
      from: uid,
      to: 1,
      yieldPct: inp.yieldPct != null ? String(inp.yieldPct) : '',
    });
  });

  return { blocks, links };
}

/** Пустой/отсутствующий ли стол (в jsonb pg уже вернёт объект). */
export function boardIsEmpty(board: unknown): boolean {
  if (!board) return true;
  const b = typeof board === 'string' ? JSON.parse(board) : (board as { blocks?: unknown });
  return !b || !Array.isArray(b.blocks) || b.blocks.length === 0;
}
