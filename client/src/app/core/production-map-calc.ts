import { MapNodeKind, Product, Unit } from './models';
import { toBaseClient } from './units';

/**
 * Расчёт единой карты производства.
 *
 * Количество входа задаётся на связи: каждая операция берёт из общего состояния/
 * сырья столько, сколько нужно ей. Состояние производится один раз, а расходуется
 * несколькими ветками; себестоимость и человекочасы делятся между потребителями
 * пропорционально взятому количеству.
 */

export interface CalcMapNode {
  uid: number;
  kind: MapNodeKind;
  refId: number | null;
  name: string;
  unitId: number | null;
  unitCode: string;
  portionQty: number;
}

export interface CalcMapInput {
  nodeUid: number;
  qty: number;
  inMass: boolean;
  /** Потери на связи, % (уварка, очистки). */
  lossPct: number | null;
}

export interface CalcMapOp {
  uid: number;
  name: string;
  yieldPct: number | null;
  /** Партия (N) — сколько продукта получаем; ингредиенты должны давать ровно N. */
  planQty: number | null;
  /** Единица партии (г/мл). */
  planUnitId: number | null;
  laborHours: number;
  outputUid: number;
  inputs: CalcMapInput[];
}

export interface MapCalcNode {
  producedQty: number;
  cost: number;
  labor: number;
  usedQty: number;
  warnings: string[];
}

export interface MapCalcOp {
  outputQty: number;
  /** Сумма ингредиентов, пересчитанная в единицу выхода (до применения партии). */
  massQty: number;
  /** Сумма ингредиентов до вычета потерь. */
  grossMassQty: number;
  cost: number;
  labor: number;
  warnings: string[];
}

export interface MapCalcDish {
  uid: number;
  name: string;
  outputQty: number;
  cost: number;
  labor: number;
  portionQty: number;
  portions: number;
  costPerPortion: number | null;
  laborPerPortion: number | null;
  warnings: string[];
}

export interface ProductionMapCalc {
  nodes: Record<number, MapCalcNode>;
  ops: Record<number, MapCalcOp>;
  dishes: Record<number, MapCalcDish>;
  warnings: string[];
}

const num = (v: string | number | null | undefined): number => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isFinite(n) ? n : 0;
};


const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function calcProductionMap(
  nodes: CalcMapNode[],
  ops: CalcMapOp[],
  products: Product[],
  units: Unit[]
): ProductionMapCalc {
  const warnings: string[] = [];
  const byUid = new Map(nodes.map((n) => [n.uid, n] as const));
  const productById = new Map(products.map((p) => [p.id, p]));

  const nodeCalc = new Map<number, MapCalcNode>();
  const opCalc = new Map<number, MapCalcOp>();

  // Потребление по узлам — для проверки «израсходовано больше, чем произведено».
  const used = new Map<number, number>();
  for (const op of ops) {
    for (const input of op.inputs) {
      used.set(input.nodeUid, (used.get(input.nodeUid) ?? 0) + num(input.qty));
    }
  }

  for (const n of nodes) {
    if (n.kind !== 'product') continue;
    const p = n.refId == null ? undefined : productById.get(n.refId);
    const nodeWarnings: string[] = [];
    if (!p) nodeWarnings.push('сырьё не найдено в номенклатуре');
    nodeCalc.set(n.uid, {
      producedQty: 0,
      cost: 0,
      labor: 0,
      usedQty: round3(used.get(n.uid) ?? 0),
      warnings: nodeWarnings,
    });
  }

  // Операции по готовности: все входы должны быть рассчитаны.
  const pending = new Set(ops.map((o) => o.uid));
  let guard = 0;
  while (pending.size && ++guard < ops.length + 3) {
    let progressed = false;
    for (const op of ops) {
      if (!pending.has(op.uid)) continue;
      const ready = op.inputs.every((i) => nodeCalc.has(i.nodeUid));
      if (!ready) continue;

      const opWarnings: string[] = [];
      const outNode = byUid.get(op.outputUid);
      if (!outNode || outNode.kind === 'product') {
        opWarnings.push('выход операции должен быть состоянием или блюдом');
        opCalc.set(op.uid, { outputQty: 0, massQty: 0, grossMassQty: 0, cost: 0, labor: 0, warnings: opWarnings });
        pending.delete(op.uid);
        progressed = true;
        continue;
      }
      if (!op.inputs.length) opWarnings.push('у операции нет входов');

      let mass = 0;
      let grossMass = 0;
      let cost = 0;
      let labor = num(op.laborHours);
      for (const input of op.inputs) {
        const src = byUid.get(input.nodeUid);
        if (!src) {
          opWarnings.push('вход операции не найден');
          continue;
        }
        const qty = num(input.qty);
        if (!(qty > 0)) opWarnings.push(`не указано количество для «${src.name}»`);
        // входы — нетто в продукте; потери увеличивают закупку/списание (брутто)
        const keep = 1 - Math.min(100, Math.max(0, num(input.lossPct))) / 100;
        const grossQty = keep > 0 ? qty / keep : qty;

        if (src.kind === 'product') {
          const p = src.refId == null ? undefined : productById.get(src.refId);
          if (!p) {
            opWarnings.push(`сырьё «${src.name}» не найдено`);
            continue;
          }
          const inputCost = grossQty * p.avgCost;
          cost += inputCost;
          const m = toBaseClient(units, qty, src.unitId ?? p.unitId, outNode.unitId, {
            gPerPcs: p.gPerPcs,
            mlPerPcs: p.mlPerPcs,
            gPerMl: p.gPerMl,
          });
          if (m == null) opWarnings.push(`нельзя перевести «${p.unitCode}» в «${outNode.unitCode}» — задайте коэффициент`);
          else if (input.inMass) {
            grossMass += m;
            mass += m;
          }
          continue;
        }

        const srcCalc = nodeCalc.get(src.uid);
        if (!srcCalc) continue;
        const produced = srcCalc.producedQty;
        if (!(produced > 0)) opWarnings.push(`у состояния «${src.name}» нулевой выход`);
        const m = produced > 0 ? toBaseClient(units, qty, src.unitId, outNode.unitId, null) : null;
        if (m == null) opWarnings.push(`нельзя перевести «${src.unitCode}» в «${outNode.unitCode}»`);
        else if (input.inMass) {
            grossMass += m;
            mass += m;
          }
        const k = produced > 0 ? grossQty / produced : 0;
        cost += srcCalc.cost * k;
        labor += srcCalc.labor * k;
      }

      // Техкарта операции: партия N задаёт выход; состав и потери на связях
      // на этом этапе не пересчитываются — они пойдут в списание при отгрузке готового.
      const rawPlan = num(op.planQty);
      const outUnit = outNode.unitId;
      const converted = rawPlan > 0 && outUnit
        ? toBaseClient(units, rawPlan, op.planUnitId ?? outUnit, outUnit, null)
        : null;
      const plan = rawPlan > 0 ? converted ?? rawPlan : 0;
      const outputQty = plan > 0 ? plan : mass;
      if (plan > 0 && Math.abs(plan - mass) > 0.01) {
        opWarnings.push(
          `партия ${round3(plan)} ≠ сумма ${round3(mass)} ${outNode.unitCode}`
        );
      }
      nodeCalc.set(outNode.uid, {
        producedQty: outputQty,
        cost,
        labor,
        usedQty: round3(used.get(outNode.uid) ?? 0),
        warnings: opWarnings.slice(),
      });
      opCalc.set(op.uid, { outputQty, massQty: round3(mass), grossMassQty: round3(grossMass), cost, labor, warnings: opWarnings });
      pending.delete(op.uid);
      progressed = true;
    }
    if (!progressed) break;
  }

  if (pending.size) warnings.push('часть операций не рассчитана: проверьте циклы и связи');

  // Состояния и блюда без производителя.
  for (const n of nodes) {
    if (n.kind === 'product') continue;
    if (!nodeCalc.has(n.uid)) {
      nodeCalc.set(n.uid, {
        producedQty: 0,
        cost: 0,
        labor: 0,
        usedQty: round3(used.get(n.uid) ?? 0),
        warnings: ['у состояния нет операции-производителя'],
      });
    }
  }

  // Перерасход состояний.
  for (const n of nodes) {
    if (n.kind === 'product') continue;
    const calc = nodeCalc.get(n.uid)!;
    const out = used.get(n.uid) ?? 0;
    if (calc.producedQty > 0 && out > calc.producedQty + 0.001) {
      calc.warnings.push(
        `израсходовано ${round3(out)} ${n.unitCode}, произведено ${round3(calc.producedQty)} ${n.unitCode}`
      );
    }
  }

  const dishes: Record<number, MapCalcDish> = {};
  for (const n of nodes) {
    if (n.kind !== 'output') continue;
    const calc = nodeCalc.get(n.uid)!;
    const portion = num(n.portionQty);
    const outputQty = calc.producedQty;
    const portions = portion > 0 && outputQty > 0 ? outputQty / portion : 0;
    dishes[n.uid] = {
      uid: n.uid,
      name: n.name,
      outputQty: round3(outputQty),
      cost: round2(calc.cost),
      labor: round3(calc.labor),
      portionQty: portion,
      portions: round3(portions),
      costPerPortion: portions > 0 ? round2(calc.cost / portions) : null,
      laborPerPortion: portions > 0 ? round3(calc.labor / portions) : null,
      warnings: calc.warnings.slice(),
    };
  }

  for (const c of nodeCalc.values()) {
    for (const w of c.warnings) warnings.push(w);
  }
  for (const c of opCalc.values()) {
    for (const w of c.warnings) warnings.push(w);
  }

  return {
    nodes: Object.fromEntries(nodeCalc),
    ops: Object.fromEntries(opCalc),
    dishes,
    warnings: [...new Set(warnings)],
  };
}
