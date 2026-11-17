import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Router } from 'express';
import { pool, tx } from '../db';
import { config } from '../config';
import { ApiError, optNum, reqArr, reqNum, reqStr, wrap } from '../http';
import { parseWaybillDoc, CatalogProduct } from '../services/llm';
import { convertAcross, type ProdConv } from '../services/expansion';
import { ingestWaybill } from './waybills';
import { audit, auditTx, type Actor } from '../services/audit';
import { logSink, type LogKind } from '../services/ws-log';
import {
  detectRotationsAsync,
  prepareVisionFilesAsync,
  runAuditReader,
  runHeaderTotalsAgent,
  runReaderAgent,
  runStructurerAgent,
  type AgentDoc,
} from '../services/invoice-agents';
import { classifyNewProduct, findLexEntry, lexIdentity, matchByMeaning } from '../services/product-lexicon';
import { isPlaceholderSupplier, resolveOrCreateSupplier } from '../services/supplier-match';

export const importRouter = Router();

/** Нормализация имени для матчинга: lower, ё->е, только буквы/цифры, одиночные пробелы. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ').trim();
}

/**
 * Служебные строки накладной, которые НЕ являются товаром. Разделяем на три рода:
 *  - 'discount' — скидки/промо («POPUST», «POUPST: … Kupi više, plati manje!», Akcija/Bonus/Gratis/Rabat);
 *  - 'service'  — плата/доставка/возврат и прочие не-товарные начисления (Naplata/Dostava/Povrat/-Zaokruzivanje);
 *  - 'total'    — строки итогов (Ukupno/Sveukupno/Rekapitulacija/Vrednost/Osnova/PDV/Porez) — они уже
 *    приходят отдельными полями документа (totalSum/totalVat/totalGross), в позиции не превращаем.
 * Модель иногда всё равно пропускает такие строки в items — отбираем детерминированно, чтобы склад
 * не пополнялся «товаром-скидкой». Сербские диакритики сводим к ASCII (š→s, ć/č→c, ž→z, đ→dj).
 */
const DISCOUNT_RE =
  /\b(popust|poupst|popst|rabat|akcija|akcijski|bonus|gratis|gratis|poklon|promocija)\b|plati\s+manje|kupi\s+vise|попуст|скидк/i;
const SERVICE_RE =
  /\b(naplata|povrat|povracen|rezervacija|dostava|delovna|ostatak)\b|заокру|доставка|наплата/i;
const TOTAL_RE =
  /\b(sveukupno|ukupno|rekapitulacija|porez|pdv|vrednost|vrijednost|osnova)\b|итого|всего/i;

/** Род не-товарной строки или null, если это обычная позиция. */
export function classifyNonProduct(name: string): 'discount' | 'service' | 'total' | null {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/đ/g, 'dj')
    .replace(/š/g, 's')
    .replace(/[ćč]/g, 'c')
    .replace(/ž/g, 'z');
  if (DISCOUNT_RE.test(s)) return 'discount';
  if (SERVICE_RE.test(s)) return 'service';
  if (TOTAL_RE.test(s)) return 'total';
  return null;
}

/**
 * Единицы, напечатанные в документе -> базовые (код склада + сколько базовых в 1 напечатанной).
 * Ключи — нормализованные (normName) написания: kg, KG, «килограмм» -> 'кг'.
 * Хранение и API — строго в базовых (г/мл/шт): количество умножаем, цену делим — сумма строки не меняется.
 */
const DOC_UNITS: Record<string, { code: string; factor: number }> = {
  г: { code: 'г', factor: 1 }, гр: { code: 'г', factor: 1 }, грамм: { code: 'г', factor: 1 },
  граммов: { code: 'г', factor: 1 }, грамма: { code: 'г', factor: 1 }, грам: { code: 'г', factor: 1 },
  g: { code: 'г', factor: 1 }, gr: { code: 'г', factor: 1 }, gram: { code: 'г', factor: 1 }, grams: { code: 'г', factor: 1 },
  кг: { code: 'г', factor: 1000 }, kg: { code: 'г', factor: 1000 }, kilograms: { code: 'г', factor: 1000 },
  kilos: { code: 'г', factor: 1000 }, kilo: { code: 'г', factor: 1000 },
  килограмм: { code: 'г', factor: 1000 }, килограммов: { code: 'г', factor: 1000 }, килограмма: { code: 'г', factor: 1000 },
  т: { code: 'г', factor: 1000000 }, тонна: { code: 'г', factor: 1000000 }, тонн: { code: 'г', factor: 1000000 },
  тонны: { code: 'г', factor: 1000000 }, тоннов: { code: 'г', factor: 1000000 }, тона: { code: 'г', factor: 1000000 },
  ton: { code: 'г', factor: 1000000 }, tons: { code: 'г', factor: 1000000 }, tone: { code: 'г', factor: 1000000 },
  мл: { code: 'мл', factor: 1 }, ml: { code: 'мл', factor: 1 }, миллилитр: { code: 'мл', factor: 1 },
  миллилитров: { code: 'мл', factor: 1 }, миллилитра: { code: 'мл', factor: 1 },
  л: { code: 'мл', factor: 1000 }, l: { code: 'мл', factor: 1000 }, lk: { code: 'мл', factor: 1000 }, liter: { code: 'мл', factor: 1000 },
  liters: { code: 'мл', factor: 1000 }, litres: { code: 'мл', factor: 1000 }, litre: { code: 'мл', factor: 1000 },
  литр: { code: 'мл', factor: 1000 }, литров: { code: 'мл', factor: 1000 },
  литра: { code: 'мл', factor: 1000 },
  шт: { code: 'шт', factor: 1 }, шт1: { code: 'шт', factor: 1 }, штука: { code: 'шт', factor: 1 },
  штук: { code: 'шт', factor: 1 }, szt: { code: 'шт', factor: 1 }, pcs: { code: 'шт', factor: 1 },
  pc: { code: 'шт', factor: 1 }, kom: { code: 'шт', factor: 1 }, komada: { code: 'шт', factor: 1 },
  ko: { code: 'шт', factor: 1 }, komad: { code: 'шт', factor: 1 }, kos: { code: 'шт', factor: 1 },
  ut: { code: 'шт', factor: 1 }, dose: { code: 'шт', factor: 1 },
  packung: { code: 'шт', factor: 1 }, pakovanje: { code: 'шт', factor: 1 },
  des: { code: 'шт', factor: 10 }, десяток: { code: 'шт', factor: 10 }, десятков: { code: 'шт', factor: 10 },
  dozen: { code: 'шт', factor: 10 },
};

/** Базовое количество с разумной точностью (г/мл до тысячных, шт до целых не тянем — дробные упаковки). */
const roundQty = (n: number): number => Math.round(n * 1000) / 1000;
/** Цена за базовую единицу: 95 ₽/кг -> 0.095 ₽/г, мусс float отрезаем на 10 знаках. */
const roundPriceBase = (n: number): number => Math.round(n * 1e10) / 1e10;

/**
 * Фасовка, написанная внутри названия позиции: «лист лавровый 15 грамм», «1.5kg jogurt 1%MM PET», «сок 1 л».
 * Используется ТОЛЬКО как страховка: решение о фасовке принимает GPT (countAs/packQty/packUnit),
 * регулярка ни количество, ни цену не меняет — она лишь подсвечивает человеку случай,
 * когда GPT не заметил написанный в названии вес.
 * \b и \w в JS ASCII-only (кириллические окончания «-ов/-а» не ловили) — границы через look-ahead,
 * хвосты слов через \p{L} (флаг u).
 */
const PKG_RE =
  /(\d+(?:[.,]\d+)?)\s*(грам\p{L}*|grams?|gr|гр|килограм\p{L}*|кг|kg|lk|мл|ml|миллилитр\p{L}*|mililitr\p{L}*|литр\p{L}*|liters?|l|л|тон\p{L}*|tons?|т|g|г)(?![\p{L}\p{N}])/giu;

/** Мультиупаковка в названии: «JAJA 30/1», «180/1 kutija», «6/1» — N штук содержимого. */
const MULTIPACK_RE = /(?:^|[^\d])(\d{1,4})\s*\/\s*1(?![\d])/;

/** -> { code: базовая г/мл, per: фасовка в базовых } или null, если в названии фасовки нет. */
export function pkgFromName(name: string): { code: string; per: number } | null {
  for (const m of name.matchAll(PKG_RE)) {
    const num = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(num) || num <= 0) continue;
    const du = DOC_UNITS[normName(m[2])];
    if (du && du.code !== 'шт') return { code: du.code, per: num * du.factor };
  }
  const mp = name.match(MULTIPACK_RE);
  if (mp) {
    const n = parseInt(mp[1], 10);
    if (isFinite(n) && n > 1) return { code: 'шт', per: n };
  }
  return null;
}

interface UnitRow { id: number; code: string; factor: number; dimension: string }

/**
 * Замечание строки (notes из baseLine) начинается с «Название»: — в карточке позиции название
 * уже стоит первой строкой, поэтому префикс срезаем иначе текст читается как «то же имя» дважды.
 */
export function stripLineName(note: string, name: string): string {
  const text = note.trim();
  const prefix = `«${name}»`;
  if (!text.startsWith(prefix)) return text;
  const rest = text.slice(prefix.length).replace(/^\s*[:—–-]\s*/, '').trim();
  return rest || text;
}

/** Что GPT решила про строку (смысл), в отличие от того, что напечатано (числа). */
export interface LineRead {
  name: string;
  unitCode: string | null;
  qty: number | null;
  price: number | null;
  lineSum: number | null;
  countAs: 'contents' | 'pieces' | null;
  packQty: number | null;
  packUnit: string | null;
  baseUnit: string | null;
  doubt: string | null;
}

/** Дата из транскрипции «ДАТА: 26.4.2026» -> 2026-04-26 (без перестановки дня и месяца). */
function dateFromTranscript(transcript: string): string | null {
  const m = transcript.match(/^\s*ДАТА\s*:\s*(.+)$/im);
  if (!m) return null;
  const raw = m[1].trim();
  const dmy = raw.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2100) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return iso ? iso[0] : null;
}

/**
 * «Каталог» иногда меняет местами нетто и PDV. Если сумма и налог в сумме дают
 * «к оплате», но PDV больше нетто — это перестановка, возвращаем на места.
 */
function fixSwappedTotals(doc: AgentDoc): string | null {
  const sum = doc.totalSum;
  const vat = doc.totalVat;
  const gross = doc.totalGross;
  if (sum == null || vat == null || gross == null) return null;
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.002);
  if (!close(sum + vat, gross)) return null;
  if (vat > sum) {
    doc.totalSum = vat;
    doc.totalVat = sum;
    return 'Итоги нетто и PDV были перепутаны местами — исправил по сумме «к оплате»';
  }
  return null;
}

/** Применить детерминированные уточнения к разобранному документу. */
function normalizeAgentDoc(doc: AgentDoc, transcript: string, notes: string[]): void {
  const date = dateFromTranscript(transcript);
  if (date && doc.date !== date) {
    doc.date = date;
    notes.push(`Дата взята из напечатанного «Datum»: ${date}`);
  }
  const totals = fixSwappedTotals(doc);
  if (totals) notes.push(totals);
}

/** Русское склонение после числа: 1 позиция, 3 позиции, 5 позиций. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/**
 * Сомнение модели — в читаемый вид: без служебных «id 29», префиксов и пустых скобок.
 * Пользователь должен увидеть понятное замечание, а не отладочный вывод агента.
 */
function cleanDoubtText(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s)
    .replace(/\b(?:id|ID)\s*[:#№]?\s*\d+\b/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;.:])/g, '$1')
    .replace(/^[-–—:;\s]+|[-–—:;\s]+$/g, '')
    .trim();
  return t || null;
}

/**
 * Строка документа -> базовые единицы склада (г/мл/шт). Чистая функция — тестируется без GPT.
 * СМЫСЛ строки (что это за товар и в чём его класть) решает GPT: countAs + packQty/packUnit.
 * Здесь только арифметика, которая сохраняет деньги строки:
 *  - напечатанная единица (kg/l/ml/дес.) -> базовая: qty ×factor, цена ÷factor;
 *  - countAs="contents" и напечатаны упаковки (kom/szt/непонятная единица)
 *    -> qty = число упаковок × фасовка, цена = деньги строки ÷ это количество;
 *  - весовая строка (Кол уже в kg/g/l) остаётся как есть — содержимое не удваиваем.
 * Всё, в чём модель не уверена, и всё, что расходится с названием, отдаём человеку через doubt/notes.
 */
export function baseLine(
  line: LineRead,
  opts: {
    units: Map<string, UnitRow>;
    printed?: { code: string; factor: number };
    productUnitCode?: string | null;
    /** коэффициенты пересчёта размерностей у найденного товара — если заданы, кросс-размерный приход возможен */
    productConv?: ProdConv | null;
  }
): { qty: number | null; price: number | null; unitCode: string | null; unitId: number | null; forecast: boolean; doubt: string | null; notes: string[] } {
  const { units, printed, productUnitCode, productConv } = opts;
  const notes: string[] = [];
  const name = `«${line.name}»`;
  let qty = printed && line.qty != null ? roundQty(line.qty * printed.factor) : line.qty;
  let price = printed && line.price != null ? roundPriceBase(line.price / printed.factor) : line.price;
  let code = printed ? printed.code : null;
  let unitId = (printed && units.get(printed.code)?.id) ?? null;
  let forecast = false;
  let doubt: string | null = cleanDoubtText(line.doubt);

  // фасовка, о которой сказала модель (в базовых единицах), либо null
  const baseHint = line.baseUnit ? DOC_UNITS[normName(line.baseUnit)]?.code ?? null : null;
  const packDu = line.packUnit ? DOC_UNITS[normName(line.packUnit)] : undefined;
  // фасовка, о которой сказала модель (в базовых единицах), либо null.
  // Единица содержимого бывает и счётной — мультиупаковка («яйца 180/1»: в коробке 180 шт,
  // пришли 2 коробки). Такую учитываем содержимым только когда в 1 закупочной единице >1 штуки;
  // «1 шт = предмет» (per === 1) остаётся штуками, множиться не на что.
  const packFromUnit =
    line.packQty != null && packDu
      ? { code: packDu.code, per: roundQty(line.packQty * packDu.factor) }
      : null;
  const pack =
    (packFromUnit && (packFromUnit.code !== 'шт' || packFromUnit.per > 1) ? packFromUnit : null) ??
    // фасовку назвали, а единицу — нет: верим baseUnit модели (г/мл/шт), число считаем уже в ней
    (line.packQty != null && baseHint && (baseHint !== 'шт' || line.packQty > 1)
      ? { code: baseHint, per: roundQty(line.packQty) }
      : null);

  /** деньги строки: напечатанная сумма надёжнее, чем цена × количество из кривых колонок */
  const lineMoney = (): number | null => {
    if (line.lineSum != null && line.lineSum > 0) return line.lineSum;
    if (line.qty != null && line.price != null) return line.qty * line.price;
    return null;
  };

  const asContents = (p: { code: string; per: number }, why: string) => {
    const weightLine = printed && printed.code !== 'шт'; // Кол уже в г/кг/мл/л — упаковки нет, множиться не на что
    if (weightLine) {
      notes.push(`${name}: ИИ предложил считать содержимым (${trimNum(p.per)} ${p.code} в упаковке), но количество в строке уже весовое (${trimNum(line.qty ?? 0)} ${line.unitCode}) — оставляю как напечатано`);
      return;
    }
    const packages = line.qty != null ? line.qty * (printed ? printed.factor : 1) : 1;
    const total = roundQty(packages * p.per);
    const money = lineMoney();
    qty = total;
    price = money != null && total > 0 ? roundPriceBase(money / total) : line.price != null ? roundPriceBase(line.price / p.per) : line.price;
    code = p.code;
    unitId = units.get(p.code)?.id ?? null;
    forecast = true;
    notes.push(`${name}: ${why} — на склад ${trimNum(packages)} упак × ${trimNum(p.per)} ${p.code} = ${trimNum(total)} ${p.code}, цена пересчитана за ${p.code} (сумма строки ${money != null ? trimNum(money) : '—'} не меняется), проверьте`);
  };

  if (line.countAs === 'contents') {
    if (pack) {
      asContents(pack, `Считается содержимым: фасовка ${trimNum(pack.per)} ${pack.code}`);
    } else {
      const pkg = pkgFromName(line.name);
      if (pkg) {
        asContents(pkg, `Считается содержимым, но фасовка не названа — принял ${trimNum(pkg.per)} ${pkg.code} из названия`);
      } else {
        doubt = doubt ?? 'ИИ предложил считать содержимым, но размер упаковки не назван — укажите количество и единицу вручную';
        notes.push(`${name}: ${doubt}`);
      }
    }
  } else if (line.countAs === 'pieces') {
    // страховка: фасовка в названии написана, а модель настаивает на штуках — пусть человек посмотрит
    const pkg = pkgFromName(line.name);
    if (pkg && printed && printed.code === 'шт') {
      notes.push(`${name}: ИИ считает позицию штуками, но в названии написана фасовка ${trimNum(pkg.per)} ${pkg.code} — проверьте, не надо ли положить ${trimNum((line.qty ?? 1) * (printed.factor ?? 1) * pkg.per)} ${pkg.code}`);
      doubt = doubt ?? `в названии фасовка ${trimNum(pkg.per)} ${pkg.code}, а посчитано штуками`;
    }
  }

  if (code && productUnitCode && productUnitCode !== code) {
    // базовые коды г/мл/шт -> размерность; кросс-размерный приход законен, если у товара есть коэффициент
    const DIM: Record<string, string> = { г: 'mass', мл: 'volume', шт: 'count' };
    const dCode = DIM[code];
    const dProd = DIM[productUnitCode];
    let convertible = false;
    if (dCode && dProd && dCode !== dProd && productConv) {
      try {
        convertAcross(dCode, dProd, 1, productConv);
        convertible = true;
      } catch {
        convertible = false;
      }
    }
    if (convertible) {
      notes.push(`${name}: на складе позиция в «${productUnitCode}», а строка даёт «${code}» — приход пересчитаем по коэффициенту пересчёта товара`);
    } else {
      notes.push(`${name}: на складе позиция хранится в «${productUnitCode}», а по документу это «${code}» — смените единицу товара (или задайте коэффициент в номенклатуре), иначе приход не пройдёт`);
    }
  }
  return { qty, price, unitCode: code, unitId, forecast, doubt, notes };
}

/** Каталог + алиасы — и для промпта, и для детерминированного матчинга. */
async function loadCatalog(): Promise<{ products: CatalogProduct[]; byNormName: Map<string, CatalogProduct>; byAlias: Map<string, CatalogProduct> }> {
  const { rows } = await pool.query(`
    select p.id, p.name, p.category, u.code as "unitCode",
           coalesce(json_agg(distinct a.alias_raw) filter (where a.alias_raw is not null), '[]')::jsonb as aliases
      from products p
      join units u on u.id = p.unit_id
      left join product_aliases a on a.product_id = p.id
     where p.active
     group by p.id, p.name, p.category, u.code
     order by p.name`);
  const products = rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    category: r.category as string,
    unitCode: r.unitCode as string,
    aliases: (r.aliases as string[]) ?? [],
  }));
  const byNormName = new Map(products.map((p) => [normName(p.name), p]));
  const byAlias = new Map<string, CatalogProduct>();
  for (const p of products) for (const a of p.aliases) byAlias.set(normName(a), p);
  return { products, byNormName, byAlias };
}

async function loadUnitRows(): Promise<UnitRow[]> {
  const { rows } = await pool.query(`select id, code, base_factor::float8 as factor, dimension from units`);
  return rows;
}

/** Числа для человекочитаемых предупреждений. */
function trimNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Кандидаты по нечёткому совпадению (trigram) — для выпадашки «выбрать из существующих». */
async function trgmCandidates(norm: string): Promise<{ productId: number; name: string; sim: number }[]> {
  const { rows } = await pool.query(
    `select t.product_id as "productId", t.name, max(t.sim)::float8 as sim
       from (
         select p.id as product_id, p.name, similarity(p.name, $1) as sim
           from products p where similarity(p.name, $1) > 0.30
         union all
         select a.product_id, p.name, similarity(a.alias, $1) as sim
           from product_aliases a join products p on p.id = a.product_id
          where similarity(a.alias, $1) > 0.30
       ) t
      group by t.product_id, t.name
      order by sim desc limit 4`,
    [norm]
  );
  return rows;
}

/**
 * POST /api/import/parse — пакет файлов одной накладной (base64) -> GPT -> позиции с авто-матчингом.
 * Файлы: {fileName, mime, base64}[] в поле files (или одиночный файл в старых полях — совместимо).
 * Найденные совпадения: точное имя > запомненный псевдоним > версия GPT.
 * Строка без совпадения приходит с match=null: клиент решает «создать новую» или «выбрать из существующих».
 */
importRouter.post(
  '/parse',
  wrap(async (req, res) => {
    const startedAt = Date.now();
    const body = req.body ?? {};
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    const log = logSink(req.user?.id, jobId);
    interface InFile { fileName: string; mime: string; base64: string }
    let list: InFile[];
    if (Array.isArray(body.files) && body.files.length) {
      list = body.files.map((f: Record<string, unknown>, idx: number) => {
        const fileName = reqStr(f, 'fileName');
        const base64 = reqStr(f, 'base64');
        const mime = (typeof f.mime === 'string' && f.mime) || guessMime(fileName);
        return { fileName: String(fileName).slice(0, 200) || `фото ${idx + 1}`, mime, base64 };
      });
    } else {
      const fileName = reqStr(body, 'fileName');
      const base64 = reqStr(body, 'base64');
      const mime = (typeof body.mime === 'string' && body.mime) || guessMime(fileName);
      list = [{ fileName, mime, base64 }];
    }
    if (list.length > 8) throw new ApiError(400, 'Не больше 8 фото на одну накладную');

    const bufs: Buffer[] = [];
    let totalBytes = 0;
    for (const f of list) {
      if (!/^image\/(png|jpeg|jpg|webp|gif)$|^application\/pdf$/.test(f.mime)) {
        throw new ApiError(400, 'Поддерживаются png/jpg/webp/gif и pdf');
      }
      const buf = Buffer.from(f.base64, 'base64');
      if (buf.length < 100) throw new ApiError(400, `Файл «${f.fileName}» пустой`);
      if (buf.length > 15 * 1024 * 1024) throw new ApiError(400, `Файл «${f.fileName}» больше 15 МБ`);
      totalBytes += buf.length;
      bufs.push(buf);
    }
    if (totalBytes > 24 * 1024 * 1024) throw new ApiError(400, 'Пакет фото больше 24 МБ — снимайте по ближе и по одному листу за раз');

    // сохранить вложения: первый файл — главный, остальные — листы
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const saveOne = (name: string, buf: Buffer): string => {
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-40) || 'doc';
      const stored = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
      fs.writeFileSync(path.join(config.uploadsDir, stored), buf);
      return stored;
    };
    const storedFiles = list.map((f, idx) => saveOne(f.fileName, bufs[idx]));
    const fileName = list[0].fileName;
    const storedFile = storedFiles[0];
    const extraStored = storedFiles.slice(1).map((stored, idx) => ({ stored, name: list[idx + 1].fileName }));
    log(
      'stage',
      `Файл получен: ${fileName}${list.length > 1 ? ` + ещё ${list.length - 1} (${list.length} листа)` : ''} · ${(totalBytes / 1024).toFixed(0)} КБ`
    );
    log('stage', 'Готовлю каталог и единицы склада…');

    const catalog = await loadCatalog();
    const units = await loadUnitRows();
    log('stage', `Каталог загружен: ${catalog.products.length} позиций · отправляю в ИИ`);
    const { doc, model, transcript, corrections } = await parseWaybillDoc({
      files: list.map((f) => ({ mime: f.mime, base64: f.base64 })),
      catalog: catalog.products,
      unitCodes: units.map((u) => u.code),
      onLog: (text) => log('stage', text),
    });
    // Поставщик: модель могла оставить поле пустым, если продавец не напечатан отдельной
    // строкой (WFC — только GLN/счёт в верхней части листа). Ищем в справочнике, а нового
    // поставщика заводим с реквизитами из накладной — дальше он будет узнаваться сам.
    const supplierHit = await resolveOrCreateSupplier(doc, transcript, { actorId: req.user?.id ?? null });
    if (supplierHit) {
      if (supplierHit.created) {
        log('stage', `Новый поставщик: ${supplierHit.ref.name} — добавлен в справочник`);
        corrections.push(`Поставщик добавлен в справочник: ${supplierHit.ref.name}`);
        await audit(req.user, {
          action: 'create',
          entity: 'supplier',
          entityId: supplierHit.ref.id,
          title: `Поставщик · ${supplierHit.ref.name}`,
          details: { source: 'scan', pib: doc.supplierPib },
        });
      } else {
        log('stage', `Поставщик: ${supplierHit.ref.name} (по ${supplierHit.via})`);
        corrections.push(`Поставщик определён по ${supplierHit.via}: ${supplierHit.ref.name}`);
      }
    }
    log('stage', `ИИ ответил: ${doc.items.length} строк · сопоставляю с каталогом…`);
    const products = catalog.products;
    const { byNormName, byAlias } = catalog;
    const validIds = new Set(products.map((p) => p.id));
    const unitByCode = new Map(units.map((u) => [u.code, u]));
    // коэффициенты пересчёта размерностей по товарам — чтобы кросс-размерный приход (шт<->г<->мл) сошёлся
    const { rows: convRows } = await pool.query(
      'select id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from products'
    );
    const convByProduct = new Map<number, ProdConv>(
      convRows.map((r: { id: number; gp: number | null; mp: number | null; gm: number | null }) => [
        r.id as number,
        { gPerPcs: r.gp == null ? null : Number(r.gp), mlPerPcs: r.mp == null ? null : Number(r.mp), gPerMl: r.gm == null ? null : Number(r.gm) },
      ])
    );

    const items = [] as unknown[];
    const warnings: string[] = [];
    /** Не-товарные начисления, считаем отдельно от склада: скидки и служебные (доставка/плата/возврат). */
    const serviceLines: { kind: 'discount' | 'service'; name: string; amount: number | null }[] = [];
    /** Скидки, выведенные моделью в отдельном блоке документа (богаче: процент, товар, учтённость в строках). */
    type DiscOut = {
      name: string;
      productName: string | null;
      discountKind: 'line' | 'percent' | 'promotion' | 'unknown';
      amount: number | null;
      percent: number | null;
      vatRate: number | null;
      includedInLineSum: boolean | null;
      doubt: string | null;
    };
    const discountsOut: DiscOut[] = (doc.discounts?.items ?? [])
      .filter((d) => d.name || d.amount != null)
      // «R. % (rabat) 0,00» — пустая графа бланка, а не скидка: не показываем и не считаем
      .filter((d) => !(Math.abs(d.amount ?? 0) < 0.005 && Math.abs(d.percent ?? 0) < 0.005 && !d.doubt))
      .map((d) => ({
        name: d.name || 'скидка',
        productName: d.productName,
        discountKind: d.kind,
        amount: d.amount,
        percent: d.percent,
        vatRate: d.vatRate,
        includedInLineSum: d.includedInLineSum,
        doubt: d.doubt,
      }));
    // скидка, уже учтённая в суммах товарных строк, в отдельной росписи не нуждается — не двойим её
    for (const d of discountsOut) {
      if (d.includedInLineSum === true) continue;
      if (d.amount == null || Math.abs(d.amount) < 0.005) continue; // «R.% 0,00» — не скидка, шум
      serviceLines.push({ kind: 'discount', name: d.name, amount: d.amount });
    }
    /** Names already represented by the GPT discounts block — the fallback classifier must not double them. */
    const discountNames = new Set(discountsOut.filter((d) => d.includedInLineSum !== true).map((d) => normName(d.name)));

    // Ставку PDV, если её не напечатали, выводит llm-слой (арифметика по итогам документа + прицельное
    // перечитывание). Здесь выводить её второй раз — риск двух разных ответов в одном разборе.
    for (const it of doc.items) {
      if (!it.name) continue;
      // Скидки/промо/служебные/итоговые строки — не товар: не кладём их в позиции и не заводим под них товары.
      // Скидки и служебные начисления собираем отдельно (видны в разборе, на склад не приходятся).
      const kind = classifyNonProduct(it.name);
      if (kind) {
        if (kind !== 'total') {
          // скидку уже принёс отдельный блок документа — не заводим её второй раз из строки-дубля
          if (kind === 'discount' && discountNames.has(normName(it.name))) continue;
          const amt =
            it.lineSum ?? (it.qty != null && it.price != null ? Math.round(it.qty * it.price * 100) / 100 : null);
          if (kind === 'discount' && (amt == null || Math.abs(amt) < 0.005)) continue;
          serviceLines.push({ kind, name: it.name.trim(), amount: amt != null ? Math.round(amt * 100) / 100 : null });
        }
        continue;
      }
      const norm = normName(it.name);
      // 1) точное имя, 2) псевдоним, 3) словарь товароведа (сербский/немецкий/английский -> склад),
      // 4) уверенная GPT. Если словарь знает строку и говорит «это НЕ наш товар» (свежий огурец,
      // перец горошком и т.п.), ответу GPT не верим — иначе он цепляет похожее, но другое.
      const meaning = matchByMeaning(it.name, products, byNormName, byAlias);
      const lex = findLexEntry(it.name);
      let match: { productId: number; name: string; unitCode: string; via: 'name' | 'alias' | 'llm' | 'lexicon' } | null = null;
      if (meaning.match) {
        const p = meaning.match.product;
        match = { productId: p.id, name: p.name, unitCode: p.unitCode, via: meaning.match.via };
      } else if (!lex && it.productId != null && validIds.has(it.productId)) {
        const p = products.find((x) => x.id === it.productId)!;
        match = { productId: p.id, name: p.name, unitCode: p.unitCode, via: 'llm' };
      }

      const candidates = await trgmCandidates(norm);
      // кандидаты GPT докидываем, если trgm ничего не дал
      if (!candidates.length) {
        for (const id of it.candidates) {
          const p = products.find((x) => x.id === id);
          if (p && p.id !== match?.productId) candidates.push({ productId: p.id, name: p.name, sim: 0 });
          if (candidates.length >= 4) break;
        }
      }
      const filtered = candidates.filter((c) => c.productId !== match?.productId);

      // напечатанная единица -> базовая (г/мл/шт) + решение GPT «в чём класть на склад»
      const du = it.unitCode ? DOC_UNITS[normName(it.unitCode)] : undefined;
      const conv = baseLine(
        {
          name: it.name,
          unitCode: it.unitCode ?? null,
          qty: it.qty,
          price: it.price,
          lineSum: it.lineSum,
          countAs: it.countAs ?? null,
          packQty: it.packQty ?? null,
          packUnit: it.packUnit ?? null,
          baseUnit: it.baseUnit ?? null,
          doubt: it.doubt ?? null,
        },
        { units: unitByCode, printed: du, productUnitCode: match?.unitCode ?? null, productConv: match ? convByProduct.get(match.productId) ?? null : null }
      );
      // замечания этой строки живут в её карточке, а не общим списком над таблицей
      const itemNotes = conv.notes.map((n) => stripLineName(n, it.name));
      const doubtText = (conv.doubt ?? '').replace(/^(?:GPT|ИИ|Склад|Товаровед|Каталог|Распознавание|Сверка):\s*/i, '').trim();
      const qtyBase = conv.qty;
      const priceBase = conv.price;
      const unitIdOut = conv.unitId;
      const qtyForecast = conv.forecast;
      const doubt = conv.doubt;
      if (it.qty == null && !qtyForecast) itemNotes.push('количество не прочитано — укажите вручную');
      if (it.unitCode && !du) itemNotes.push(`единица «${it.unitCode}» не распознана — укажите базовую (г/мл/шт) и проверьте количество`);

      items.push({
        rawName: it.name,
        qty: qtyBase,
        unitId: unitIdOut,
        /** как напечатано в документе — для сверки («50 kg» против 50000 г в базе) */
        docUnitPrinted: it.unitCode ?? null,
        docQtyPrinted: it.qty ?? null,
        /** печатная цена за напечатанную единицу — ею пользователь может править деньги строки */
        docPricePrinted: it.price ?? null,
        /** true — qty/единица взяты из фасовки (пересчёт GPT «в чём класть»), не как напечатано в строке */
        qtyForecast,
        /** сомнение GPT по строке — карточка подсвечивается человеку */
        doubt,
        /** замечания по этой строке — показываются в её карточке (название в тексте уже не дублируем) */
        warnings: itemNotes.filter((n) => n && n !== doubtText),
        price: priceBase,
        // строки «без НДС» (выведенная ставка 0) отдаём как null: 0 % и пустая ставка в UI — одно и то же
        vatRate: it.vatRate ? it.vatRate : null,
        /** ставку не напечатали — вывел llm-слой, пусть человек проверит */
        vatInferred: !!it.vatInferred,
        vatSuspect: !!it.vatSuspect,
        /** деньги строки — якорь всех пересчётов в карточке */
        lineSum: it.lineSum,
        /** напечатана ли сумма в документе; если нет — её соберёт клиент из Кол × Цена */
        lineSumPrinted: it.lineSum != null && it.lineSum > 0,
        match,
        candidates: filtered,
        // подсказка для нового товара: словарь точнее «прочее» от модели
        newHint: match
          ? null
          : it.newHint && it.newHint.category && it.newHint.category !== 'прочее'
            ? it.newHint
            : classifyNewProduct(it.name) ?? it.newHint,
      });
    }
    {
      const matched = (items as { match: unknown }[]).filter((x) => !!x.match).length;
      const warnCount = warnings.length + (items as { warnings?: string[] }[]).reduce((s, x) => s + (x.warnings?.length ?? 0), 0);
      log(
        'stage',
        `Сопоставление: ${matched} из ${items.length} ${items.length === 1 ? 'строки' : 'строк'} уже есть в каталоге${warnCount ? ` · предупреждений: ${warnCount}` : ''}`
      );
    }
    // сверка итога по строкам с общим итогом документа
    if (doc.totalSum != null && doc.totalSum > 0) {
      const sumLines = (items as { lineSum: number | null }[]).reduce((s, x) => s + (x.lineSum ?? 0), 0);
      const dNet = doc.totalSum - sumLines;
      // отдельная скидка законно уменьшает нетто: Σ строк − скидка ≈ нетто → расхождение НЕ ошибка разбора
      const discAmt = doc.discounts?.total ?? discountsOut.reduce((s, d) => s + (d.amount ?? 0), 0);
      const explainedByDisc =
        discAmt > 0 && dNet > 0 && Math.abs(dNet - discAmt) <= Math.max(2, doc.totalSum * 0.01);
      // не-товарные начисления могут объяснять расхождение товаров↔нетта (скидка уменьшает, служебная увеличивает):
      // если разрыв равен их сумме — это НЕ потерянные/неверные позиции, отдельного предупреждения не даём
      const svcAbs = serviceLines.reduce((s, x) => s + Math.abs(x.amount ?? 0), 0);
      const explainedBySvc = svcAbs > 0 && Math.abs(Math.abs(dNet) - svcAbs) <= Math.max(2, doc.totalSum * 0.02);
      if (sumLines > 0 && !explainedByDisc && !explainedBySvc && Math.abs(dNet) > Math.max(2, doc.totalSum * 0.02)) {
        // нехватка больше, чем способно объяснить любое одиночное неверное прочтение строки (≈×10 её значения)
        // → значит целые позиции не попали в разбор, а не «опечатка в цифре»: просим добавить строки, не дорисовываем
        const maxLine = Math.max(0, ...(items as { lineSum: number | null }[]).map((x) => x.lineSum ?? 0));
        if (dNet > 0 && dNet > maxLine * 10 + 10) {
          warnings.push(`Σ распознанных строк ${trimNum(sumLines)} меньше нетто документа ${trimNum(doc.totalSum)} на ${trimNum(dNet)} — не все позиции попали в разбор (пропущенные строки/лист). Добавьте недостающие вручную: итог подгонкой существующих строк не дорисовываем`);
        } else {
          warnings.push(`Σ строк ${trimNum(sumLines)} ≠ нетто документа ${trimNum(doc.totalSum)} (Δ ${trimNum(dNet)}) — сверьте позиции с фото`);
        }
      }
    }
    // скидки прочитаны, но их сумма не подтверждена документом — человек должен это увидеть до приходовки
    if (doc.discounts?.items.length && doc.discounts.total == null) {
      warnings.push(
        `Скидок/акций: ${doc.discounts.items.length}, их общую сумму установить не удалось${doc.discounts.doubt ? ` — ${doc.discounts.doubt}` : ''} — сверьте по фото`
      );
    }
    // сверка НДС: нетто + PDV ≈ к оплате
    if (doc.totalSum != null && doc.totalVat != null && doc.totalGross != null) {
      if (Math.abs(doc.totalSum + doc.totalVat - doc.totalGross) > Math.max(2, doc.totalGross * 0.01)) {
        warnings.push(`Итоги документа не бьются: ${trimNum(doc.totalSum)} + PDV ${trimNum(doc.totalVat)} ≠ ${trimNum(doc.totalGross)}`);
      }
    }
    // Σ ставок PDV по строкам против напечатанного итога НДС (НДС строки — с округлением до копейки, как в печатных доках)
    if (doc.totalVat != null && doc.totalVat > 0) {
      const calcVat = (items as { lineSum: number | null; vatRate: number | null }[]).reduce(
        (s, x) => s + Math.round(((x.lineSum ?? 0) * (x.vatRate ?? 0))) / 100,
        0
      );
      if (Math.abs(calcVat - doc.totalVat) > 1.5) {
        warnings.push(`Σ PDV по ставкам ${trimNum(calcVat)} ≠ PDV в документе ${trimNum(doc.totalVat)} — проверьте ставки (колонка «ПДВ»)`);
      }
    }
    // «что исправилось само» и «что проверить» — два разных списка: клиент их не различает по тексту,
    // а по полю, иначе подсветка правок превращается в угадывание по формулировке.
    if (storedFiles.length > 1) {
      warnings.unshift(`Разобрал ${storedFiles.length} фото как одну накладную — сверьте линии: совмещённые листы могли пропустить край строки`);
    }
    if (!items.length) warnings.push('GPT не распознал ни одной позиции — проверьте читаемость файла');
    {
      const warnCount = warnings.length + (items as { warnings?: string[] }[]).reduce((s, x) => s + (x.warnings?.length ?? 0), 0);
      log(
        'result',
        `Готово за ${((Date.now() - startedAt) / 1000).toFixed(1)} с: ${items.length} ${pluralRu(items.length, 'позиция', 'позиции', 'позиций')}${warnCount ? `, требуют внимания: ${warnCount}` : ''}`
      );
    }

    res.json({
      storedFile,
      fileName,
      extraFiles: extraStored,
      model,
      doc: {
        number: doc.number,
        supplier: doc.supplier,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(doc.date ?? '')) ? doc.date : null,
        supplierPib: doc.supplierPib,
        currency: doc.currency ?? 'RSD',
        totalSum: doc.totalSum,
        totalVat: doc.totalVat,
        totalGross: doc.totalGross,
      },
      items,
      warnings,
      corrections: corrections ?? [],
      /** Скидки/служебные строки, посчитанные отдельно от товаров (на склад не приходовываются). */
      serviceLines,
      /** Блок скидок из разбора: сумма+роспись с процентом/товаром/учтённостью в строках. */
      discounts: {
        total: doc.discounts?.total ?? null,
        items: discountsOut,
        doubt: doc.discounts?.doubt ?? null,
      },
      // сырая транскрипция — только по явному запросу, для отладки качества OCR
      ...(body.debug === true ? { transcript } : {}),
    });
  })
);

/**
 * POST /api/import/parse-cli — умный приход через Qoder CLI.
 * Конвейер специализированных агентов (см. services/invoice-agents.ts):
 *   «Распознавание» (vision: дословная транскрипция) -> «Каталог» (структура + каталог)
 *   -> «Сверка» (арифметика/сверки в коде; при расхождении — точечное перечитывание спорных строк).
 */
importRouter.post(
  '/parse-cli',
  wrap(async (req, res) => {
    const startedAt = Date.now();
    const body = req.body ?? {};
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    const log = logSink(req.user?.id, jobId);
    interface InFile { fileName: string; mime: string; base64: string }
    let list: InFile[];
    if (Array.isArray(body.files) && body.files.length) {
      list = body.files.map((f: Record<string, unknown>, idx: number) => ({
        fileName: String(reqStr(f, 'fileName')).slice(0, 200) || `фото ${idx + 1}`,
        mime: (typeof f.mime === 'string' && f.mime) || guessMime(String(f.fileName ?? '')),
        base64: reqStr(f, 'base64'),
      }));
    } else {
      const fileName = reqStr(body, 'fileName');
      list = [{ fileName, mime: (typeof body.mime === 'string' && body.mime) || guessMime(fileName), base64: reqStr(body, 'base64') }];
    }
    if (list.length > 8) throw new ApiError(400, 'Не больше 8 фото на одну накладную');
    const bufs: Buffer[] = [];
    let totalBytes = 0;
    for (const f of list) {
      if (!/^image\/(png|jpeg|jpg|webp|gif)$|^application\/pdf$/.test(f.mime)) {
        throw new ApiError(400, 'Поддерживаются png/jpg/webp/gif и pdf');
      }
      const buf = Buffer.from(f.base64, 'base64');
      if (buf.length < 100) throw new ApiError(400, `Файл «${f.fileName}» пустой`);
      if (buf.length > 15 * 1024 * 1024) throw new ApiError(400, `Файл «${f.fileName}» больше 15 МБ`);
      totalBytes += buf.length;
      bufs.push(buf);
    }
    if (totalBytes > 24 * 1024 * 1024) throw new ApiError(400, 'Пакет фото больше 24 МБ — снимайте ближе и по одному листу');

    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const storedFiles = list.map((f, idx) => {
      const safe = f.fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-40) || 'doc';
      const stored = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
      fs.writeFileSync(path.join(config.uploadsDir, stored), bufs[idx]);
      return stored;
    });
    const fileName = list[0].fileName;
    const storedFile = storedFiles[0];
    const extraStored = storedFiles.slice(1).map((stored, idx) => ({ stored, name: list[idx + 1].fileName }));

    // Временная папка — рабочая директория агентов; после разбора её удаляем.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixmarkt-cli-'));
    try {
      const sources = list.map((f, idx) => ({ name: f.fileName, mime: f.mime, buf: bufs[idx] }));
      /** Время по этапам (мс) — в debug-ответе, чтобы понимать, где уходит минута-другая. */
      const timings: Record<string, number> = {};
      let stageAt = Date.now();
      const rotations = await detectRotationsAsync(sources, workDir, log);
      timings.orientation = Date.now() - stageAt;
      stageAt = Date.now();
      const prepared = await prepareVisionFilesAsync(sources, workDir, rotations);
      timings.prepare = Date.now() - stageAt;
      log(
        'stage',
        `Агенты получили документ: ${prepared.files.map((f) => f.name).join(', ')} · ${(prepared.totalBytes / 1024).toFixed(0)} КБ · фото выпрямлены`
      );

      // ── агент «Распознавание» ──────────────────────────────────────────────────
      stageAt = Date.now();
      let transcript = await runReaderAgent(prepared.files, workDir, log);
      timings.reader = Date.now() - stageAt;
      const firstLine = transcript.split('\n')[0] ?? '';
      const notInvoice = /^ТИП:\s*НЕ\s*НАКЛАДНАЯ/i.test(firstLine.trim());
      log('stage', notInvoice ? '«Распознавание»: документ не похож на накладную' : `«Распознавание»: прочитано ${transcript.length.toLocaleString('ru-RU')} символов`);

      const catalog = await loadCatalog();
      const units = await loadUnitRows();
      const categories = await loadCategoryNames();
      const validIds = new Set(catalog.products.map((p) => p.id));
      const unitByCode = new Map(units.map((u) => [u.code, u]));
      const { rows: convRows } = await pool.query(
        'select id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from products'
      );
      const convByProduct = new Map<number, ProdConv>(
        convRows.map((r: { id: number; gp: number | null; mp: number | null; gm: number | null }) => [
          r.id as number,
          { gPerPcs: r.gp == null ? null : Number(r.gp), mlPerPcs: r.mp == null ? null : Number(r.mp), gPerMl: r.gm == null ? null : Number(r.gm) },
        ])
      );
      log('stage', `Каталог: ${catalog.products.length} позиций · категорий: ${categories.length} · агент «Каталог» сопоставляет строки`);

      if (notInvoice) {
        const rawReason = firstLine.replace(/^ТИП:\s*/i, '').trim();
        const reason = /^(НЕ\s*НАКЛАДНАЯ|NOT\s+(AN\s+)?INVOICE)$/i.test(rawReason) ? '' : rawReason;
        res.json({
          storedFile,
          fileName,
          extraFiles: extraStored,
          model: 'ИИ · агенты',
          doc: { number: null, supplier: null, date: null, supplierPib: null, currency: 'RSD', totalSum: null, totalVat: null, totalGross: null },
          items: [],
          warnings: [
            `Файл не распознан как накладная${reason ? `: ${reason}` : ''}. ` +
              `Снимите лист с таблицей товаров и итогами целиком, без наклона и обрезанных краёв, и повторите разбор.`,
          ],
          corrections: [],
          serviceLines: [],
          discounts: { total: null, items: [], doubt: null },
          ...(body.debug === true ? { transcript, timings } : {}),
        });
        return;
      }

      // ── агент «Каталог» ─────────────────────────────────────────────
      stageAt = Date.now();
      let doc = await runStructurerAgent(
        { transcript, catalog: catalog.products, categories, unitCodes: units.map((u) => u.code) },
        workDir,
        log
      );
      timings.structurer = Date.now() - stageAt;
      const docFixes: string[] = [];
      normalizeAgentDoc(doc, transcript, docFixes);
      // «Распознавание» на плотной таблице иногда уводит числа на соседние строки. Итоги документа
      // он читает стабильно, поэтому сверяем Σ строк со скидками с нетто и, если не сошлось,
      // перечитываем лист вторым проходом — оставляем тот разбор, что ближе к напечатанному итогу.
      {
        const gapOf = (d: typeof doc): number => {
          if (d.totalSum == null || !d.items.length) return Number.POSITIVE_INFINITY;
          const disc = (d.discounts?.items ?? []).reduce((s, x) => s + Math.abs(x.amount ?? 0), 0);
          const lines = d.items.reduce((s, x) => s + (x.lineSum ?? 0), 0);
          return Math.abs(d.totalSum - (lines - disc));
        };
        const tol = doc.totalSum != null ? Math.max(5, doc.totalSum * 0.001) : 2;
        if (doc.totalSum != null && gapOf(doc) > tol) {
          log('stage', `«Распознавание»: строки не сошлись с итогом на ${trimNum(gapOf(doc))} — перечитываю лист вторым проходом`);
          stageAt = Date.now();
          const transcript2 = await runReaderAgent(prepared.files, workDir, log).catch(() => '');
          if (transcript2 && !/^ТИП:\s*НЕ\s*НАКЛАДНАЯ/i.test((transcript2.split('\n')[0] ?? '').trim())) {
            const s2 = Date.now();
            const doc2 = await runStructurerAgent(
              { transcript: transcript2, catalog: catalog.products, categories, unitCodes: units.map((u) => u.code) },
              workDir,
              log
            ).catch(() => null);
            timings.structurer = (timings.structurer ?? 0) + (Date.now() - s2);
            if (doc2) {
              const fixes2: string[] = [];
              normalizeAgentDoc(doc2, transcript2, fixes2);
              if (gapOf(doc2) < gapOf(doc) - 0.01) {
                log('stage', `«Распознавание»: второй проход точнее (Δ ${trimNum(gapOf(doc2))}) — беру его`);
                transcript = transcript2;
                doc = doc2;
                docFixes.length = 0;
                docFixes.push(...fixes2);
              }
            }
          }
        }
      }
      // Шапка и итоги: если числа не бьются со строками или противоречат друг другу,
      // отдельный фокусный агент перечитывает только блок итогов (числа строк ему не мешают).
      {
        const discountAbs = (doc.discounts?.items ?? []).reduce((s, x) => s + Math.abs(x.amount ?? 0), 0);
        const linesNet = doc.items.reduce((s, x) => s + (x.lineSum ?? 0), 0) - discountAbs;
        const totalsInvalid =
          doc.totalSum == null ||
          doc.totalGross == null ||
          (doc.totalVat != null && Math.abs(doc.totalSum + doc.totalVat - doc.totalGross) > Math.max(2, doc.totalGross * 0.002)) ||
          Math.abs(linesNet - doc.totalSum) > Math.max(5, Math.abs(doc.totalSum) * 0.01);
        if (totalsInvalid) {
          const ht = await runHeaderTotalsAgent(prepared.files, workDir, log).catch(() => null);
          if (ht) {
            const validTotals =
              ht.totalSum != null &&
              ht.totalVat != null &&
              ht.totalGross != null &&
              Math.abs(ht.totalSum + ht.totalVat - ht.totalGross) <= Math.max(2, ht.totalGross * 0.002) &&
              ht.totalGross > ht.totalSum &&
              ht.totalVat < ht.totalSum;
            if (validTotals) {
              doc.totalSum = ht.totalSum;
              doc.totalVat = ht.totalVat;
              doc.totalGross = ht.totalGross;
              docFixes.push(
                `Итоги перечитаны агентом «Сверка»: нетто ${trimNum(ht.totalSum!)}, PDV ${trimNum(ht.totalVat!)}, к оплате ${trimNum(ht.totalGross!)}`
              );
            }
            // Дату не перезаписываем: она уже взята из напечатанного «ДАТА» в транскрипции.
            // Фокусный агент читает только итоги; его дата — лишь заполнение пустого поля.
            if (ht.date && !doc.date) {
              doc.date = ht.date;
              docFixes.push(`Дата из шапки: ${ht.date}`);
            }
            if (!doc.number && ht.number) doc.number = ht.number;
          }
        }
      }
      // Поставщик по справочнику: у части бланков название продавца не напечатано отдельной
      // строкой (WFC — GLN/банковский счёт сверху), а «Primalac: MIX MARKT» — наш склад.
      // Модель тут не нужна: ищем реквизиты в транскрипции, нового поставщика заводим сразу.
      {
        const supplierHit = await resolveOrCreateSupplier(doc, transcript, { actorId: req.user?.id ?? null });
        if (supplierHit) {
          if (supplierHit.created) {
            log('stage', `Новый поставщик: ${supplierHit.ref.name} — добавлен в справочник`);
            docFixes.push(`Поставщик добавлен в справочник: ${supplierHit.ref.name}`);
            await audit(req.user, {
              action: 'create',
              entity: 'supplier',
              entityId: supplierHit.ref.id,
              title: `Поставщик · ${supplierHit.ref.name}`,
              details: { source: 'scan', pib: doc.supplierPib },
            });
          } else {
            log('stage', `Поставщик: ${supplierHit.ref.name} (по ${supplierHit.via})`);
            docFixes.push(`Поставщик определён по ${supplierHit.via}: ${supplierHit.ref.name}`);
          }
        }
      }
      const corrections: string[] = [...docFixes];
      if (!doc.items.length) corrections.push('«Каталог» не увидел товарных строк — проверьте фото и заголовки колонок');

      // ── «Сверка»: скидки, ставки PDV и налог из напечатанных сумм ────
      const r2 = (n: number): number => Math.round(n * 100) / 100;
      /** Ставка по отношению «с PDV / без PDV»: 1,05 / 1,10 / 1,20 (допуск ±2 %). */
      const ratioRate = (net: number | null, gross: number | null): number | null => {
        if (net == null || gross == null || net <= 0 || gross <= 0) return null;
        const k = gross / net;
        for (const rate of [5, 10, 20]) if (Math.abs(k - (1 + rate / 100)) <= 0.02) return rate;
        return null;
      };
      // Суммы с PDV берём как прочитаны: в этом бланке они напечатаны ровно в строке товара,
      // а «сдвиг», который мы видели на мелком фото, был ошибкой распознавания колонки.
      // Поэтому ничего не переставляем, а неверные отношения ловим ниже проверкой ставки.
      // POPUST-строки печатаются с минусом и иногда со знаком после числа: скидка — всегда плюс
      const discItems = (doc.discounts?.items ?? [])
        .map((d) => ({
          ...d,
          amount: d.amount == null ? null : Math.abs(d.amount),
          amountGross: d.amountGross == null ? null : Math.abs(d.amountGross),
        }))
        // «R. % (rabat) 0,00» — пустая графа бланка, а не скидка
        .filter((d) => !(Math.abs(d.amount ?? 0) < 0.005 && Math.abs(d.percent ?? 0) < 0.005));
      const discNet = r2(discItems.reduce((s, d) => s + (d.amount ?? 0), 0));
      if (discItems.length) {
        doc.discounts = { total: discNet, items: discItems };
        // итог по скидкам печатаем ПОСЛЕ привязки к строкам — там перепутанные суммы исправляются
        const parts = discItems
          .map((d) => `${d.name}${d.productName ? ` («${d.productName}»)` : ''}${d.amount != null ? ` −${trimNum(d.amount)}` : ' — сумма не прочитана'}`)
          .join(', ');
        corrections.push(`Найдены строки скидок: ${parts}`);
      }
      // ставка PDV: проверяем и печатную колонку по суммам строк, иначе выводим из отношения
      let inferredRates = 0;
      let fixedRates = 0;
      for (const it of doc.items) {
        const rate = ratioRate(it.lineSum, it.lineGross);
        if (it.vatRate == null) {
          if (rate != null) {
            it.vatRate = rate;
            it.vatInferred = true;
            inferredRates++;
          }
        } else if (rate != null && rate !== it.vatRate) {
          // модель угадала ставку по «P», а суммы говорят другое — верим напечатанным суммам
          it.vatRate = rate;
          it.vatInferred = true;
          fixedRates++;
        }
      }
      if (fixedRates) {
        corrections.push(`Ставку PDV сверил по напечатанным суммам строк: исправил ${fixedRates} строк (10 % / 20 % по отношению «с PDV» к нетто)`);
      }
      if (inferredRates) {
        corrections.push(
          `Ставку PDV отдельной колонкой не печатают — вывел её по суммам строк: ${inferredRates} строк (10 % / 20 % по отношению «с PDV» к нетто)`
        );
      }
      // налог отдельной строкой не напечатан — он законно выводится из двух напечатанных итогов
      if (doc.totalVat == null && doc.totalSum != null && doc.totalGross != null && doc.totalGross > doc.totalSum) {
        doc.totalVat = r2(doc.totalGross - doc.totalSum);
        corrections.push(
          `PDV отдельной строкой не напечатан — вычислил его из итогов: к оплате ${trimNum(doc.totalGross)} − нетто ${trimNum(doc.totalSum)} = ${trimNum(doc.totalVat)}`
        );
      }

      // ── «Сверка»: сверка таблицы с напечатанным итогом ──────────────
      // При расхождении запускаем повторное распознавание ВСЕХ строк таблицы, но правим только
      // те цифры, которые (а) внутренне согласованы qty×price=lineSum и (б) не меняют
      // масштаб строки больше чем в 10 раз (иначе это подгонка, а не OCR-ошибка).
      if (doc.totalSum != null && doc.totalSum > 0 && doc.items.length) {
        const sumLines0 = doc.items.reduce((s, it) => s + (it.lineSum ?? 0), 0);
        // скидки — отдельные строки ВНУТРИ напечатанных итогов: Σ товаров − скидки = нетто документа
        const netAfterDisc = r2(sumLines0 - discNet);
        const dNet0 = r2(doc.totalSum - netAfterDisc);
        // сколько всего скидок подразумевают напечатанные итоги (Σ строк − нетто документа)
        const needDisc = r2(sumLines0 - doc.totalSum);
        const maxLine0 = Math.max(0, ...doc.items.map((it) => it.lineSum ?? 0));
        const missingRows = dNet0 > 0 && dNet0 > maxLine0 * 10 + 10;
        // «разница закрывается скидками» — только если после ВЫЧИТАНИЯ прочитанных скидок
        // сумма действительно сходится с итогом; иначе строки всё равно надо перечитать
        const discExplains = discItems.length > 0 && Math.abs(dNet0) <= Math.max(2, doc.totalSum * 0.02);
        if (discExplains) {
          log('stage', `Сверка: скидки закрывают расхождение (${trimNum(needDisc)}) — строки не перечитываю`);
        } else if (!missingRows) {
          // перечитываем до двух раз; принимаем только внутренне согласованные строки
          // и только если от них Σ строк СТАНОВИТСЯ ближе к напечатанному итогу
          const tol = Math.max(2, doc.totalSum * 0.02);
          const gapNow = (): number =>
            Math.abs(doc.totalSum! - (doc.items.reduce((s, it) => s + (it.lineSum ?? 0), 0) - discNet));
          for (let round = 0; round < 2; round++) {
            const sumNow = doc.items.reduce((s, it) => s + (it.lineSum ?? 0), 0);
            const gap = gapNow();
            if (gap <= tol) break;
            const table = doc.items
              .map((it, i) => `${i + 1} | ${it.name} | qty=${it.qty ?? '?'} ${it.unitCode ?? ''} | price=${it.price ?? '?'} | сумма=${it.lineSum ?? '?'} | с PDV=${it.lineGross ?? '?'}`)
              .join('\n');
            const asked =
              `Σ товаров ${trimNum(sumNow)} − скидки ${trimNum(discNet)} ≠ нетто документа ${trimNum(doc.totalSum)}. ` +
              `Разница ${trimNum(doc.totalSum - (sumNow - discNet))}. Перечитай каждую строку по фото и верни её настоящие ` +
              `qty (Kol.), price (Cena po pakovanju), lineSum (Iznos bez PDV) и lineGross (Iznos s PDV-om). ` +
              `Помни: строки POPUST не имеют количества, скидка — отдельная строка товара с минусом, а сумма товара = Kol. × цена.\n${table}`;
            log('stage', `Сверка: расхождение с итогом ${trimNum(gap)} — запускаю повторное распознавание строк (${round + 1})`);
            const fixed = await runAuditReader(prepared.files, asked, workDir, log);
            const lines = Array.isArray(fixed?.lines) ? (fixed!.lines as Record<string, unknown>[]) : [];
            // применяем пачкой: перепутанные соседние строки (сдвиг на POPUST) исправляются
            // только вместе, по одной каждая ухудшает Σ
            type Change = {
              it: (typeof doc.items)[number];
              q: number;
              p: number;
              ls: number;
              gross: number | null;
              rate: number | null;
              unit: string | null;
            };
            const changes: Change[] = [];
            for (const ln of lines) {
              const nln = normName(String(ln.name ?? ''));
              const it =
                doc.items.find((x) => normName(x.name) === nln) ??
                (nln ? doc.items.find((x) => normName(x.name).includes(nln) || nln.includes(normName(x.name))) : undefined);
              if (!it) continue;
              const q = typeof ln.qty === 'number' && ln.qty > 0 ? ln.qty : null;
              const p = typeof ln.price === 'number' ? ln.price : null;
              const ls = typeof ln.lineSum === 'number' && ln.lineSum > 0 ? ln.lineSum : null;
              if (q == null || p == null || ls == null) continue;
              if (Math.abs(q * p - ls) > Math.max(1, ls * 0.02)) continue;
              // строка, в которую попали цифры POPUST, может отличаться от своей суммы в разы
              const collided = discItems.some((d) => Math.abs((d.amount ?? 0) - (it.lineSum ?? 0)) <= 0.02);
              const hi = Math.max(ls, it.lineSum ?? 0);
              const lo = Math.min(ls, it.lineSum ?? 0);
              if (!collided && lo > 0 && hi > lo * 10 + 1) continue;
              if (q === it.qty && Math.abs(p - (it.price ?? 0)) < 0.005 && Math.abs(ls - (it.lineSum ?? 0)) < 0.005) continue;
              changes.push({
                it,
                q,
                p,
                ls,
                gross: typeof ln.lineGross === 'number' && ln.lineGross > 0 ? ln.lineGross : null,
                rate: typeof ln.vatRate === 'number' && ln.vatRate >= 0 && ln.vatRate <= 30 ? ln.vatRate : null,
                unit: typeof ln.unitCode === 'string' && ln.unitCode ? ln.unitCode : null,
              });
            }
            if (!changes.length) break;
            const saved = changes.map((c) => ({
              qty: c.it.qty,
              price: c.it.price,
              lineSum: c.it.lineSum,
              lineGross: c.it.lineGross,
              vatRate: c.it.vatRate,
              unitCode: c.it.unitCode,
              countAs: c.it.countAs,
              packQty: c.it.packQty,
              doubt: c.it.doubt,
            }));
            for (const c of changes) {
              const qtyChanged = c.q !== c.it.qty;
              c.it.qty = c.q;
              c.it.price = c.p;
              c.it.lineSum = c.ls;
              c.it.lineGross = c.gross;
              if (c.rate != null) c.it.vatRate = c.rate;
              if (c.unit) c.it.unitCode = c.unit;
              if (qtyChanged && c.it.countAs) {
                c.it.countAs = null;
                c.it.packQty = null;
                c.it.doubt = 'количество исправлено при сверке — решите заново, в чём считать';
              }
            }
            if (gapNow() < gap - 0.01) {
              for (const c of changes) {
                corrections.push(`«${c.it.name}» — сверка с итогом исправила: ${c.q} × ${c.p}, сумма ${c.ls}`);
              }
            } else {
              changes.forEach((c, i) => Object.assign(c.it, saved[i]));
              break;
            }
          }
        }
      }

      // ── сборка позиций: «Каталог» + словарь + каталог + арифметика ─
      const items = [] as unknown[];
      const warnings: string[] = [];
      type ServiceLine = { kind: 'discount' | 'service'; name: string; amount: number | null };
      const serviceLines: ServiceLine[] = [];
      // скидка, уже вошедшая в сумму строки, второй раз в служебные строки не попадает
      const discountNames = new Set(discItems.map((d) => normName(d.name)));
      const catSet = new Set(categories);

      // Детерминированный контроль качества: сколько ложных подсказок и избыточных
      // сомнений сняли после сопоставления по словарю и каталогу.
      let droppedSuggestions = 0;
      let clearedDoubts = 0;

      for (const it of doc.items) {
        if (!it.name) continue;
        // товарная строка с минусом — это скидка/сторно, а не приход: в склад такое не пускаем
        if ((it.lineSum != null && it.lineSum < -0.005) || (it.lineGross != null && it.lineGross < -0.005)) {
          const amt = r2(Math.abs(it.lineSum ?? it.lineGross ?? 0));
          if (amt >= 0.05) {
            serviceLines.push({ kind: 'discount', name: it.name.trim(), amount: amt });
            corrections.push(
              `Строка «${it.name}» напечатана с минусом (−${trimNum(amt)}) — учёл её как скидку, а не товар; если это товар со скидкой, добавьте его вручную`
            );
          }
          continue;
        }
        const kind = classifyNonProduct(it.name);
        if (kind) {
          if (kind !== 'total') {
            if (kind === 'discount' && discountNames.has(normName(it.name))) continue;
            const amt = it.lineSum ?? (it.qty != null && it.price != null ? Math.round(it.qty * it.price * 100) / 100 : null);
            if (kind === 'discount' && (amt == null || Math.abs(amt) < 0.005)) continue;
            serviceLines.push({ kind, name: it.name.trim(), amount: amt != null ? Math.round(amt * 100) / 100 : null });
          }
          continue;
        }

        // «Распознавание» иногда дублирует шифру в начале названия — в имени товара она лишняя
        it.name = String(it.name).replace(/^\s*\d{8,15}\s+/, '').replace(/\s+/g, ' ').trim();
        const meaning = matchByMeaning(it.name, catalog.products, catalog.byNormName, catalog.byAlias);
        const lex = findLexEntry(it.name);
        let match: { productId: number; name: string; unitCode: string; via: 'name' | 'alias' | 'llm' | 'lexicon' } | null = null;
        if (meaning.match) {
          const p = meaning.match.product;
          match = { productId: p.id, name: p.name, unitCode: p.unitCode, via: meaning.match.via };
        } else if (!lex && it.productId != null && validIds.has(it.productId)) {
          // словарь не знает строку — доверяем «Каталогу», он видел весь каталог
          const p = catalog.products.find((x) => x.id === it.productId)!;
          match = { productId: p.id, name: p.name, unitCode: p.unitCode, via: 'llm' };
        }

        // Уверенное совпадение по имени/псевдониму/словарю сильнее догадок модели:
        // лишние варианты и сомнения по такой строке только мешают человеку.
        // Словарная подсказка для новой позиции — тоже уверенное знание товара.
        const lineIdentity = lexIdentity(it.name);
        const confident = (!!match && match.via !== 'llm') || (!match && !!meaning.hint && !!lineIdentity);

        const candidates = await trgmCandidates(normName(it.name));
        if (confident) {
          droppedSuggestions += it.candidates.filter((id) => id !== match?.productId).length;
        } else {
          for (const id of it.candidates) {
            if (candidates.length >= 4) break;
            if (id === match?.productId || candidates.some((c) => c.productId === id)) continue;
            const p = catalog.products.find((x) => x.id === id);
            if (p) candidates.push({ productId: p.id, name: p.name, sim: 0 });
          }
        }
        const filtered = candidates
          .filter((c) => c.productId !== match?.productId)
          // соседний товар из словаря (чеснок для «crni luk») — не подсказка, а шум
          .filter((c) => {
            if (!lineIdentity) return true;
            const candidateIdentity = lexIdentity(c.name);
            if (candidateIdentity && candidateIdentity !== lineIdentity) {
              droppedSuggestions++;
              return false;
            }
            return true;
          })
          .slice(0, 4);

        const llmDoubt = confident ? null : it.doubt ?? null;
        if (confident && it.doubt) clearedDoubts++;

        const du = it.unitCode ? DOC_UNITS[normName(it.unitCode)] : undefined;
        const conv = baseLine(
          {
            name: it.name,
            unitCode: it.unitCode ?? null,
            qty: it.qty,
            price: it.price,
            lineSum: it.lineSum,
            countAs: it.countAs ?? null,
            packQty: it.packQty ?? null,
            packUnit: it.packUnit ?? null,
            baseUnit: it.baseUnit ?? null,
            doubt: llmDoubt,
          },
          { units: unitByCode, printed: du, productUnitCode: match?.unitCode ?? null, productConv: match ? convByProduct.get(match.productId) ?? null : null }
        );
        const itemNotes = conv.notes.map((n) => stripLineName(n, it.name));
        const doubtText = (conv.doubt ?? '').replace(/^(?:GPT|ИИ|Склад|Товаровед|Каталог|Распознавание|Сверка):\s*/i, '').trim();
        if (it.qty == null && !conv.forecast) itemNotes.push('количество не прочитано — укажите вручную');
        if (it.unitCode && !du) itemNotes.push(`единица «${it.unitCode}» не распознана — укажите базовую (г/мл/шт) и проверьте количество`);
        if (it.qty != null && it.price != null && it.lineSum != null && it.lineSum > 0) {
          const calc = it.qty * it.price;
          if (Math.abs(calc - it.lineSum) > Math.max(1, it.lineSum * 0.02)) {
            itemNotes.push(`в документе Кол × Цена = ${trimNum(calc)}, а сумма строки ${trimNum(it.lineSum)} — сверьте с фото`);
          }
        }

        const hint = it.newHint && catSet.has(it.newHint.category)
          ? it.newHint
          : meaning.hint
            ? { name: meaning.hint.name, category: catSet.has(meaning.hint.category) ? meaning.hint.category : 'прочее' }
            : classifyNewProduct(it.name) ?? (it.newHint ?? { name: it.name, category: 'прочее' });

        items.push({
          rawName: it.name,
          supplierCode: it.supplierCode ?? null,
          qty: conv.qty,
          unitId: conv.unitId,
          docUnitPrinted: it.unitCode ?? null,
          docQtyPrinted: it.qty ?? null,
          docPricePrinted: it.price ?? null,
          docLineGross: it.lineGross ?? null,
          qtyForecast: conv.forecast,
          doubt: conv.doubt,
          warnings: itemNotes.filter((n) => n && n !== doubtText),
          price: conv.price,
          vatRate: it.vatRate ? it.vatRate : null,
          vatInferred: !!it.vatInferred,
          vatSuspect: false,
          lineSum: it.lineSum,
          lineSumPrinted: it.lineSum != null && it.lineSum > 0,
          rowDiscount: null,
          match,
          candidates: filtered,
          newHint: match ? null : hint,
        });
      }

      // ── привязка скидок к строкам: показываем в карточке товара и вычитаем из нетто ──
      interface RowDiscount {
        name: string;
        amount: number;
        amountGross: number | null;
        percent: number | null;
        vatRate: number | null;
        reason: string | null;
      }
      interface OutRow {
        rawName: string;
        supplierCode: string | null;
        lineSum: number | null;
        price: number | null;
        qty: number | null;
        rowDiscount: RowDiscount | null;
        docUnitPrinted?: string | null;
        docQtyPrinted?: number | null;
        docPricePrinted?: number | null;
        docLineGross?: number | null;
        lineSumPrinted?: boolean;
        vatRate?: number | null;
        warnings?: string[];
      }
      const outRows = items as OutRow[];
      // ── «Сверка»: в сумму строки иногда попадает ЦЕНА упаковки вместо «Iznos bez PDV»
      // (строка с Kol.>1, где напечатанная сумма равна цене). Признак точный: Kol. × цена,
      // умноженное на ставку, даёт напечатанную сумму с PDV. Тогда нетто = Kol. × цена.
      {
        let fixedNet = 0;
        for (const r of outRows) {
          const q = r.docQtyPrinted ?? null;
          const p = r.docPricePrinted ?? null;
          const net = r.lineSum ?? null;
          const gross = r.docLineGross ?? null;
          if (q == null || q < 2 || p == null || p <= 0.01 || net == null || net <= 0) continue;
          if (Math.abs(net - p) > Math.max(0.02, p * 0.002)) continue;
          const full = r2(q * p);
          if (gross == null) continue;
          const rate = Math.abs(full * 1.1 - gross) <= 0.05 ? 10 : Math.abs(full * 1.2 - gross) <= 0.05 ? 20 : null;
          if (rate == null) continue;
          r.lineSum = full;
          r.vatRate = rate;
          fixedNet++;
        }
        if (fixedNet) {
          corrections.push(
            `В ${fixedNet} строках вместо суммы стояла цена упаковки — восстановил нетто как Кол. × цена (сверено по напечатанной сумме с PDV)`
          );
        }
      }
      // ── METRO: Iznos bez PDV = Kol. × Cena po pakovanju. Колонка «Kol.» при мелком шрифте
      // съезжает или теряется, поэтому сверяем количество делением напечатанных сумм.
      {
        let fixedQty = 0;
        for (const r of outRows) {
          if ((r.docUnitPrinted ?? '').toUpperCase() !== 'KO') continue;
          const price = r.docPricePrinted ?? null;
          const net = r.lineSum ?? null;
          const cur = r.docQtyPrinted ?? null;
          if (price == null || price <= 0 || net == null || net <= 0) continue;
          const k = Math.round(net / price);
          if (k < 1 || k > 500 || Math.abs(k * price - net) > 0.02) continue;
          if (cur != null && Math.abs(cur - k) < 0.001) continue;
          const packBase = cur != null && cur > 0 ? (r.qty ?? 0) / cur : 1;
          r.qty = Math.round(packBase * k * 1000) / 1000;
          r.docQtyPrinted = k;
          fixedQty++;
        }
        if (fixedQty) {
          corrections.push(`Количество в строках сверил по напечатанным суммам (нетто ÷ цена): исправил ${fixedQty} строк`);
        }
        // KG: напечатанная сумма = вес × цена за кг; вес возвращаем из деления
        let fixedKg = 0;
        for (const r of outRows) {
          if ((r.docUnitPrinted ?? '').toUpperCase() !== 'KG') continue;
          const price = r.docPricePrinted ?? null;
          const net = r.lineSum ?? null;
          const cur = r.docQtyPrinted ?? null;
          if (price == null || price <= 0 || net == null || net <= 0) continue;
          const w = net / price;
          if (w <= 0 || w >= 1000 || Math.abs(w * price - net) > 0.02) continue;
          if (cur != null && Math.abs(cur - w) < 0.0005) continue;
          const basePerUnit = cur != null && cur > 0 ? (r.qty ?? 0) / cur : 1;
          r.qty = Math.round(basePerUnit * w * 1000) / 1000;
          r.docQtyPrinted = Math.round(w * 1000) / 1000;
          fixedKg++;
        }
        if (fixedKg) {
          corrections.push(`Вес весовых строк сверил по напечатанным суммам (нетто ÷ цена за кг): исправил ${fixedKg} строк`);
        }
      }
      // нетто строк «как напечатано» — до вычитания скидок (нужно для сверки суммы скидок с итогом)
      const sumPrintedNets = r2(outRows.reduce((s, r) => s + (r.lineSum ?? 0), 0));
      // ── «Сверка»: Σ напечатанных строк = нетто документа + все скидки ──
      // Недобор, кратный цене упаковки, означает потерянный «Kol.»: восстанавливаем количество,
      // а не подгоняем суммы. Работает до привязки скидок, когда нетто строк ещё «как напечатано».
      {
        const allKnown = discItems.every((d) => d.amount != null);
        const target = doc.totalSum != null && allKnown ? r2(doc.totalSum + discNet) : null;
        const rows = outRows.filter(
          (r) =>
            r.lineSum != null &&
            r.lineSum > 0 &&
            (r.docPricePrinted ?? 0) > 0.01 &&
            (r.docQtyPrinted ?? 0) > 0 &&
            Math.abs((r.docQtyPrinted ?? 0) * (r.docPricePrinted ?? 0) - r.lineSum) <=
              Math.max(0.05, r.lineSum * 0.005)
        );
        const addQty = (r: OutRow, k: number): void => {
          const p = r.docPricePrinted ?? 0;
          const packBase = (r.qty ?? 0) / (r.docQtyPrinted ?? 1);
          r.docQtyPrinted = r2((r.docQtyPrinted ?? 0) + k);
          r.qty = Math.round(((r.qty ?? 0) + k * packBase) * 1000) / 1000;
          r.lineSum = r2((r.lineSum ?? 0) + k * p);
          // сумма с PDV меньше новой нетто — цифра была вычислена от старой строки, а не прочитана
          if (r.docLineGross != null && r.docLineGross < (r.lineSum ?? 0) - 0.01) {
            r.docLineGross = null;
            r.vatRate = null;
          }
        };
        for (let step = 0; step < 4 && target != null; step++) {
          const sumNow = outRows.reduce((s, r) => s + (r.lineSum ?? 0), 0);
          const deficit = r2(target - sumNow);
          if (deficit < 0.5) break;
          const singles = rows
            .map((r) => ({ r, k: Math.round(deficit / (r.docPricePrinted ?? 1)) }))
            .filter(({ r, k }) => k >= 1 && k <= 30 && Math.abs(k * (r.docPricePrinted ?? 0) - deficit) <= 0.03);
          let hit: { r: OutRow; k: number }[] | null = null;
          if (singles.length === 1) hit = singles;
          else if (!singles.length) {
            search: for (let i = 0; i < rows.length; i++) {
              const pi = rows[i].docPricePrinted ?? 0;
              for (let k1 = 1; k1 <= 15; k1++) {
                const rest = r2(deficit - k1 * pi);
                if (rest < 0.5) continue;
                for (let j = i + 1; j < rows.length; j++) {
                  const pj = rows[j].docPricePrinted ?? 1;
                  const k2 = Math.round(rest / pj);
                  if (k2 >= 1 && k2 <= 15 && Math.abs(k2 * pj - rest) <= 0.03) {
                    hit = [
                      { r: rows[i], k: k1 },
                      { r: rows[j], k: k2 },
                    ];
                    break search;
                  }
                }
              }
            }
          }
          if (!hit) break;
          for (const h of hit) addQty(h.r, h.k);
          corrections.push(
            `Недобор нетто ${trimNum(deficit)} закрылся целым числом упаковок — восстановил количество: ${hit
              .map((h) => `«${h.r.rawName}» +${h.k}`)
              .join(', ')} (суммы строк пересчитаны)`
          );
        }
      }
      const outDiscounts: {
        name: string;
        productName: string | null;
        discountKind: string;
        amount: number | null;
        amountGross: number | null;
        percent: number | null;
        vatRate: number | null;
        includedInLineSum: boolean | null;
        doubt: string | null;
      }[] = [];
      const outTargets: (OutRow | undefined)[] = [];
      let discAttached = 0;
      const attachDiscount = (idx: number, target: OutRow, amount: number): void => {
        const printed = target.lineSum ?? 0;
        const d = outDiscounts[idx];
        // ставку берём у строки товара: она уже сверена с её напечатанными нетто/с PDV
        const rate = target.vatRate ?? d.vatRate ?? null;
        // сумма с PDV: печатная, если сходится с amount × (1 + ставка), иначе вычисляем по ставке строки
        const printedGross = d.amountGross;
        const grossOk = printedGross != null && rate != null && Math.abs(printedGross - amount * (1 + rate / 100)) <= 0.05;
        const amountGross = grossOk ? printedGross : rate != null ? r2(amount * (1 + rate / 100)) : printedGross;
        const percent = r2((amount / printed) * 100);
        target.rowDiscount = {
          name: d.name,
          amount,
          amountGross,
          percent,
          vatRate: rate,
          reason: /kupi\s+vise|plati\s+manje/i.test(d.name) ? 'акция Kupi više, plati manje' : null,
        };
        target.lineSum = r2(printed - amount);
        if ((target.qty ?? 0) > 0 && target.price != null) {
          target.price = Math.round(target.price * (1 - amount / printed) * 1e10) / 1e10;
        }
        outDiscounts[idx] = { ...d, amount, amountGross, percent, vatRate: rate, includedInLineSum: true, doubt: null };
        outTargets[idx] = target;
        discAttached++;
      };

      for (const d of discItems) {
        const code = (d.supplierCode ?? '').replace(/[^0-9]/g, '');
        const nameKey = normName(d.productName ?? '');
        // 1) та же шифра, что у товара; 2) точное название; 3) однозначное вхождение названия
        let row: OutRow | OutRow[] | undefined =
          (code ? outRows.find((r) => (r.supplierCode ?? '').replace(/[^0-9]/g, '') === code) : undefined) ??
          (nameKey ? outRows.find((r) => normName(r.rawName) === nameKey) : undefined) ??
          (nameKey
            ? outRows.filter((r) => {
                const rn = normName(r.rawName);
                return rn.includes(nameKey) || nameKey.includes(rn);
              })
            : []);
        if (Array.isArray(row) && row.length !== 1) row = undefined;
        const target = Array.isArray(row) ? row[0] : row;
        let amount = d.amount != null ? r2(d.amount) : null;
        const amountGross0 = d.amountGross != null ? r2(d.amountGross) : null;
        const lineSum = target?.lineSum ?? null;
        // в POPUST-строку попали цифры соседнего товара? (сумма совпала с нетто другого товара)
        const amt: number | null = amount;
        const borrowed =
          amt != null &&
          amt > 0 &&
          outRows.some(
            (r) =>
              r !== target &&
              r.lineSum != null &&
              Math.abs(r.lineSum - amt) <= 0.02 &&
              (amountGross0 == null || (r.docLineGross != null && Math.abs(r.docLineGross - amountGross0) <= 0.03))
          );
        let doubt: string | null = null;
        if (!target) doubt = 'скидка не привязана к строке — вычтите вручную';
        else if (borrowed) {
          doubt = 'в POPUST-строку попали цифры соседнего товара — сумму восстановлю по итогам документа';
          amount = null;
        } else if (amount == null) doubt = 'сумма скидки не прочитана — восстановлю по итогам документа';
        else if (amount < 0.05) {
          doubt = 'сумма скидки не прочитана — восстановлю по итогам документа';
          amount = null;
        } else if (lineSum == null) {
          doubt = 'нетто строки не прочитано — сумму скидки сверю по итогам документа';
          amount = null;
        } else if (amount >= lineSum) {
          // скидка больше нетто своей строки — почти всегда недобор количества в строке,
          // а не ошибка скидки: печатную сумму оставляем, строку человек сверит по фото
          doubt = `скидка ${trimNum(amount)} больше нетто своей строки ${trimNum(lineSum)} — вероятно, в строке не прочитано количество; сумму скидки оставил как напечатана`;
        }
        const idx = outDiscounts.length;
        // сумма с PDV — по ставке строки: печатная цифра скидки часто попадает с соседней строки
        const rateForD = target?.vatRate ?? d.vatRate ?? null;
        const grossForD = amount != null && rateForD != null ? r2(amount * (1 + rateForD / 100)) : amountGross0;
        outDiscounts.push({
          name: d.name,
          productName: target?.rawName ?? d.productName ?? null,
          discountKind: d.kind ?? 'unknown',
          amount,
          amountGross: grossForD,
          percent: d.percent ?? null,
          vatRate: rateForD,
          includedInLineSum: false,
          doubt,
        });
        outTargets.push(target);
        if (target && amount != null && amount < (target.lineSum ?? Number.POSITIVE_INFINITY)) attachDiscount(idx, target, amount);
        else if (doubt) warnings.push(`Скидка «${d.name}»: ${doubt}`);
      }

      // ── скидка не прочитана/перепутана: восстанавливаем сумму из напечатанных итогов ──
      // нетто = Σ строк − скидки => недостающая скидка = Σ строк − уже привязанные − итог
      const attachedSum = r2(
        outDiscounts.reduce((s, d) => (d.includedInLineSum ? s + Math.abs(d.amount ?? 0) : s), 0)
      );
      const needDisc = doc.totalSum != null ? r2(sumPrintedNets - attachedSum - doc.totalSum) : 0;
      const openIdx = outDiscounts.map((d, i) => (!d.includedInLineSum && d.amount == null ? i : -1)).filter((i) => i >= 0);
      if (openIdx.length === 1 && needDisc > 0.01) {
        const i = openIdx[0];
        const target = outTargets[i];
        const printed = target?.lineSum ?? null;
        if (target && printed != null && needDisc < printed) {
          outDiscounts[i].amount = needDisc;
          outDiscounts[i].doubt = null;
          attachDiscount(i, target, needDisc);
          corrections.push(
            `Сумму скидки «${outDiscounts[i].name}» восстановил из итогов документа: Σ строк ${trimNum(sumPrintedNets)} − нетто ${trimNum(doc.totalSum ?? 0)} − прочие скидки = ${trimNum(needDisc)}`
          );
        }
      } else if (openIdx.length > 1 && needDisc > 0.01) {
        warnings.push(
          `Не прочитаны суммы ${openIdx.length} скидок, а по итогам их недостаёт на ${trimNum(needDisc)} — разделите вручную по фото`
        );
      }
      if (doc.totalSum != null && outDiscounts.length) {
        const expectDisc = r2(sumPrintedNets - doc.totalSum);
        const attachedNow = r2(
          outDiscounts.reduce((s, d) => (d.includedInLineSum ? s + Math.abs(d.amount ?? 0) : s), 0)
        );
        if (expectDisc > 0.01 && Math.abs(attachedNow - expectDisc) > 1) {
          warnings.push(
            `Σ скидок ${trimNum(attachedNow)} ≠ сумме скидок по итогам ${trimNum(expectDisc)} — проверьте суммы скидок по фото`
          );
        }
      }
      if (discAttached) {
        corrections.push(`Скидки разнесены по строкам товаров: ${discAttached} шт — цена и нетто этих строк уже со скидкой`);
      }
      {
        const dNet = r2(outDiscounts.reduce((s, d) => s + Math.abs(d.amount ?? 0), 0));
        const dGr = r2(outDiscounts.reduce((s, d) => s + Math.abs(d.amountGross ?? 0), 0));
        if (outDiscounts.length) {
          corrections.push(
            `Скидки: ${outDiscounts.length} · всего ${trimNum(dNet)} без PDV${dGr ? ` (${trimNum(dGr)} с PDV)` : ''}`
          );
        }
      }

      // ── «Сверка»: НДС, итоги, предупреждения ────────────────────────
      type OutItem = {
        rawName: string;
        lineSum: number | null;
        vatRate: number | null;
        warnings?: string[];
        qty?: number | null;
        price?: number | null;
        docQtyPrinted?: number | null;
        docPricePrinted?: number | null;
        docLineGross?: number | null;
        rowDiscount?: { amount: number } | null;
      };
      const outItems = items as OutItem[];
      const lineVat = (sum: number, rate: number): number => Math.round(((sum * rate) / 100) * 100) / 100;

      // ставка PDV не напечатана в строках — выводим арифметикой по итогу НДС
      if (doc.totalVat != null && doc.totalVat > 0) {
        const open = outItems.filter((x) => x.vatRate == null && (x.lineSum ?? 0) > 0.001);
        if (open.length) {
          const known = outItems.reduce((s, x) => (x.vatRate == null ? s : s + lineVat(x.lineSum ?? 0, x.vatRate)), 0);
          const rest = r2(doc.totalVat - known);
          let solved: number[] | null = null;
          // «Сверка»: подбираем ставку КАЖДОЙ открытой строке (10/20, при нужде 0), чтобы Σ PDV
          // сошлась с напечатанным итогом, — одной общей ставкой это часто не решается
          if (open.length <= 10) {
            for (const grid of [[10, 20], [0, 10, 20]] as const) {
              for (let mask = 0; mask < grid.length ** open.length && !solved; mask++) {
                let m = mask;
                const rates: number[] = [];
                for (let i = 0; i < open.length; i++) {
                  rates.push(grid[m % grid.length]);
                  m = Math.floor(m / grid.length);
                }
                const total = open.reduce((s, x, i) => s + lineVat(x.lineSum ?? 0, rates[i]), 0);
                if (Math.abs(total - rest) <= 0.05) solved = rates;
              }
              if (solved) break;
            }
          }
          if (solved) {
            open.forEach((x, i) => (x.vatRate = solved![i]));
            const uniq = Array.from(new Set(open.map((x) => x.vatRate))).sort((a, b) => (a ?? 0) - (b ?? 0));
            const mix = uniq.length === 1 ? `ставку ${uniq[0]}%` : `ставки ${uniq.join('/')}% по строкам`;
            corrections.push(`Ставка PDV не напечатана — вывел ${mix} так, чтобы Σ PDV сошлась с итогом документа`);
            // скидки этих строк пересчитываем с PDV теперь, когда ставка известна
            outDiscounts.forEach((d, idx) => {
              const t = outTargets[idx];
              if (d.includedInLineSum !== true || d.amountGross != null) return;
              const rate = t?.vatRate ?? d.vatRate;
              if (rate == null || t?.rowDiscount == null) return;
              const amountGross = r2(Math.abs(d.amount ?? 0) * (1 + rate / 100));
              outDiscounts[idx] = { ...d, vatRate: rate, amountGross };
              t.rowDiscount = { ...t.rowDiscount, vatRate: rate, amountGross };
            });
          } else {
            const rate = [0, 5, 10, 20].find((r) => Math.abs(open.reduce((s, x) => s + lineVat(x.lineSum ?? 0, r), 0) - rest) <= 1.5);
            if (rate != null) {
              for (const x of open) x.vatRate = rate;
              corrections.push(rate > 0 ? `Ставка PDV не напечатана — вывел ${rate}% по итогу НДС документа` : 'Строки без PDV: итог НДС уже закрыт другими строками');
            }
          }
        }
      }

      const sumLines = outItems.reduce((s, x) => s + (x.lineSum ?? 0), 0);
      // непривязанные скидки ещё не сидят в суммах строк — они законно уменьшают нетто
      const separateDisc = r2(
        outDiscounts.reduce((s, d) => (d.includedInLineSum === true ? s : s + Math.abs(d.amount ?? 0)), 0)
      );
      if (doc.totalSum != null && doc.totalSum > 0 && sumLines > 0) {
        const netForCompare = r2(sumLines - separateDisc);
        const dNet = r2(doc.totalSum - netForCompare);
        const svcAbs = serviceLines.reduce((s, x) => s + Math.abs(x.amount ?? 0), 0);
        const explainedBySvc = svcAbs > 0 && Math.abs(Math.abs(dNet) - svcAbs) <= Math.max(2, doc.totalSum * 0.02);
        if (!explainedBySvc && Math.abs(dNet) > Math.max(2, doc.totalSum * 0.02)) {
          const maxLine = Math.max(0, ...outItems.map((x) => x.lineSum ?? 0));
          if (dNet > 0 && dNet > maxLine * 10 + 10) {
            warnings.push(
              `Σ распознанных строк ${trimNum(sumLines)} меньше нетто документа ${trimNum(doc.totalSum)} на ${trimNum(dNet)} — не все позиции попали в разбор. Добавьте недостающие вручную: итог подгонкой не дорисовываем`
            );
          } else {
            warnings.push(`Σ строк ${trimNum(netForCompare)} ≠ нетто документа ${trimNum(doc.totalSum)} (Δ ${trimNum(dNet)}) — сверьте позиции с фото (агенты уже перечитывали спорные строки)`);
          }
        }
      }
      if (doc.totalSum != null && doc.totalVat != null && doc.totalGross != null) {
        const diff = Math.abs(doc.totalSum + doc.totalVat - doc.totalGross);
        if (diff > Math.max(2, Math.abs(doc.totalGross) * 0.002)) {
          warnings.push(
            `Нетто ${trimNum(doc.totalSum)} + PDV ${trimNum(doc.totalVat)} ≠ к оплате ${trimNum(doc.totalGross)} — итоги не сходятся, проверьте по фото`
          );
        }
      }
      if (doc.totalVat != null && doc.totalVat > 0) {
        const calcVat = outItems.reduce((s, x) => s + lineVat(x.lineSum ?? 0, x.vatRate ?? 0), 0);
        if (Math.abs(calcVat - doc.totalVat) > 1.5) {
          warnings.push(`Σ PDV по ставкам ${trimNum(calcVat)} ≠ PDV в документе ${trimNum(doc.totalVat)} — проверьте ставки`);
        }
      }
      if (list.length > 1) {
        warnings.unshift(`Разобрал ${list.length} файла как одну накладную — сверьте строки на стыках листов`);
      }
      if (!items.length) warnings.push('«Распознавание» и «Каталог» не нашли ни одной товарной строки — проверьте читаемость фото');
      // Контроль читаемости: строка-шифра без названия и точные дубли — только предупреждаем,
      // строки не удаляем и не переставляем.
      {
        let unnamed = 0;
        let duplicates = 0;
        const seen = new Map<string, number>();
        for (const it of outItems) {
          const raw = String(it.rawName ?? '').trim();
          if (/^\d{8,15}$/.test(raw)) {
            it.warnings = [...(it.warnings ?? []), 'название не распознано — указана только шифра/штрихкод; укажите товар вручную'];
            unnamed++;
          }
          const key = [raw.toLowerCase(), it.docQtyPrinted, it.docPricePrinted, it.lineSum].join('|');
          if (seen.has(key)) {
            it.warnings = [...(it.warnings ?? []), 'точная копия строки выше — проверьте, не дубль ли это'];
            duplicates++;
          } else {
            seen.set(key, 1);
          }
        }
        if (unnamed || duplicates) {
          log('stage', `Контроль: строк без названия — ${unnamed}, возможных дублей — ${duplicates}`);
        }
      }
      // Сверка уже поправила количества/суммы: снимаем устаревшие «Кол × Цена» или обновляем цифры.
      {
        let cleaned = 0;
        for (const it of outItems) {
          const warns = it.warnings;
          if (!warns?.length) continue;
          const idx = warns.findIndex((w) => w.startsWith('в документе Кол × Цена ='));
          if (idx < 0) continue;
          const qty = it.docQtyPrinted;
          const price = it.docPricePrinted;
          const sum = it.lineSum;
          if (qty == null || price == null || sum == null) continue;
          const disc = it.rowDiscount?.amount ?? 0;
          const calc = qty * price - disc;
          if (Math.abs(calc - sum) <= Math.max(1, Math.abs(sum) * 0.002)) {
            it.warnings = warns.filter((w) => !w.startsWith('в документе Кол × Цена ='));
            cleaned++;
          } else {
            const calcText = disc > 0
              ? `Кол × Цена − скидка ${trimNum(disc)} = ${trimNum(calc)}`
              : `Кол × Цена = ${trimNum(calc)}`;
            warns[idx] = `в документе ${calcText}, а сумма строки ${trimNum(sum)} — сверьте с фото`;
          }
        }
        if (cleaned) log('stage', `Сверка: снял устаревшие замечания по ${cleaned} строкам`);
      }
      {
        const matched = (items as { match: unknown }[]).filter((x) => !!x.match).length;
        const warnCount = warnings.length + (items as { warnings?: string[] }[]).reduce((s, x) => s + (x.warnings?.length ?? 0), 0);
        log(
          'stage',
          `Сопоставление: ${matched} из ${items.length} строк уже есть в каталоге${warnCount ? ` · предупреждений: ${warnCount}` : ''}`
        );
      }
      // ── «Контроль»: детерминированная проверка сопоставлений ─────────────
      // Словарь и каталог уже отсеяли чужие товары; здесь фиксируем итог для журнала.
      const controlNotes = [
        droppedSuggestions ? `лишних подсказок: ${droppedSuggestions}` : '',
        clearedDoubts ? `избыточных сомнений: ${clearedDoubts}` : '',
      ].filter(Boolean);
      log(
        'stage',
        `Агент «Контроль»: проверено ${doc.items.length} ${pluralRu(doc.items.length, 'строка', 'строки', 'строк')}` +
          (controlNotes.length ? ` · ${controlNotes.join(' · ')}` : '')
      );
      if (controlNotes.length) {
        corrections.push(`Контроль сопоставления: ${controlNotes.join(' · ')} — уверенные совпадения оставлены без лишних вариантов`);
      }
      {
        const warnCount = warnings.length + (items as { warnings?: string[] }[]).reduce((s, x) => s + (x.warnings?.length ?? 0), 0);
        log(
          'result',
          `Готово за ${((Date.now() - startedAt) / 1000).toFixed(1)} с: ${items.length} ${pluralRu(items.length, 'позиция', 'позиции', 'позиций')}${warnCount ? `, требуют внимания: ${warnCount}` : ''}`
        );
      }

      res.json({
        storedFile,
        fileName,
        extraFiles: extraStored,
        model: 'ИИ · агенты',
        doc: {
          number: doc.number,
          supplier: doc.supplier,
          date: doc.date,
          supplierPib: doc.supplierPib,
          currency: doc.currency ?? 'RSD',
          totalSum: doc.totalSum,
          totalVat: doc.totalVat,
          totalGross: doc.totalGross,
        },
        items,
        warnings,
        corrections,
        serviceLines,
        discounts: {
          total: (() => { const t = r2(outDiscounts.reduce((s, d) => s + Math.abs(d.amount ?? 0), 0)); return t || null; })(),
          totalGross: (() => { const t = r2(outDiscounts.reduce((s, d) => s + Math.abs(d.amountGross ?? 0), 0)); return t || null; })(),
          items: outDiscounts,
          doubt: null,
        },
        ...(body.debug === true ? { transcript, timings } : {}),
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  })
);

/** Категории номенклатуры из настроек — для подсказок новых товаров. */
async function loadCategoryNames(): Promise<string[]> {
  const { rows } = await pool.query('select name from product_categories order by name');
  return rows.map((r) => String(r.name));
}

function guessMime(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' } as Record<string, string>)[ext] ?? '';
}

/**
 * GET /api/import/file/:stored — отдать лист пакета до проведения накладной
 * (пользователь смотрит фото, пока решает по строкам). Имя принимаем только в формате /parse.
 */
importRouter.get(
  '/file/:stored',
  wrap(async (req, res) => {
    const stored = req.params.stored;
    if (!/^[A-Za-z0-9._-]+$/.test(stored) || stored.includes('..')) throw new ApiError(400, 'Некорректное имя файла');
    const abs = path.resolve(config.uploadsDir, stored);
    if (!abs.startsWith(path.resolve(config.uploadsDir) + path.sep)) throw new ApiError(404, 'Файл не найден');
    try {
      if (!(await fs.promises.stat(abs)).isFile()) throw new ApiError(404, 'Файл не найден');
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(404, 'Файл не найден');
    }
    res.setHeader('Content-Type', guessMime(stored) || 'application/octet-stream');
    res.sendFile(abs);
  })
);

/** Позиция подтверждения импорта — то, что присылает клиент после правок разбора. */
export interface ConfirmImportItem {
  rawName: string;
  qty: number;
  unitId: number;
  price: number | null;
  vatRate: number | null;
  productId?: number | null;
  create?: { name?: string; category?: string; unitId?: number } | null;
}

export interface ConfirmImportInput {
  number: string;
  supplier: string;
  docDate: string | null;
  fileName: string | null;
  storedFile: string | null;
  /** Байты фото, поднятые с диска (uploads/waybills) — в тестах можно не передавать. */
  fileBuf?: Buffer | null;
  fileMime?: string | null;
  extraFiles?: { stored: string; name: string; mime: string; data: Buffer }[] | null;
  currency: string | null;
  supplierPib: string | null;
  docTotals: { net: number | null; vat: number | null; gross: number | null };
  items: Record<string, unknown>[];
}

export interface ConfirmImportResult {
  waybillId: number;
  created: { id: number; name: string }[];
  aliasesSaved: number;
}

/**
 * Проведение решений пользователя по разбору накладной (без HTTP — общая для маршрута и тестов):
 *  - create -> создать позицию (или взять существующую с таким же именем);
 *  - для каждой позиции запоминаем написание из документа как псевдоним,
 *    если оно отличается от складского названия — в следующий раз сматчится само.
 * Затем обычный приход накладной (всё в одной транзакции — runTx или tx через pool).
 */
export async function confirmImport(input: ConfirmImportInput, actor: Actor, runTx: typeof tx = tx): Promise<ConfirmImportResult> {
  const { number, supplier, docDate, fileName, storedFile, fileBuf, fileMime, currency, supplierPib, docTotals, items: rawItems } = input;
  const extraFiles = input.extraFiles ?? [];
  return runTx(async (client) => {
    const created: { id: number; name: string }[] = [];
    let aliasesSaved = 0;
    // Приход не должен терять продавца: если его ещё нет в справочнике (например, разбор
    // пришёл из старой вкладки без автосоздания), заводим минимальную карточку в той же транзакции.
    let supplierName = isPlaceholderSupplier(supplier) ? '' : supplier;
    if (supplierName) {
      const ensured = await resolveOrCreateSupplier(
        { supplier: supplierName, supplierPib },
        '',
        { client, actorId: actor?.id ?? null }
      );
      if (ensured) {
        supplierName = ensured.ref.name;
        if (ensured.created) {
          await auditTx(client, actor, {
            action: 'create',
            entity: 'supplier',
            entityId: ensured.ref.id,
            title: `Поставщик · ${ensured.ref.name}`,
            details: { source: 'waybill', pib: supplierPib },
          });
        }
      }
    }
    const items: { productId: number; qty: number; unitId: number; price: number | null; vatRate: number | null }[] = [];

    for (const raw of rawItems) {
      const rawName = reqStr(raw, 'rawName');
      const qty = reqNum(raw, 'qty');
      const unitId = reqNum(raw, 'unitId');
      const price = optNum(raw, 'price');
      const vatRate = optNum(raw, 'vatRate'); // ставка PDV в % или null
      let productId: number;

      const create = raw.create as { name?: string; category?: string; unitId?: number } | null | undefined;
      if (create && create.name) {
        const name = String(create.name).trim();
        const category = String(create.category ?? 'прочее').trim() || 'прочее';
        const unitReq = reqNum(create, 'unitId');
        const { rows: u } = await client.query('select base_factor::float8 as f from units where id = $1', [unitReq]);
        if (!u.length || u[0].f !== 1) throw new ApiError(400, 'Складская единица у новой позиции должна быть базовой (г/мл/шт)');
        const { rows: ex } = await client.query('select id from products where lower(name) = lower($1)', [name]);
        if (ex.length) {
          productId = ex[0].id as number; // такое название уже есть — дописываемся к нему
        } else {
          const { rows: ins } = await client.query(
            `insert into products (name, category, unit_id, created_by, updated_by) values ($1, $2, $3, $4, $4) returning id`,
            [name, category, unitReq, actor?.id ?? null]
          );
          productId = ins[0].id as number;
          await client.query('insert into stock (product_id, qty, avg_cost) values ($1, 0, 0)', [productId]);
          created.push({ id: productId, name });
        }
      } else {
        productId = reqNum(raw, 'productId');
        const { rows: ok } = await client.query('select 1 from products where id = $1', [productId]);
        if (!ok.length) throw new ApiError(400, `Позиция #${productId} не найдена`);
      }

      // запоминаем написание из документа, если оно не совпадает с названием позиции
      const { rows: pn } = await client.query('select name from products where id = $1', [productId]);
      const alias = normName(rawName);
      if (alias && alias !== normName(pn[0].name)) {
        const { rows: known } = await client.query('select 1 from product_aliases where alias = $1', [alias]);
        await client.query(
          `insert into product_aliases (product_id, alias, alias_raw) values ($1, $2, $3)
           on conflict (alias) do update set product_id = excluded.product_id, alias_raw = excluded.alias_raw`,
          [productId, alias, rawName.trim()]
        );
        if (!known.length) aliasesSaved++;
      }

      items.push({ productId, qty, unitId, price, vatRate });
    }

    const waybillId = await ingestWaybill(
      client,
      {
        number,
        supplier: supplierName,
        docDate,
        actor,
        fileName,
        storedFile,
        fileData: fileBuf ?? null,
        fileMime: fileMime ?? null,
        extraFiles: extraFiles.length ? extraFiles : null,
        currency,
        supplierPib,
        docTotalNet: docTotals.net,
        docTotalVat: docTotals.vat,
        docTotalGross: docTotals.gross,
      },
      items
    );
    await auditTx(client, actor, {
      action: 'post',
      entity: 'waybill',
      entityId: waybillId,
      title: `Накладная №${number}${supplier ? ' · ' + supplier : ''}`,
      details: { mode: 'import', items: items.length, createdProducts: created.length, aliasesSaved },
    });
    return { waybillId, created, aliasesSaved };
  });
}

/**
 * POST /api/import/confirm — разбор тела + поднятие фото с диска, затем confirmImport.
 */
importRouter.post(
  '/confirm',
  wrap(async (req, res) => {
    const number = reqStr(req.body, 'number');
    const supplier = typeof req.body.supplier === 'string' ? req.body.supplier.trim() : '';
    const docDate = typeof req.body.docDate === 'string' && req.body.docDate ? req.body.docDate : null;
    const fileName = typeof req.body.fileName === 'string' ? req.body.fileName.slice(0, 120) : null;
    // серверное имя файла принимаем только в формате, сгенерированным /parse
    const storedFile =
      typeof req.body.storedFile === 'string' && /^[A-Za-z0-9._-]+$/.test(req.body.storedFile)
        ? req.body.storedFile
        : null;
    const rawItems = reqArr(req.body, 'items');
    // реквизиты из разбора (пользователь мог поправить только номер/дату/поставщика)
    const currency = typeof req.body.currency === 'string' ? req.body.currency.trim().toUpperCase().slice(0, 3) : null;
    const supplierPib = typeof req.body.supplierPib === 'string' ? req.body.supplierPib.replace(/[^0-9]/g, '') || null : null;
    const docTotals = {
      net: optNum(req.body, 'docTotalNet'),
      vat: optNum(req.body, 'docTotalVat'),
      gross: optNum(req.body, 'docTotalGross'),
    };
    // фото документа, сохранённое на /parse — кладём в БД, чтобы оно пережило чистку диска
    let fileBuf: Buffer | null = null;
    let fileMime: string | null = null;
    if (storedFile) {
      const abs = path.join(config.uploadsDir, storedFile);
      if (fs.existsSync(abs)) {
        fileBuf = fs.readFileSync(abs);
        fileMime = guessMime(storedFile) || 'application/octet-stream';
      }
    }
    // дополнительные листы/дубли фото той же накладной
    const extraIn = Array.isArray(req.body.extraFiles) ? req.body.extraFiles : [];
    const extraFiles: { stored: string; name: string; mime: string; data: Buffer }[] = [];
    for (const e of extraIn) {
      const rec = e as Record<string, unknown>;
      const stored =
        typeof rec.stored === 'string' && /^[A-Za-z0-9._-]+$/.test(rec.stored) ? rec.stored : null;
      if (!stored) continue;
      const abs = path.join(config.uploadsDir, stored);
      if (!fs.existsSync(abs)) continue;
      extraFiles.push({
        stored,
        name: typeof rec.name === 'string' ? rec.name.slice(0, 120) : stored,
        mime: guessMime(stored) || 'application/octet-stream',
        data: fs.readFileSync(abs),
      });
      if (extraFiles.length >= 8) break;
    }

    const result = await confirmImport(
      {
        number,
        supplier,
        docDate,
        fileName,
        storedFile,
        fileBuf,
        fileMime,
        extraFiles,
        currency,
        supplierPib,
        docTotals,
        items: rawItems,
      },
      req.user
    );

    res.status(201).json(result);
  })
);
