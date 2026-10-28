import * as fs from 'fs';
import * as path from 'path';
import { Router } from 'express';
import { pool, tx } from '../db';
import { config } from '../config';
import { ApiError, optNum, reqArr, reqNum, reqStr, wrap } from '../http';
import { parseWaybillDoc, CatalogProduct } from '../services/llm';
import { convertAcross, type ProdConv } from '../services/expansion';
import { ingestWaybill } from './waybills';

export const importRouter = Router();

/** Нормализация имени для матчинга: lower, ё->е, только буквы/цифры, одиночные пробелы. */
function normName(s: string): string {
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
function classifyNonProduct(name: string): 'discount' | 'service' | 'total' | null {
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
  л: { code: 'мл', factor: 1000 }, l: { code: 'мл', factor: 1000 }, liter: { code: 'мл', factor: 1000 },
  liters: { code: 'мл', factor: 1000 }, litres: { code: 'мл', factor: 1000 }, litre: { code: 'мл', factor: 1000 },
  литр: { code: 'мл', factor: 1000 }, литров: { code: 'мл', factor: 1000 },
  литра: { code: 'мл', factor: 1000 },
  шт: { code: 'шт', factor: 1 }, шт1: { code: 'шт', factor: 1 }, штука: { code: 'шт', factor: 1 },
  штук: { code: 'шт', factor: 1 }, szt: { code: 'шт', factor: 1 }, pcs: { code: 'шт', factor: 1 },
  pc: { code: 'шт', factor: 1 }, kom: { code: 'шт', factor: 1 }, komada: { code: 'шт', factor: 1 },
  kos: { code: 'шт', factor: 1 },
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
  /(\d+(?:[.,]\d+)?)\s*(грам\p{L}*|grams?|gr|гр|килограм\p{L}*|кг|kg|мл|ml|миллилитр\p{L}*|mililitr\p{L}*|литр\p{L}*|liters?|l|л|тон\p{L}*|tons?|т|g|г)(?![\p{L}\p{N}])/giu;

/** -> { code: базовая г/мл, per: фасовка в базовых } или null, если в названии фасовки нет. */
export function pkgFromName(name: string): { code: string; per: number } | null {
  for (const m of name.matchAll(PKG_RE)) {
    const num = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(num) || num <= 0) continue;
    const du = DOC_UNITS[normName(m[2])];
    if (du && du.code !== 'шт') return { code: du.code, per: num * du.factor };
  }
  return null;
}

interface UnitRow { id: number; code: string; factor: number; dimension: string }

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
  let doubt: string | null = line.doubt ? `GPT: ${line.doubt}` : null;

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
      notes.push(`${name}: GPT предложил считать содержимым (${trimNum(p.per)} ${p.code} в упаковке), но количество в строке уже весовое (${trimNum(line.qty ?? 0)} ${line.unitCode}) — оставляю как напечатано`);
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
      asContents(pack, `GPT: считается содержимым, фасовка ${trimNum(pack.per)} ${pack.code}`);
    } else {
      const pkg = pkgFromName(line.name);
      if (pkg) {
        asContents(pkg, `GPT: считается содержимым, но фасовку не назвала — взял ${trimNum(pkg.per)} ${pkg.code} из названия`);
      } else {
        doubt = doubt ?? 'GPT решила считать содержимым, но размер упаковки не назван — укажите количество и единицу вручную';
        notes.push(`${name}: ${doubt}`);
      }
    }
  } else if (line.countAs === 'pieces') {
    // страховка: фасовка в названии написана, а модель настаивает на штуках — пусть человек посмотрит
    const pkg = pkgFromName(line.name);
    if (pkg && printed && printed.code === 'шт') {
      notes.push(`${name}: GPT считает позицию штуками, но в названии написана фасовка ${trimNum(pkg.per)} ${pkg.code} — проверьте, не надо ли положить ${trimNum((line.qty ?? 1) * (printed.factor ?? 1) * pkg.per)} ${pkg.code}`);
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
  wrap(async (_req, res) => {
    const body = _req.body ?? {};
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

    const catalog = await loadCatalog();
    const units = await loadUnitRows();
    const { doc, model, transcript, corrections } = await parseWaybillDoc({
      files: list.map((f) => ({ mime: f.mime, base64: f.base64 })),
      catalog: catalog.products,
      unitCodes: units.map((u) => u.code),
    });
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
          serviceLines.push({ kind, name: it.name.trim(), amount: amt != null ? Math.round(amt * 100) / 100 : null });
        }
        continue;
      }
      const norm = normName(it.name);
      // 1) точное совпадение с именем, 2) запомненный псевдоним, 3) уверенный GPT
      let match: { productId: number; name: string; unitCode: string; via: 'name' | 'alias' | 'llm' } | null = null;
      const byName = byNormName.get(norm);
      const byAl = byAlias.get(norm);
      if (byName) match = { productId: byName.id, name: byName.name, unitCode: byName.unitCode, via: 'name' };
      else if (byAl) match = { productId: byAl.id, name: byAl.name, unitCode: byAl.unitCode, via: 'alias' };
      else if (it.productId != null && validIds.has(it.productId)) {
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
      warnings.push(...conv.notes);
      const qtyBase = conv.qty;
      const priceBase = conv.price;
      const unitIdOut = conv.unitId;
      const qtyForecast = conv.forecast;
      const doubt = conv.doubt;

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
        newHint: it.newHint,
      });
      if (it.qty == null && !qtyForecast) warnings.push(`«${it.name}» — количество не прочитано, укажите вручную`);
      if (it.unitCode && !du) warnings.push(`«${it.name}»: единица «${it.unitCode}» не распознана — укажите базовую (г/мл/шт) и проверьте количество`);
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

/**
 * POST /api/import/confirm — проведение решений пользователя:
 *  - create -> создать позицию (или взять существующую с таким же именем);
 *  - для каждой позиции запоминаем написание из документа как псевдоним,
 *    если оно отличается от складского названия — в следующий раз сматчится само.
 * Затем обычный приход накладной (одна транзакция).
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

    const result = await tx(async (client) => {
      const created: { id: number; name: string }[] = [];
      let aliasesSaved = 0;
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
              `insert into products (name, category, unit_id) values ($1, $2, $3) returning id`,
              [name, category, unitReq]
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
          supplier,
          docDate,
          fileName,
          storedFile,
          fileData: fileBuf,
          fileMime,
          extraFiles: extraFiles.length ? extraFiles : null,
          currency,
          supplierPib,
          docTotalNet: docTotals.net,
          docTotalVat: docTotals.vat,
          docTotalGross: docTotals.gross,
        },
        items
      );
      return { waybillId, created, aliasesSaved };
    });

    res.status(201).json(result);
  })
);
