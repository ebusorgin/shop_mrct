import { pool } from '../db';
import { ApiError } from '../http';
import { runQoderCli } from './qoder-cli';

/**
 * ИИ-раскладка карты производства.
 *
 * Модель не рисует каждую карточку — она выбирает композицию: сколько колонок
 * у каждого облака сырья, порядок облаков и плотность этапов. Координаты внутри
 * облаков раскладываются детерминированно, поэтому схема не «ломается» ответом модели.
 * Если ИИ недоступен — используется та же компактная раскладка без подсказки модели.
 */

export interface LayoutNode {
  uid: number;
  kind: 'product' | 'state' | 'output';
  refId: number | null;
  name: string;
}

export interface LayoutOp {
  uid: number;
  outputUid: number;
  inputs: { nodeUid: number }[];
}

export interface LayoutPlan {
  nodes: { uid: number; x: number; y: number }[];
  ops: { uid: number; x: number; y: number }[];
  summary: string;
  ai: boolean;
}

const NODE_W = 236;
const NODE_H = 92;
const BLOCK_W = 250;
const BLOCK_H = 142;
const NODE_STEP_X = 252;
const NODE_STEP_Y = 104;
const CLOUD_PAD = 16;
const CLOUD_HEAD = 36;
const CLOUD_GAP = 26;

interface AiPlan {
  cloudBands?: number;
  cloudOrder?: string[];
  cloudCols?: Record<string, number>;
  stageGapX?: number;
  stageGapY?: number;
  summary?: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function extractJson(text: string): unknown {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('ИИ не вернул JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

async function askAi(
  categories: { key: string; count: number }[],
  stages: { depth: number; count: number }[],
  totalNodes: number
): Promise<AiPlan | null> {
  const prompt = [
    'Ты — дизайнер схемы производства продуктов. Нужно красиво и компактно разложить граф:',
    'сырьё — левыми облаками по категориям, этапы (операции) — колонками справа.',
    '',
    `Всего узлов: ${totalNodes}.`,
    `Облака сырья: ${JSON.stringify(categories)}.`,
    `Этапы: ${JSON.stringify(stages)}.`,
    '',
    'Верни ТОЛЬКО JSON без markdown и пояснений:',
    '{"cloudBands":2,"cloudOrder":["..."],"cloudCols":{"категория":3},',
    ' "stageGapX":280,"stageGapY":150,"summary":"одна короткая фраза"}',
    '',
    'Правила:',
    '- cloudBands: 3..4 — сколько вертикальных полос облаков;',
    '- cloudOrder: все категории ровно по одному разу, большие облака выше;',
    '- cloudCols: 1..4 колонки карточек внутри каждого облака;',
    '- stageGapX: 250..340, stageGapY: 120..140 — меньше значит плотнее;',
    '- названия категорий не переводи и не меняй.',
  ].join('\n');

  try {
    const run = await runQoderCli(prompt, process.cwd(), 120000, {});
    if (run.timedOut || run.code !== 0) return null;
    const raw = extractJson(run.stdout) as AiPlan;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function operationDepths(ops: LayoutOp[], nodeKinds: Map<number, string>): Map<number, number> {
  const producers = new Map<number, LayoutOp>();
  for (const op of ops) producers.set(op.outputUid, op);
  const depth = new Map<number, number>();
  const busy = new Set<number>();
  const visit = (op: LayoutOp): number => {
    const cached = depth.get(op.uid);
    if (cached != null) return cached;
    if (busy.has(op.uid)) return 1;
    busy.add(op.uid);
    let d = 1;
    for (const inp of op.inputs) {
      if (nodeKinds.get(inp.nodeUid) === 'product') continue;
      const producer = producers.get(inp.nodeUid);
      if (producer) d = Math.max(d, visit(producer) + 1);
    }
    busy.delete(op.uid);
    depth.set(op.uid, d);
    return d;
  };
  for (const op of ops) visit(op);
  return depth;
}

export async function aiLayout(
  nodes: LayoutNode[],
  ops: LayoutOp[],
  useAi = true
): Promise<LayoutPlan> {
  if (!nodes.length) return { nodes: [], ops: [], summary: 'Карта пуста', ai: false };
  const nodeById = new Map(nodes.map((n) => [n.uid, n]));
  for (const op of ops) {
    if (!nodeById.has(op.outputUid)) throw new ApiError(400, 'Выход операции не найден');
    for (const inp of op.inputs) {
      if (!nodeById.has(inp.nodeUid)) throw new ApiError(400, 'Вход операции не найден');
    }
  }

  const refIds = [
    ...new Set(
      nodes
        .filter((n) => n.kind === 'product' && n.refId != null)
        .map((n) => Number(n.refId))
    ),
  ];
  const categoryById = new Map<number, string>();
  if (refIds.length) {
    const { rows } = await pool.query<{ id: number; category: string | null }>(
      'select id, category from products where id = any($1::int[])',
      [refIds]
    );
    for (const r of rows) categoryById.set(Number(r.id), (r.category ?? '').trim() || 'прочее');
  }

  const groups = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'product') continue;
    const key = categoryById.get(Number(node.refId)) ?? 'прочее';
    const arr = groups.get(key) ?? [];
    arr.push(node);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) arr.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const depths = operationDepths(ops, new Map(nodes.map((n) => [n.uid, n.kind])));
  const producers = new Map<number, LayoutOp>();
  for (const op of ops) producers.set(op.outputUid, op);
  const stageMap = new Map<number, LayoutOp[]>();
  for (const op of ops) {
    const d = depths.get(op.uid) ?? 1;
    const arr = stageMap.get(d) ?? [];
    arr.push(op);
    stageMap.set(d, arr);
  }
  const stages = [...stageMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, list]) => ({ depth, count: list.length }));

  const catList = [...groups.entries()]
    .map(([key, list]) => ({ key, count: list.length }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'ru'));

  const ai = useAi ? await askAi(catList, stages, nodes.length) : null;
  const order = (ai?.cloudOrder ?? [])
    .filter((k) => groups.has(k))
    .filter((k, i, arr) => arr.indexOf(k) === i);
  for (const c of catList) if (!order.includes(c.key)) order.push(c.key);

  // Вертикаль важнее ширины: минимум 3 полосы облаков и не больше 140 px между этапами.
  const bands = clamp(Math.round(ai?.cloudBands ?? 3), 3, 4);
  const stageGapX = clamp(Math.round(ai?.stageGapX ?? 280), 250, 340);
  const stageGapY = clamp(Math.round(ai?.stageGapY ?? 128), 120, 140);

  // Размеры облаков: модель задаёт число колонок, строки считаем сами.
  const clouds = order.map((key) => {
    const list = groups.get(key) ?? [];
    // ИИ может сделать облако шире, но не уже — иначе карта снова вытянется вниз.
    const autoCols = list.length <= 4 ? 1 : list.length <= 8 ? 2 : list.length <= 12 ? 3 : 4;
    const cols = clamp(
      Math.max(Math.round(ai?.cloudCols?.[key] ?? autoCols), autoCols),
      1,
      4
    );
    const rows = Math.ceil(list.length / cols);
    return {
      key,
      list,
      cols,
      rows,
      w: cols * NODE_STEP_X + CLOUD_PAD * 2,
      h: rows * NODE_STEP_Y + CLOUD_HEAD + CLOUD_PAD,
    };
  });

  // Раскладываем облака по полосам: в самую низкую полосу, ширину берём по максимуму.
  const bandClouds: typeof clouds[] = Array.from({ length: bands }, () => []);
  const bandHeights = new Array(bands).fill(0);
  for (const cloud of clouds) {
    let band = 0;
    for (let i = 1; i < bands; i++) {
      if (bandHeights[i] < bandHeights[band] - 1) band = i;
    }
    bandClouds[band].push(cloud);
    bandHeights[band] += cloud.h + CLOUD_GAP;
  }
  const bandWidths = bandClouds.map((list) =>
    list.reduce((w, c) => Math.max(w, c.w), 0)
  );
  const bandX: number[] = [];
  let cursorX = 40;
  for (let i = 0; i < bands; i++) {
    bandX.push(cursorX);
    cursorX += bandWidths[i] + (i < bands - 1 ? CLOUD_GAP : 0);
  }
  const regionW = cursorX - 40;

  const positions = new Map<number, { x: number; y: number }>();
  const bandCursor = new Array(bands).fill(40);
  for (let b = 0; b < bands; b++) {
    for (const cloud of bandClouds[b]) {
      const x0 = bandX[b];
      const y0 = bandCursor[b];
      cloud.list.forEach((node, i) => {
        const col = i % cloud.cols;
        const row = Math.floor(i / cloud.cols);
        positions.set(node.uid, {
          x: x0 + CLOUD_PAD + col * NODE_STEP_X,
          y: y0 + CLOUD_HEAD + row * NODE_STEP_Y,
        });
      });
      bandCursor[b] = y0 + cloud.h + CLOUD_GAP;
    }
  }

  // Этапы: колонки по глубине. Если в этапе много операций — раскладываем их
  // сеткой в несколько подколонок, иначе карта вытягивается на километр вниз.
  const baseX = 40 + regionW + 120;
  const opPos = new Map<number, { x: number; y: number }>();
  let stageX = baseX;
  for (const [depth, list] of [...stageMap.entries()].sort((a, b) => a[0] - b[0])) {
    const wanted = list.map((op) => {
      const ys = op.inputs
        .map((i) => {
          const p = positions.get(i.nodeUid);
          if (p) return p.y + NODE_H / 2;
          const producer = producers.get(i.nodeUid);
          const pp = producer ? opPos.get(producer.uid) : null;
          return pp ? pp.y + BLOCK_H / 2 : null;
        })
        .filter((v): v is number => v != null);
      return {
        op,
        desired: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 40,
      };
    });
    wanted.sort((a, b) => a.desired - b.desired || a.op.uid - b.op.uid);

    const rowsPerCol = 10;
    const subCols = clamp(Math.ceil(wanted.length / rowsPerCol), 1, 6);
    wanted.forEach((w, i) => {
      const sub = Math.floor(i / rowsPerCol);
      const row = i % rowsPerCol;
      const x = stageX + sub * stageGapX;
      const y = 40 + row * stageGapY;
      opPos.set(w.op.uid, { x, y });
      positions.set(w.op.outputUid, { x, y });
    });
    stageX += subCols * stageGapX;
  }
  // Свободные результаты без операции — в первую колонку под операции.
  for (const node of nodes) {
    if (node.kind === 'product' || positions.has(node.uid)) continue;
    positions.set(node.uid, { x: baseX, y: 40 });
  }

  const summary =
    ai?.summary?.trim() ||
    `Облаков: ${clouds.length}, этапов: ${stages.length}, плотная раскладка`;

  return {
    nodes: [...positions.entries()].map(([uid, p]) => ({ uid, x: p.x, y: p.y })),
    ops: [...opPos.entries()].map(([uid, p]) => ({ uid, x: p.x, y: p.y })),
    summary,
    ai: !!ai,
  };
}
