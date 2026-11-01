/**
 * Генерация блок-схем (столов конструктора) для всех полуфабрикатов.
 *
 * У каждой заготовки из рецепта (semi_inputs) строится board = {blocks, links}:
 *   • один центральный блок-сборка (note) с именем заготовки;
 *   • по одному блоку-ингредиенту на каждый вход, соединённых связью в сборку;
 *   • на связи — «выход после обработки» (yieldPct), в блоке — грубое количество до потерь.
 *
 * По умолчанию трогаются только заготовки без стола (board null/пустой) —
 * вручную нарисованные схемы не перезаписываются. Флаг --all пересобирает стол
 * заново у всех, флаг --dry ничего не пишет (только отчёт).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require(require('path').join(__dirname, '..', 'dist', 'db'));

const args = new Set(process.argv.slice(2));
const ALL = args.has('--all');
const DRY = args.has('--dry');

/** net → gross: сколько грубо клали, чтобы после % осталось net. */
function grossQty(net, yieldPct) {
  const y = Number(yieldPct);
  const val = Number.isFinite(y) && y > 0 && y <= 100 ? net / (y / 100) : net;
  // убираем хвостовые нули: 100.000000 → "100"
  return String(parseFloat(val.toFixed(6)));
}

/**
 * Один рецепт → стол. Компонуем inputs в аккуратную «веерную» раскладку:
 * ингредиенты в колонках слева, сборка справа по центру высоты.
 */
function buildBoard(semi) {
  const inputs = Array.isArray(semi.inputs) ? semi.inputs : [];
  if (!inputs.length) return null;

  const PER_COL = 9;
  const CARD_W = 232;
  const CARD_H = 84;
  const GAP_X = 48;
  const GAP_Y = 32;
  const LEFT = 40;
  const TOP = 40;

  const cols = Math.ceil(inputs.length / PER_COL);
  const rows = Math.min(inputs.length, PER_COL);

  const blocks = [];
  const links = [];

  // центральный блок-сборка (uid = 1)
  const noteX = LEFT + cols * (CARD_W + GAP_X);
  const noteY = TOP + Math.round((rows * (CARD_H + GAP_Y) - GAP_Y) / 2) - 20;
  blocks.push({
    uid: 1,
    kind: 'note',
    sourceType: 'raw',
    refId: 0,
    name: '',
    title: String(semi.name ?? ''),
    x: noteX,
    y: Math.max(TOP, noteY),
    qty: '',
    unitCode: String(semi.unitCode ?? ''),
  });

  inputs.forEach((inp, i) => {
    const col = Math.floor(i / PER_COL);
    const row = i % PER_COL;
    const x = LEFT + col * (CARD_W + GAP_X);
    const y = TOP + row * (CARD_H + GAP_Y);
    const uid = i + 2;
    blocks.push({
      uid,
      kind: 'ingredient',
      sourceType: inp.sourceType === 'semi' ? 'semi' : 'raw',
      refId: Number(inp.refId) || 0,
      name: String(inp.name ?? ''),
      title: '',
      x,
      y,
      qty: grossQty(Number(inp.qty) || 0, inp.yieldPct),
      unitCode: String(inp.unitCode ?? ''),
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

function boardIsEmpty(board) {
  if (!board) return true;
  const b = typeof board === 'string' ? JSON.parse(board) : board;
  return !b || !Array.isArray(b.blocks) || b.blocks.length === 0;
}

async function main() {
  const { rows } = await pool.query(`
    select sp.id, sp.name, u.code as "unitCode", sp.out_qty::float8 as "outQty", sp.board,
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'sourceType', si.source_type, 'refId', si.ref_id,
                 'name', coalesce(p.name, sub.name),
                 'qty', si.qty_per_output::float8, 'yieldPct', si.yield_pct::float8,
                 'unitCode', coalesce(pu.code, su.code)
               ) order by si.id
             ) filter (where si.id is not null),
             '[]'::jsonb
           ) as inputs
      from semi_products sp
      join units u on u.id = sp.unit_id
      left join semi_inputs si on si.semi_id = sp.id
      left join products p on si.source_type = 'raw'  and p.id = si.ref_id
      left join units pu on pu.id = p.unit_id
      left join semi_products sub on si.source_type = 'semi' and sub.id = si.ref_id
      left join units su on su.id = sub.unit_id
     group by sp.id, u.code
     order by sp.name`);

  let touched = 0;
  let skipped = 0;
  for (const semi of rows) {
    const skipExisting = !ALL && !boardIsEmpty(semi.board);
    if (skipExisting) { skipped++; continue; }
    const board = buildBoard(semi);
    if (!board) { skipped++; continue; }
    touched++;
    const tag = `${semi.name} (${board.blocks.length - 1} составл.)`;
    if (DRY) {
      console.log(`[dry]  #${semi.id} — сгенерировал бы стол: ${tag}`);
      continue;
    }
    await pool.query('update semi_products set board = $2::jsonb where id = $1', [semi.id, JSON.stringify(board)]);
    console.log(`[ok]   #${semi.id} — стол построен: ${tag}`);
  }

  console.log(`\nВсего заготовок: ${rows.length}. Обновлено столов: ${touched}. Пропущено (уже есть стол): ${skipped}. ${DRY ? '(dry-run, ничего не записано)' : ''}`);
  await pool.end();
}

main().catch((e) => {
  console.error('FAIL', e.message ?? e);
  process.exit(1);
});
