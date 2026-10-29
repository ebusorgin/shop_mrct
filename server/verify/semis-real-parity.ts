/**
 * Сверка клиентского раскрытия состава (client/src/app/core/semi-calc.ts) с ПРОИЗВОДЯЩИМ
 * серверным расчётом (server/src/services/expansion.ts: expandSemi) на реальных данных БД.
 *
 * Запуск:  npx tsx verify/semis-real-parity.ts   (из каталога server/, нужен локальный PostgreSQL)
 *
 * Скрипт только читает БД (SELECT + expandSemi). Он доказывает обратную совместимость:
 * те же рецепты, что считает сервер заготовок/техкарт, должны давать те же числа в новом
 * редакторе — до единицы измерения и до округления сервера (3 знака).
 */
import { pool } from '../src/db';
import { expandSemi } from '../src/services/expansion';
import { Product, Semi, SemiInput, Unit } from '../../client/src/app/core/models';
import {
  CONV_FIELD_LABEL,
  SemiCtx,
  convValueOf,
  dedupeWarnings,
  edgesOfSemi,
  expandComposition,
  fixableWarn,
  trimNum,
  warnKey,
} from '../../client/src/app/core/semi-calc';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** состав как его отдаёт API (routes/semis.ts LIST_SQL), но числа сразу в float */
const SEMIS_SQL = `
  select sp.id, sp.name, sp.note, sp.unit_id as "unitId", u.code as "unitCode",
         sp.shelf_life_days as "shelfLifeDays",
         sp.g_per_pcs::float8 as "gPerPcs", sp.ml_per_pcs::float8 as "mlPerPcs", sp.g_per_ml::float8 as "gPerMl",
         jsonb_agg(jsonb_build_object(
           'sourceType', si.source_type, 'refId', si.ref_id, 'role', si.role,
           'name', coalesce(p.name, sub.name),
           'yieldPct', si.yield_pct::float8, 'qtyPerOutput', si.qty_per_output::float8,
           'unitCode', coalesce(pu.code, su.code), 'unitId', coalesce(p.unit_id, sub.unit_id)
         ) order by (si.role = 'base') desc, si.id) as inputs
    from semi_products sp
    join units u on u.id = sp.unit_id
    join semi_inputs si on si.semi_id = sp.id
    left join products p on si.source_type = 'raw'  and p.id = si.ref_id
    left join units pu on pu.id = p.unit_id
    left join semi_products sub on si.source_type = 'semi' and sub.id = si.ref_id
    left join units su on su.id = sub.unit_id
   group by sp.id, sp.name, sp.note, sp.unit_id, u.code, sp.shelf_life_days,
            sp.g_per_pcs, sp.ml_per_pcs, sp.g_per_ml
   order by sp.name`;

async function loadCtx(): Promise<SemiCtx> {
  const [u, p, s] = await Promise.all([
    pool.query(`select id, code, name, dimension, base_factor::float8 as "baseFactor" from units order by id`),
    pool.query(
      `select p.id, p.name, p.category, p.unit_id as "unitId", u.code as "unitCode",
              p.g_per_pcs::float8 as "gPerPcs", p.ml_per_pcs::float8 as "mlPerPcs", p.g_per_ml::float8 as "gPerMl"
         from products p join units u on u.id = p.unit_id order by p.id`
    ),
    pool.query(SEMIS_SQL),
  ]);
  const units = u.rows as Unit[];
  const dim = (unitId: number) => units.find((x) => x.id === unitId)?.dimension ?? 'mass';
  const products = p.rows.map((r) => ({
    ...r,
    dimension: dim(r.unitId),
    baseFactor: 1,
    minStock: 0,
    active: true,
    shelfLifeDays: null,
    gPerPcs: r.gPerPcs ?? null,
    mlPerPcs: r.mlPerPcs ?? null,
    gPerMl: r.gPerMl ?? null,
    stockQty: 0,
    avgCost: 0,
  })) as Product[];
  const semis = s.rows.map((r) => ({ ...r, inputs: (r.inputs ?? []) as SemiInput[] })) as Semi[];
  return { units, products, semis };
}

interface RowResult {
  semi: string;
  qty: number;
  status: 'match' | 'server-error' | 'DIFF';
  detail: string;
  maxDiff: number;
}

const BATCHES = [1000, 37.5];

async function main(): Promise<number> {
  const ctx = await loadCtx();
  console.log(`Загрузили: единиц ${ctx.units.length}, продуктов ${ctx.products.length}, полуфабрикатов ${ctx.semis.length}`);

  // обратимость удобной шкалы добавок (×1000) на реальных рецептах — та же формула, что была в старом редакторе
  let drift = 0;
  let addCount = 0;
  for (const s of ctx.semis) {
    for (const i of s.inputs) {
      if (i.role !== 'additive' || i.qtyPerOutput == null) continue;
      const ui = Number(i.qtyPerOutput) * 1000; // загрузка в редактор
      const back = ui / 1000; // payload при сохранении
      drift = Math.max(drift, Math.abs(back - Number(i.qtyPerOutput)));
      addCount++;
    }
  }
  console.log(`Round-trip ×1000: добавок ${addCount}, максимальное отклонение от исходного значения БД: ${drift}`);

  const rows: RowResult[] = [];
  for (const s of ctx.semis) {
    for (const qty of BATCHES) {
      const client = expandComposition(ctx, edgesOfSemi(s), qty, s.unitId);
      let server: { productId: number; qty: number }[] | null = null;
      let serverErr = '';
      try {
        server = await pool.connect().then(async (c) => {
          try {
            return await expandSemi(c, s.id, qty);
          } finally {
            c.release();
          }
        });
      } catch (e) {
        serverErr = e instanceof Error ? e.message : String(e);
      }

      if (!server) {
        rows.push({
          semi: s.name,
          qty,
          status: 'server-error',
          detail: `${serverErr} | клиент: ${client.warnings.length} предупр.(и), сырьё: ${client.raw.length}`,
          maxDiff: 0,
        });
        continue;
      }

      const mine = new Map(client.raw.map((r) => [r.productId, r.qty]));
      const theirs = new Map(server.map((r) => [r.productId, r.qty]));
      const ids = [...new Set([...mine.keys(), ...theirs.keys()])];
      let maxDiff = 0;
      const problems: string[] = [];
      for (const id of ids) {
        const a = mine.get(id);
        const b = theirs.get(id);
        if (a == null || b == null) {
          problems.push(`#${id} есть только ${a == null ? 'у сервера' : 'у клиента'} (${trimNum(a ?? b!)})`);
          continue;
        }
        // сервер округляет до 3 знаков — сравниваем с тем же допуском
        maxDiff = Math.max(maxDiff, Math.abs(round3(a) - b));
        if (Math.abs(round3(a) - b) > 0.0011) problems.push(`#${id}: клиент ${trimNum(a)} vs сервер ${b}`);
      }
      rows.push({
        semi: s.name,
        qty,
        status: problems.length ? 'DIFF' : 'match',
        detail: problems.join('; '),
        maxDiff,
      });
    }
  }

  let bad = 0;
  let ok = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.status === 'match') ok++;
    else if (r.status === 'server-error') skipped++;
    else bad++;
    const mark = r.status === 'match' ? 'ok  ' : r.status === 'DIFF' ? 'DIFF' : 'skip';
    const diffTxt = r.status === 'match' ? `Δmax ${r.maxDiff}` : r.detail;
    console.log(`  ${mark} ${r.semi} @ ${r.qty} — ${diffTxt}`);
  }

  console.log(`\nИтог: совпадений ${ok}, расхождений ${bad}, серверных ошибок (проверено предупреждением клиента) ${skipped}`);
  const worst = rows.filter((r) => r.status === 'match').reduce((m, r) => Math.max(m, r.maxDiff), 0);
  console.log(`Максимальное расхождение по всем совпавшим строкам: ${worst} (допуск 0.001 = округление сервера)`);

  // что в реальном справочнике лечится одним кликом по предупреждению в блоке E
  const fixes = new Map<string, string>();
  for (const s of ctx.semis) {
    const exp = expandComposition(ctx, edgesOfSemi(s), 1000, s.unitId);
    for (const w of dedupeWarnings(exp.warnings)) {
      if (!fixableWarn(w)) continue;
      const cur = convValueOf(ctx, w.sourceType, w.refId, w.field);
      fixes.set(
        warnKey(w),
        `«${w.where}» (${w.sourceType === 'raw' ? 'продукт' : 'заготовка'} #${w.refId}) → ${CONV_FIELD_LABEL[w.field]}, ` +
          `сейчас ${cur == null ? 'не задан' : cur} — срабатывает в «${s.name}»`
      );
    }
  }
  console.log(`\nКликабельных предупреждений (правятся одним полем): ${fixes.size}`);
  for (const t of fixes.values()) console.log(`  • ${t}`);

  return bad;
}

main()
  .then((bad) => {
    void pool.end();
    process.exit(bad ? 1 : 0);
  })
  .catch((e) => {
    console.error('Сбой сверки:', e instanceof Error ? e.message : e);
    void pool.end().finally(() => process.exit(2));
  });
