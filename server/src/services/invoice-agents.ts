import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { ApiError } from '../http';
import { extractCliJson, runCliLogged } from './qoder-cli';
import type { CatalogProduct } from './llm';
import type { LogKind } from './ws-log';

/**
 * «Агенты» умного прихода (вкладка Qoder CLI).
 *
 * Разбор одной накладной идёт конвейером из специализированных проходов — у каждого своя
 * задача и свои правила, поэтому модель не смешивает «прочитать», «узнать товар» и «посчитать»:
 *
 *   1. «Чтец»    — vision: переписывает документ дословно по колонкам, с учётом поворота
 *                  и формата (METRO / Monolith / обычная отпремница). Ничего не считает.
 *   2. «Товаровед» — текст: по транскрипции и каталогу склада определяет существующий товар
 *                  (productId), русское имя и категорию для нового, фасовку (countAs/pack).
 *   3. «Счетовод» — детерминированная арифметика в коде (baseLine + сверки): количество
 *                  в базовых единицах, цена за базовую, суммы строк, итоги, НДС. Модель
 *                  сюда не допускается: числа меняет только деньго-сохраняющая арифметика.
 *
 * Если суммы не бьются, «Чтец» получает точечный запрос на перечитывание (4-й проход),
 * но числа по-прежнему правит только код.
 */

export interface AgentFile {
  /** Имя файла в рабочей папке CLI. */
  name: string;
  mime: string;
  buf: Buffer;
}

/**
 * Поворот фото. Отдельный модельный проход пробовали — он стабильно съедал 30–120 с
 * (а на пакетах листов до двух минут) и почти всегда возвращал 0°: снимки этих телефонов
 * лежат пикселями ровно, хотя EXIF ставит orientation=6/8. Слепо доверять EXIF нельзя —
 * поворот по нему ломает ровный документ. Поэтому читаем как есть: «Чтец» умеет мысленно
 * развернуть лист, если тот лёг боком. Возвращает 0° для каждого файла (PDF — тоже 0).
 */
export async function detectRotationsAsync(
  list: { name: string; mime: string; buf: Buffer }[],
  _workDir: string,
  log: (kind: LogKind, text: string) => void
): Promise<number[]> {
  if (list.some((f) => f.mime.startsWith('image/'))) {
    log('stage', 'Ориентация: читаю фото как есть, без отдельного прохода');
  }
  return list.map(() => 0);
}

/**
 * Асинхронная подготовка файлов: выпрямляем по заранее определённому углу
 * (явный поворот отключает враньё EXIF) и ужимаем до читаемого размера.
 */
export async function prepareVisionFilesAsync(
  list: { name: string; mime: string; buf: Buffer }[],
  workDir: string,
  rotations?: number[]
): Promise<{ files: AgentFile[]; totalBytes: number }> {
  const files: AgentFile[] = [];
  let totalBytes = 0;
  for (let idx = 0; idx < list.length; idx++) {
    const f = list[idx];
    const isImage = f.mime.startsWith('image/');
    const name = list.length === 1 ? `invoice${isImage ? '.jpg' : '.pdf'}` : `invoice-${idx + 1}${isImage ? '.jpg' : '.pdf'}`;
    let buf = f.buf;
    if (isImage) {
      const rot = rotations?.[idx];
      try {
        buf = await sharp(f.buf)
          .rotate(Number.isFinite(rot) ? (rot as number) : 0) // без EXIF: угол уже вычислен
          // 2800px хватает, чтобы мелкий шрифт таблиц был читаем, а vision-префилл — быстрым
          .resize({ width: 2800, height: 2800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 92, mozjpeg: true })
          .toBuffer();
        // контраст и лёгкая резкость — мелкий шрифт таблиц читается заметно лучше
        buf = await sharp(buf)
          .normalize({ lower: 1, upper: 99 })
          .sharpen({ sigma: 0.7 })
          .jpeg({ quality: 92, mozjpeg: true })
          .toBuffer()
          .catch(() => buf);
      } catch {
        buf = f.buf;
      }
    }
    fs.writeFileSync(path.join(workDir, name), buf);
    files.push({ name, mime: isImage ? 'image/jpeg' : f.mime, buf });
    totalBytes += buf.length;
  }
  return { files, totalBytes };
}

/** Промпт агента «Чтец»: только чтение, без арифметики и без приведения к каталогу. */
export function readerPrompt(fileNames: string[]): string {
  const files = fileNames.map((n) => `«${n}»`).join(', ');
  return (
    `Ты — агент «Чтец» в CRM пищевого склада. В текущей папке лежат файлы накладной: ${files}. ` +
    `Прочитай их как ОДИН документ и перепиши данные ДОСЛОВНО. Ты не считаешь, не округляешь и не исправляешь цифры.\n\n` +
    `РЕЖИМ ОТВЕТА: не рассуждай вслух. Не пиши мысли, проверки и пояснения перед ответом — сразу заполняй формат ниже. ` +
    `Сомнение по ячейке отмечай "?" прямо в ней, не разбирай его текстом.\n\n` +
    `ВАЖНО ПРО ФОТО:\n` +
    `- Файлы уже выпрямлены системой: текст должен читаться нормально. Не пытайся поворачивать или пересохранять файл — просто читай.\n` +
    `- Если текст всё же стоит боком — мысленно разверни и читай дальше, не отказывайся от документа из-за поворота или качества.\n` +
    `- Прочитай ВСЮ таблицу от первой до последней строки, включая нижнюю половину листа. Не останавливайся на середине и не сокращай список.\n` +
    `- Несколько файлов — это одна накладная: листы продолжения и/или дубли одного листа. Склей строки без повторов.\n` +
    `- Если файл — НЕ товарный документ (экран компьютера, техника, упаковка, нечитаемое пятно), не выдумывай строки: ответь первой строкой "ТИП: НЕ НАКЛАДНАЯ" и коротко причину.\n\n` +
    `ФОРМАТ ОТВЕТА (строго текстом, без JSON и markdown):\n` +
    `ТИП: НАКЛАДНАЯ\n` +
    `ФОРМАТ: METRO | MONOLITH | OTPREMNICA | OTHER\n` +
    `НОМЕР: <номер документа>\n` +
    `ДАТА: <дата как напечатана или пусто>\n` +
    `ПОСТАВЩИК: <продавец из шапки/логотипа бланка; «Primaoc», «Kupac», «Покупатель» и MIX MARKT — это ПОЛУЧАТЕЛЬ (наш склад), НЕ поставщик; «Prevoznik» — перевозчик, тоже не поставщик>\n` +
    `ПОКУПАТЕЛЬ: <получатель/прималац>\n` +
    `PIB: <PIB продавца: 8-9 цифр; PIB из блока получателя (MIX MARKT) не бери; не уверен — пусто>\n` +
    `ВАЛЮТА: <RSD | EUR | ... ; если не напечатана — пусто>\n` +
    `СТРОКИ:\n` +
    `<название как напечатано> | <кол-во> | <единица> | <цена за единицу> | <PDV %> | <сумма без PDV> | <сумма с PDV> | <фасовка>\n` +
    `... по одной строке на товар\n` +
    `СКИДКИ:\n` +
    `<название скидки/акции> | <сумма> | <товар, если указан> | <учтена ли уже в суммах строк: да/нет/неясно>\n` +
    `ИТОГИ:\n` +
    `<все напечатанные итоги по отдельности: нетто без PDV, PDV, к оплате с PDV>\n\n` +
    `КАК ЗАПОЛНЯТЬ КОЛОНКИ:\n` +
    `- Кол-во/цена/суммы — строго как напечатано. Десятичная запятая так и остаётся запятой; разделители тысяч сохраняй.\n` +
    `- Единица — как в колонке: kg, g, l, ml, kom, kos, pcs, ut, Pack, Dose, KO и т.п.\n` +
    `- «Фасовка» — размер ОДНОЙ закупочной упаковки, если он есть в документе: значение колонки «Kol.po pak.» (METRO), ` +
    `вес из названия (397g, 1,5KG, 5KG), формат «30/1», «180/1», «6/1», «1/1KG». Если не напечатано — "-".\n` +
    `- Если колонки нет — ставь "-". Пустую ячейку не заполняй догадкой: лучше "-", чем выдуманное число.\n\n` +
    `ЧАСТЫЕ ФОРМАТЫ (узнавай по шапке и колонкам):\n` +
    `1) METRO Cash & Carry (Сербия): колонки Šifra | Naziv | Jed.mera | Kol.po pak. | Jedinična cena po pakovanju | Kol. | Iznos bez PDV | Iznos s PDV-om. ` +
    `Здесь «Kol.po pak.» — сколько единиц В ОДНОЙ упаковке (5KG, 30/1, 1), «Kol.» — сколько упаковок куплено, цена — за упаковку. ` +
    `Скидки идут отдельными строками «POPUST: … Kupi više, plati manje!» — это СКИДКИ, не товар: в строки товара не пиши, отдай в СКИДКИ. ` +
    `Фасовку бери из «Kol.po pak.» (5KG -> 5 kg; 30/1 -> 30 шт; 1 -> 1 шт).\n` +
    `2) Monolith Distribution (Германия/Сербия, EUR): поля Position | Artikelnr | Bezeichnung | MengeME | Einzelpreis | Gesamtpreis | Gewicht(kg). ` +
    `«MengeME» = количество с единицей (24.00 Dose, 54.0 Pack), «Einzelpreis» — цена за одну упаковку, «Gesamtpreis» — сумма строки. ` +
    `Название может быть длинным, часть по-немецки, часть по-русски — перепиши всё.\n` +
    `3) Обычная отпремница: № | Назив | ЈМ | Количина | Цена | Стопа PDV-а % | Износ PDV-а | Укупно цена са PDV-ом. ` +
    `Сумма без PDV = Количина × Цена (эту арифметику можешь указать в колонке суммы, но сами числа не меняй); сумма с PDV — из последней колонки.\n` +
    `4) Прочие поставщики: ищи колонки «количество, цена, сумма, НДС/PDV»; порядок колонок может отличаться — читай по заголовкам.\n\n` +
    `ЖЕЛЕЗНЫЕ ПРАВИЛА:\n` +
    `- Никаких арифметических проверок и «исправлений очевидных опечаток»: переписывай посимвольно.\n` +
    `- Все товарные строки, даже если название обрезано/мелкое — лучше пометить "?" в сомнительной ячейке, чем пропустить строку.\n` +
    `- Итоговые строки (Ukupno/Sveukupno/Ukupan iznos/Suma/Za plaćanje/PDV/Porez) не включай в СТРОКИ — только в ИТОГИ.\n` +
    `- Доставку, возврат, тару, услуги — в СКИДКИ с пометкой "служебная", в товар не пиши.\n`
  );
}

const STRUCTURE_RULES =
  `Ты — агент «Товаровед» пищевого склада. На вход — транскрипция накладной от агента «Чтец». ` +
  `Твоя задача: превратить её в строгий JSON для склада и УЗНАТЬ существующие товары по смыслу, ` +
  `даже если они называются на другом языке (сербский/немецкий/английский/русский), с брендами и сортами. ` +
  `Числа ты НЕ МЕНЯЕШЬ: qty/price/lineSum — строго как в транскрипции. Отвечаешь только JSON без markdown.\n` +
  `Не рассуждай вслух и не пересказывай транскрипцию: сразу выдай готовый JSON.\n\n`;

const PACK_RULES =
  `ЧТО ЗНАЧИТ «ШТУКА» В НАКЛАДНОЙ (решает фасовку):\n` +
  `- kom/kos/pcs/шт/ut/Pack/Dose/KO — это ОДНА закупочная упаковка (пакет, бутылка, коробка, банка), а не всегда 1 предмет.\n` +
  `- Размер упаковки ищи: 1) в колонке «Kol.po pak.» (METRO) или «фасовка»; 2) в названии («KONDENSMILCH 397g», «SOK 1L», «JAJA 30/1», «5KG ŠARGAREPA»); ` +
  `3) в весе упаковки (Gewicht(kg) на упаковку).\n` +
  `- countAs="contents", packQty=<размер>, packUnit=<единица>, baseUnit=<г|мл|шт> — если товар приходит упаковками и его реально кладут весом/объёмом/штуками содержимого. ` +
  `Примеры: 48 × «1L MLEKO» -> packQty=1, packUnit="l", baseUnit="мл"; 7 × «1.5KG KIKIR» -> 1.5 kg, baseUnit="г"; ` +
  `4 × «JAJA 30/1» -> packQty=30, packUnit="kom", baseUnit="шт"; 2 × «5KG ŠARGAREPA» -> 5 kg, baseUnit="г".\n` +
  `- countAs="pieces" — когда упаковка и есть складская единица: яйцо поштучно без фасовки, пучок, штучный предмет, а также весовая строка, где Кол уже в kg/g/l/ml (перевод в г/мл сделает система).\n` +
  `- Весовую строку (Кол=25 kg) НЕ считай содержимым: countAs="pieces", packQty=null.\n` +
  `- Не выдумывай фасовку. Нет доказательства — countAs=null и doubt.\n`;

export interface StructureInput {
  transcript: string;
  catalog: CatalogProduct[];
  categories: string[];
  unitCodes: string[];
}

export function structurerPrompt(input: StructureInput): string {
  const catalog = input.catalog.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    unit: p.unitCode,
    aliases: p.aliases,
  }));
  return (
    STRUCTURE_RULES +
    `Верни JSON ровно такой формы:\n` +
    `{"number":string|null,"supplier":string|null,"date":"YYYY-MM-DD"|null,"supplierPib":string|null,"currency":string|null,` +
    `"totalSum":number|null,"totalVat":number|null,"totalGross":number|null,` +
    `"docFormat":"metro|monolith|otpremnica|other",` +
    `"items":[{"name":"как напечатано","productId":int|null,"candidates":[int],"qty":number|null,"unitCode":string|null,` +
    `"price":number|null,"vatRate":number|null,"lineSum":number|null,"countAs":"contents"|"pieces"|null,` +
    `"packQty":number|null,"packUnit":string|null,"baseUnit":"г"|"мл"|"шт"|null,` +
    `"newHint":{"name":string,"category":string}|null,"doubt":string|null}],` +
    `"discounts":{"total":number|null,"items":[{"name":string,"amount":number|null,"productName":string|null,"percent":number|null,` +
    `"kind":"line|percent|promotion|unknown","includedInLineSum":boolean|null}]}}\n\n` +
    `КАТАЛОГ СКЛАДА (JSON, id/name/category/unit/aliases): ${JSON.stringify(catalog)}\n` +
    `КАТЕГОРИИ ДЛЯ НОВЫХ ТОВАРОВ (выбирай строго из списка): ${input.categories.join(' | ')}\n` +
    `БАЗОВЫЕ ЕДИНИЦЫ СКЛАДА: ${input.unitCodes.join(', ')}\n\n` +
    `ПРАВИЛА ПО ТОВАРУ И СОПОСТАВЛЕНИЮ:\n` +
    `- productId — id из каталога, если это ТОТ ЖЕ товар, даже с другим сортом/брендом/языком/сокращением. ` +
    `Примеры: «Krompir»/«Kartoffel»/«Potato» -> картофель; «Luk crni»/«Zwiebel» -> лук репчатый; «Mleko 2.8%»/«Milch» -> молоко; ` +
    `«Geb. Kondensmilch» -> сгущённое молоко; «Jogurt» -> йогурт натуральный; «Jaja 30/1» -> яйца куриные; «TOMATO P» (паста) -> томатная паста; ` +
    `«Masline» -> оливки консервированные; «Biber crni zrno» — чёрный перец Горошком (не молотый!); «Krastavac» свежий — огурцы свежие (не солёные!). ` +
    `Сверяйся с aliases. Сомневаешься между двумя — productId=null, оба id в candidates, поясни в doubt.\n` +
    `- Товара нет в каталоге — productId=null, newHint={name: НЕЙТРАЛЬНОЕ РУССКОЕ СКЛАДСКОЕ ИМЯ без бренда и размера, category: из КАТЕГОРИЙ}. ` +
    `Например «MC KIKIR.SEĆERAC 1.5KG» -> {name:"арахис", category:"бакалея"}; «PIKVA PILEĆA KORAŠI» -> {name:"тыква", category:"овощи"}; ` +
    `«Salata Gosnji dvor» -> {name:"салат Госни двор", category:"консервы"}. Если и категория неясна — category:"прочее" не бывает: выбери ближайшую из списка.\n` +
    `- candidates — до 4 id из каталога, которые похожи по смыслу/звучанию (даже если не уверен). Иначе [].\n` +
    `- НЕ считай товаром строки скидок/промо (POPUST, Kupi više plati manje, Akcija, Gratis, Bonus, Poklon), ` +
    `доставку/возврат/тару/услуги и итоги (Ukupno, Sveukupno, Vrednost, Osnova, PDV, Porez, Za plaćanje). ` +
    `Скидки — в discounts, всё остальное не выводи.\n\n` +
    PACK_RULES +
    `\nПРАВИЛА ПО ЧИСЛАМ:\n` +
    `- qty, unitCode, price, lineSum — как в транскрипции; десятичную запятую переведи в точку (1.055,00 -> 1055.00).\n` +
    `- METRO: qty = «Kol.» (число упаковок), price = «цena po pakovanju», lineSum = «Iznos bez PDV», фасовка — из «Kol.po pak.». ` +
    `Весовая строка с единицей kg (Krompir 25 kg) — qty=25, unitCode="kg" (это не упаковки).\n` +
    `- Monolith: qty = MengeME, price = Einzelpreis, lineSum = Gesamtpreis.\n` +
    `- Отпремница: qty = Количина, price = Цена, lineSum = сумма без PDV (Количина×Цена); НЕ бери сумму с PDV как lineSum.\n` +
    `- vatRate — ставка PDV строки в процентах (5/10/20). Если в строках нет колонки, но есть итог PDV и итог нетто — ` +
    `выведи единую ставку арифметикой и поставь vatInferred=true. Нет данных — null.\n` +
    `- totalSum — итог БЕЗ PDV; totalGross — к оплате с PDV; чего нет — null. ` +
    `totalVat — ТОЛЬКО если в документе напечатана отдельная строка PDV/Porez; если её нет — null, не вычисляй разницей. currency — RSD/EUR.\n` +
    `- date — YYYY-MM-DD. supplierPib — только цифры (8-9). supplier — продавец из шапки. ` +
    `Если транскрипция называет поставщиком MIX MARKT (или просто переписала блок «Primaoc/Kupac») — ` +
    `это наш склад-получатель, а не продавец: supplier=null, не подставляй его.\n` +
    `- Если транскрипция говорит «НЕ НАКЛАДНАЯ» — верни items:[], в каждом итоге null и discounts {total:0,items:[]}.\n\n` +
    `ТРАНСКРИПЦИЯ НАКЛАДНОЙ:\n${input.transcript}`
  );
}

export interface AgentItem {
  name: string;
  productId: number | null;
  candidates: number[];
  qty: number | null;
  unitCode: string | null;
  price: number | null;
  vatRate: number | null;
  vatInferred?: boolean;
  lineSum: number | null;
  countAs: 'contents' | 'pieces' | null;
  packQty: number | null;
  packUnit: string | null;
  baseUnit: string | null;
  newHint: { name: string; category: string } | null;
  doubt: string | null;
}

export interface AgentDoc {
  number: string | null;
  supplier: string | null;
  date: string | null;
  supplierPib: string | null;
  currency: string | null;
  totalSum: number | null;
  totalVat: number | null;
  totalGross: number | null;
  docFormat?: string | null;
  items: AgentItem[];
  discounts?: {
    total: number | null;
    items: {
      name: string;
      amount: number | null;
      productName?: string | null;
      percent?: number | null;
      kind?: string;
      includedInLineSum?: boolean | null;
    }[];
  };
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'string' ? v.replace(/\s/g, '').replace(',', '.') : v);
  return Number.isFinite(n) ? n : null;
};
const textOrNull = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
};

/** Нормализация ответа «Товароведа» (защита от мусора/строк вместо чисел). */
export function cleanAgentDoc(raw: Record<string, unknown>): AgentDoc {
  const itemsRaw = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  const doc: AgentDoc = {
    number: textOrNull(raw.number),
    supplier: textOrNull(raw.supplier),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? '')) ? String(raw.date) : null,
    supplierPib: textOrNull(raw.supplierPib)?.replace(/[^0-9]/g, '') || null,
    currency: textOrNull(raw.currency)?.toUpperCase().slice(0, 3) ?? null,
    totalSum: numOrNull(raw.totalSum),
    totalVat: numOrNull(raw.totalVat),
    totalGross: numOrNull(raw.totalGross),
    docFormat: textOrNull(raw.docFormat),
    items: itemsRaw
      .filter((it) => textOrNull(it?.name))
      .map((it) => ({
        name: String(it.name).trim().slice(0, 300),
        productId: typeof it.productId === 'number' ? it.productId : null,
        candidates: Array.isArray(it.candidates) ? it.candidates.filter((x) => typeof x === 'number') : [],
        qty: numOrNull(it.qty),
        unitCode: textOrNull(it.unitCode),
        price: numOrNull(it.price),
        vatRate: numOrNull(it.vatRate),
        vatInferred: it.vatInferred === true,
        lineSum: numOrNull(it.lineSum),
        countAs: it.countAs === 'contents' || it.countAs === 'pieces' ? it.countAs : null,
        packQty: numOrNull(it.packQty),
        packUnit: textOrNull(it.packUnit),
        baseUnit: textOrNull(it.baseUnit),
        newHint:
          it.newHint && textOrNull((it.newHint as Record<string, unknown>).name)
            ? {
                name: String((it.newHint as Record<string, unknown>).name).trim().slice(0, 200),
                category: textOrNull((it.newHint as Record<string, unknown>).category) ?? 'прочее',
              }
            : null,
        doubt: textOrNull(it.doubt)?.slice(0, 400) ?? null,
      })),
  };
  const d = (raw.discounts ?? {}) as Record<string, unknown>;
  const dItems = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : [];
  doc.discounts = {
    total: numOrNull(d.total),
    items: dItems
      .filter((x) => textOrNull(x?.name) || numOrNull(x?.amount) != null)
      .map((x) => ({
        name: textOrNull(x.name) ?? 'скидка',
        amount: numOrNull(x.amount),
        productName: textOrNull(x.productName),
        percent: numOrNull(x.percent),
        kind: textOrNull(x.kind) ?? 'unknown',
        includedInLineSum: typeof x.includedInLineSum === 'boolean' ? x.includedInLineSum : null,
      })),
  };
  return doc;
}

/** Агент «Чтец»: vision-проход. */
export async function runReaderAgent(
  files: AgentFile[],
  workDir: string,
  log: (kind: LogKind, text: string) => void
): Promise<string> {
  log('stage', 'Агент «Чтец»: читаю документ по колонкам');
  // Thinking выключено: это переписывание документа, рассуждения только жгут минуты
  // (в логах модель по 30–60 с «думала» о том, чей PIB напечатан, вместо чтения таблицы).
  const { text, durationMs } = await runCliLogged(readerPrompt(files.map((f) => f.name)), workDir, log, {
    timeoutMs: 600000,
    extraArgs: ['--thinking', 'disabled'],
  });
  if (durationMs != null) log('stage', `Агент «Чтец» закончил за ${(durationMs / 1000).toFixed(1)} с`);
  let clean = text.trim();
  if (!clean) throw new ApiError(502, 'Агент «Чтец» не вернул текст документа');
  // Модель иногда добавляет рассуждения до ответа — оставляем блок, начинающийся с ТИП.
  const start = clean.search(/^ТИП\s*:/m);
  if (start > 0) clean = clean.slice(start).trim();
  return clean;
}

/** Агент «Товаровед»: текст -> JSON с сопоставлением каталогу. */
export async function runStructurerAgent(
  input: StructureInput,
  workDir: string,
  log: (kind: LogKind, text: string) => void
): Promise<AgentDoc> {
  log('stage', 'Агент «Товаровед»: определяю товары, фасовки и категории');
  const { text, durationMs } = await runCliLogged(structurerPrompt(input), workDir, log, {
    timeoutMs: 240000,
    extraArgs: ['--thinking', 'disabled'],
  });
  if (durationMs != null) log('stage', `Агент «Товаровед» закончил за ${(durationMs / 1000).toFixed(1)} с`);
  const raw = extractCliJson(text);
  return cleanAgentDoc(raw);
}

/**
 * Точечное перечитывание строк, у которых не сходится арифметика.
 * Возвращает исправления только для строк, где модель уверенно видит другую цифру.
 */
export async function runAuditReader(
  files: AgentFile[],
  asked: string,
  workDir: string,
  log: (kind: LogKind, text: string) => void
): Promise<Record<string, unknown> | null> {
  const fileList = files.map((f) => `«${f.name}»`).join(', ');
  log('stage', 'Счетовод: суммы расходятся — прошу «Чтеца» перечитать спорные строки');
  const prompt =
    `Ты — агент «Чтец», сверочный проход. В папке: ${fileList}. ` +
    `Перечитай с фото ТОЛЬКО эти строки и верни цифры посимвольно, колонка за колонкой.\n${asked}\n` +
    `Ответ строго JSON: {"lines":[{"name":"название как напечатано","qty":number|null,"unitCode":string|null,` +
    `"price":number|null,"lineSum":number|null,"vatRate":number|null,"pack":"фасовка как напечатана"}]}. ` +
    `Ничего не вычисляй и не подгоняй под итог; не уверен — null.`;
  try {
    const { text } = await runCliLogged(prompt, workDir, log, {
      timeoutMs: 120000,
      extraArgs: ['--thinking', 'disabled'],
    });
    return extractCliJson(text);
  } catch {
    return null;
  }
}
