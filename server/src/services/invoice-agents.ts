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
 *   1. «Распознавание» — vision: переписывает документ дословно по колонкам, с учётом поворота
 *                  и формата (METRO / Monolith / обычная отпремница). Ничего не считает.
 *   2. «Каталог»     — текст: по транскрипции и каталогу склада определяет существующий товар
 *                  (productId), русское имя и категорию для нового, фасовку (countAs/pack).
 *   3. «Сверка»      — детерминированная арифметика в коде (baseLine + сверки): количество
 *                  в базовых единицах, цена за базовую, суммы строк, итоги, НДС. Модель
 *                  сюда не допускается: числа меняет только деньго-сохраняющая арифметика.
 *   4. «Контроль»    — детерминированная проверка сопоставлений: снимает чужие подсказки
 *                  и избыточные сомнения, когда словарь/каталог уверенно узнали товар.
 *
 * Если суммы не бьются, «Распознавание» получает точечный запрос на перечитывание,
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
 * поворот по нему ломает ровный документ. Поэтому читаем как есть: «Распознавание» умеет мысленно
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
 * (явный поворот отключает враньё EXIF), обрезаем фон до листа и режем высокий лист
 * на две перекрывающиеся половины — мелкий шрифт нижней части таблицы читается вдвое
 * крупнее, и «Распознавание» перестаёт съезжать на соседние строки.
 */
export async function prepareVisionFilesAsync(
  list: { name: string; mime: string; buf: Buffer }[],
  workDir: string,
  rotations?: number[]
): Promise<{ files: AgentFile[]; totalBytes: number }> {
  const files: AgentFile[] = [];
  let totalBytes = 0;
  let partNo = 0;
  for (let idx = 0; idx < list.length; idx++) {
    const f = list[idx];
    const isImage = f.mime.startsWith('image/');
    if (!isImage) {
      const name = list.length === 1 ? 'invoice.pdf' : `invoice-${idx + 1}.pdf`;
      fs.writeFileSync(path.join(workDir, name), f.buf);
      files.push({ name, mime: f.mime, buf: f.buf });
      totalBytes += f.buf.length;
      continue;
    }
    const rot = rotations?.[idx];
    let parts: Buffer[] = [];
    try {
      const rotated = await sharp(f.buf)
        .rotate(Number.isFinite(rot) ? (rot as number) : 0) // без EXIF: угол уже вычислен
        .jpeg({ quality: 95, mozjpeg: true })
        .toBuffer();
      const box = await detectPaperBox(rotated).catch(() => null);
      const sheet = box ? await sharp(rotated).extract(box).toBuffer() : rotated;
      const meta = await sharp(sheet).metadata();
      const sw = meta.width ?? 0;
      const sh = meta.height ?? 0;
      // A4-фото с плотной таблицей режем на 4 полосы с перекрытием: «Распознавание» видит 5–7 строк
      // и не путает числа соседних строк. Перекрытие 5 % — строки на стыках склеиваются
      if (sh > 1500 && sw > 1200) {
        const bands = 4;
        const overlap = Math.round(sh * 0.05);
        const bandH = Math.ceil(sh / bands) + overlap;
        const step = Math.floor(sh / bands);
        for (let p = 0; p < bands; p++) {
          const top = Math.max(0, Math.min(p * step, sh - bandH));
          const height = Math.min(bandH, sh - top);
          parts.push(await sharp(sheet).extract({ left: 0, top, width: sw, height }).toBuffer());
        }
      } else {
        parts = [sheet];
      }
    } catch {
      parts = [f.buf];
    }
    for (const part of parts) {
      let buf = part;
      try {
        buf = await sharp(buf)
          // 3600px: таблицы с 11 колонками читаются заметно точнее, префилл всё ещё приемлем
          .resize({ width: 3600, height: 3600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 92, mozjpeg: true })
          .toBuffer();
        // контраст и лёгкая резкость — мелкий шрифт таблиц читается заметно лучше
        buf = await sharp(buf)
          .normalize({ lower: 1, upper: 99 })
          .sharpen({ sigma: 0.7 })
          .jpeg({ quality: 92, mozjpeg: true })
          .toBuffer()
          .catch(() => buf);
      } catch { /* оставляем как есть */ }
      const name = parts.length === 1 && list.length === 1 ? 'invoice.jpg' : `invoice-${idx + 1}-${partNo + 1}.jpg`;
      fs.writeFileSync(path.join(workDir, name), buf);
      files.push({ name, mime: 'image/jpeg', buf });
      totalBytes += buf.length;
      partNo++;
    }
  }
  return { files, totalBytes };
}

/**
 * Границы светлого листа на фото (Otsu по яркости). Нужны, чтобы убрать фон и не тратить
 * разрешение на стол: тогда мелкий шрифт таблицы остаётся крупным. Не уверены — null.
 */
async function detectPaperBox(buf: Buffer): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const meta = await sharp(buf).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return null;
  const small = await sharp(buf).resize({ width: 300 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = small;
  const total = info.width * info.height;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  // лист светлее фона: порог Otsu + запас, но в разумных пределах
  const thr = Math.max(110, Math.min(205, best + 12));
  let minX = info.width;
  let minY = info.height;
  let maxX = 0;
  let maxY = 0;
  let cnt = 0;
  for (let y = 0; y < info.height; y++) {
    const row = y * info.width;
    for (let x = 0; x < info.width; x++) {
      if (data[row + x] >= thr) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        cnt++;
      }
    }
  }
  if (cnt < total * 0.12) return null;
  const k = W / info.width;
  const padX = Math.round(W * 0.01);
  const padY = Math.round(H * 0.01);
  const left = Math.max(0, Math.floor(minX * k) - padX);
  const top = Math.max(0, Math.floor(minY * k) - padY);
  const right = Math.min(W, Math.ceil((maxX + 1) * k) + padX);
  const bottom = Math.min(H, Math.ceil((maxY + 1) * k) + padY);
  // страховка от ложного bbox: лист должен занимать заметную часть кадра
  if (right - left < W * 0.5 || bottom - top < H * 0.4) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Промпт агента «Распознавание»: только чтение, без арифметики и без приведения к каталогу. */
export function readerPrompt(fileNames: string[]): string {
  const files = fileNames.map((n) => `«${n}»`).join(', ');
  return (
    `Ты — агент «Распознавание» в CRM пищевого склада. В текущей папке лежат файлы накладной: ${files}. ` +
    `Прочитай их как ОДИН документ и перепиши данные ДОСЛОВНО. Ты не считаешь, не округляешь и не исправляешь цифры.\n\n` +
    `РЕЖИМ ОТВЕТА: не рассуждай вслух. Не пиши мысли, проверки и пояснения перед ответом — сразу заполняй формат ниже. ` +
    `Сомнение по ячейке отмечай "?" прямо в ней, не разбирай его текстом.\n\n` +
    `ВАЖНО ПРО ФОТО:\n` +
    `- Файлы уже выпрямлены системой: текст должен читаться нормально. Не пытайся поворачивать или пересохранять файл — просто читай.\n` +
    `- Если текст всё же стоит боком — мысленно разверни и читай дальше, не отказывайся от документа из-за поворота или качества.\n` +
    `- Прочитай ВСЮ таблицу от первой до последней строки, включая нижнюю половину листа. Не останавливайся на середине и не сокращай список.\n` +
    `- Несколько файлов — это одна накладная: листы продолжения и/или дубли одного листа. Склей строки без повторов. ` +
    `Если один лист разрезан на две части (таблица продолжается без шапки), вторая часть идёт сразу за первой: склей по порядку и убери строки, попавшие на перекрытие.\n` +
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
    `<название как напечатано> | <кол-во> | <единица> | <цена за единицу> | <PDV %> | <сумма без PDV> | <сумма с PDV> | <фасовка> | <шифра/артикул>\n` +
    `... по одной строке на товар\n` +
    `СКИДКИ:\n` +
    `<скидка: код и название> | <товар: название или шифра> | <сумма без PDV со знаком> | <сумма с PDV> | <ставка PDV, если видно> | <учтена в напечатанных итогах: да/нет/неясно>\n` +
    `ИТОГИ:\n` +
    `<все напечатанные итоги по отдельности: нетто без PDV, PDV, к оплате с PDV>\n\n` +
    `КАК ЗАПОЛНЯТЬ КОЛОНКИ:\n` +
    `- Кол-во/цена/суммы — строго как напечатано. Десятичная запятая так и остаётся запятой; разделители тысяч сохраняй.\n` +
    `- Единица — как в колонке: kg, g, l, ml, kom, kos, pcs, ut, Pack, Dose, KO и т.п.\n` +
    `- «Фасовка» — размер ОДНОЙ закупочной упаковки, если он есть в документе: значение колонки «Kol.po pak.» (METRO), ` +
    `вес из названия (397g, 1,5KG, 5KG), формат «30/1», «180/1», «6/1», «1/1KG». Если не напечатано — "-".\n` +
    `- Если колонки нет — ставь "-". Пустую ячейку не заполняй догадкой: лучше "-", чем выдуманное число.\n` +
    `- «Сумма с PDV» — только та цифра, что напечатана в колонке «Iznos s PDV-om». Не вычисляй её сам из нетто: ` +
    `выдуманная сумма ломает ставку. Не видно/не уверен — поставь «?». ` +
    `Отношение «с PDV / без PDV» и есть ставка: 1,10 -> 10 %, 1,20 -> 20 %. Не пиши ставку, если отношение не похоже на 1,1/1,2. ` +
    `Ставку не оставляй пустой, если читаются обе суммы строки: даже при неразборчивой колонке «A» отношение сумм даёт 10 или 20 %. ` +
    `У товарной строки «Сумма с PDV» ВСЕГДА положительна и больше нетто: отрицательное число в этой колонке — цифра соседней ` +
    `POPUST-строки, верни её туда, а сумму с PDV товара перечитай.\n` +
    `- Суммы скидок уже входят в напечатанные итоги: не прибавляй их к строкам товаров и не правь из-за них итоги.\n\n` +
    `ЧАСТЫЕ ФОРМАТЫ (узнавай по шапке и колонкам):\n` +
    `1) METRO OTPREMNICA (Сербия): M | Šifra | Naziv proizvoda | Jed.mer. | Jedinična cena | Kol.po pak. | Cena po pakovanju | Kol. | Iznos bez PDV | Iznos s PDV-om | A. ` +
    `Номер документа — ОДИН, из поля «Br.»/«Broj» рядом с OTPREMNICA. Если в углу напечатан второй номер (заказ/доставка/покупатель), ` +
    `не склеивай его с номером накладной и не переноси в ИТОГИ. ` +
    `«Jed.mer.» = KO (упаковка) или KG (весовой). ` +
    `Для KO: «Kol.» — число упаковок, «Cena po pakovanju» — цена за упаковку, сумма без PDV = Kol. × Cena po pakovanju. ` +
    `Для KG: «Jedinična cena» — цена за кг, «Kol.» — вес в кг (0,290), сумма без PDV = Kol. × Jedinična cena. ` +
    `Не путай две колонки: «Kol.po pak.» — это размер упаковки (0,220 / 5 / 30/1 / 1), а «Kol.» — число упаковок (1, 5, 6, 12). ` +
    `Число упаковок из «Kol.» обязательно попадает в блок строки в «КОЛ:», даже если оно маленькое или совпадает с 1. ` +
    `В KO-строке между ценой и суммой стоят ДВА маленьких числа: сначала «Kol.po pak.» (почти всегда 1), потом «Kol.» — оно стоит ` +
    `непосредственно перед «Iznos bez PDV» (например: 1083,33 | 1 | 1083,33 | 6 | 6499,98 — Kol. = 6). ` +
    `Строки POPUST не имеют количества: не сдвигай из-за них числа соседних строк и не приписывай соседям «Kol.» скидочной строки. ` +
    `Сумма без PDV = Kol. × Cena po pakovanju — проверяй делением: если 6499,98 / 1083,33 = 6, то Kol. = 6. ` +
    `«Iznos bez PDV» и «Iznos s PDV-om» — две последние числовые колонки строки, перед отметкой «A». ` +
    `Все колонки строки напечатаны на одной линии с названием: количество, цена, сумма без PDV и сумма с PDV относятся ТОЛЬКО ` +
    `к названию на этой же строке. Не сдвигай цифры на соседние строки — при мелком шрифте так легко «уехать», но это ошибка. ` +
    `Проверяй каждую строку арифметикой: Кол. × Cena po pakovanju (для KG — Kol.po pak. × Jedinična cena) = Iznos bez PDV, ` +
    `а Iznos s PDV-om = Iznos bez PDV × 1,10 или × 1,20. Не сошлось — перечитай цифры этой строки, а не бери соседние. ` +
    `Колонка «A»: «P»/«P*»/«10» может отмечать льготную ставку, пусто — 20 %; но ставку всегда проверяй по суммам: ` +
    `с PDV / без PDV ≈ 1,10 -> 10 %, ≈ 1,20 -> 20 %. Отношение не 1,1 и не 1,2 — ставку не пиши. ` +
    `Скидки — отдельные строки «POPUST: <код>: Kupi više, plati manje!»: это НЕ товар. ` +
    `У POPUST-строки НЕТ ни количества, ни единицы — только две суммы. Не сдвигай из-за неё числа следующих товаров ` +
    `вверх и не переноси суммы POPUST на соседний товар: каждая товарная строка сохраняет свои цифры и своё место. ` +
    `Сумма скидки ВСЕГДА отрицательная — напечатана со знаком «−» или чёрточкой после числа (860,04-). ` +
    `Если рядом с подписью POPUST или на соседней с ней физической строке стоят ПОЛОЖИТЕЛЬНЫЕ числа (цена, «1», «20», сумма) — ` +
    `это строка соседнего товара, а не скидка: не бери их в СКИДКИ и не делай из них отдельный товар. ` +
    `Подпись POPUST и её отрицательная сумма могут стоять на двух соседних физических строках (подпись сверху или снизу от цифр) — ` +
    `к скидке относи ТОЛЬКО цифры с минусом; всё положительное — соседний товар. ` +
    `На части бланков строка пропечатана дважды: рядом с чёткими тёмными цифрами видна БЛЕДНО-СЕРАЯ копия чисел соседней строки ` +
    `(обычно на строку выше). Бледные цифры не читай вообще — бери только чёткие тёмные числа на одной линии с названием. ` +
    `Положительное число рядом с подписью POPUST — это такая бледная копия или цифры соседнего товара, а не скидка. ` +
    `Отдавай их в СКИДКИ: товар — по шифре в начале POPUST-строки, обе суммы со знаком, ставку по отношению сумм, ` +
    `«учтена в напечатанных итогах: да». ` +
    `Если по одному товару несколько POPUST-строк (включая пару «−сумма» и «+та же сумма» — служебная арифметика акции), ` +
    `сложи их СО ЗНАКАМИ и отдай одной итоговой скидкой по модулю. ` +
    `Посчитай POPUST-строки на листе (обычно 1–5) и перечисли ВСЕ: пропущенная скидка ломает сверку с итогом. ` +
    `В СТРОКИ скидочную строку не пиши и к сумме товара её не прибавляй. ` +
    `Сверь чтение таблицы: Σ «Iznos bez PDV» всех товарных строк минус Σ модулей POPUST должна совпасть с напечатанным ` +
    `«Izn. bez PDV» в итогах (допуск ~1 динар). Не сошлось — виновата не цифра, а привязка: числа съехали на соседнюю ` +
    `строку из-за наклона фото. Найди строки, где название и суммы стоят на разных уровнях, и перечитай блок, ` +
    `пока каждой строке не встанут её собственные числа. ` +
    `Фасовку бери из «Kol.po pak.» для KO (5KG -> 5 kg; 30/1 -> 30 шт; 1 -> 1 шт); для KG — "-".\n` +
    `2) Monolith Distribution (Германия/Сербия, EUR): поля Position | Artikelnr | Bezeichnung | MengeME | Einzelpreis | Gesamtpreis | Gewicht(kg). ` +
    `«MengeME» = количество с единицей (24.00 Dose, 54.0 Pack), «Einzelpreis» — цена за одну упаковку, «Gesamtpreis» — сумма строки. ` +
    `Название может быть длинным, часть по-немецки, часть по-русски — перепиши всё.\n` +
    `3) Обычная отпремница: № | Назив | ЈМ | Количина | Цена | Стопа PDV-а % | Износ PDV-а | Укупно цена са PDV-ом. ` +
    `Сумма без PDV = Количина × Цена (эту арифметику можешь указать в колонке суммы, но сами числа не меняй); сумма с PDV — из последней колонки.\n` +
    `4) Прочие поставщики: ищи колонки «количество, цена, сумма, НДС/PDV»; порядок колонок может отличаться — читай по заголовкам.\n\n` +
    `ЖЕЛЕЗНЫЕ ПРАВИЛА:\n` +
    `- Никаких арифметических «исправлений» цифр: переписывай посимвольно. Арифметику применяй только для проверки ` +
    `привязки (Kol. × цена = сумма; Σ строк − скидки = итог) — если не сходится, меняй не цифру, а к какой строке она относится.\n` +
    `- Все товарные строки, даже если название обрезано/мелкое — лучше пометить "?" в сомнительной ячейке, чем пропустить строку.\n` +
    `- Итоговые строки (Ukupno/Sveukupno/Ukupan iznos/Suma/Za plaćanje/PDV/Porez) не включай в СТРОКИ — только в ИТОГИ.\n` +
    `- Доставку, возврат, тару, услуги — в СКИДКИ с пометкой "служебная", в товар не пиши.\n`
  );
}

const STRUCTURE_RULES =
  `Ты — агент «Каталог» пищевого склада. На вход — транскрипция накладной от агента «Распознавание». ` +
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
    `"items":[{"name":"как напечатано","supplierCode":string|null,"productId":int|null,"candidates":[int],"qty":number|null,"unitCode":string|null,` +
    `"price":number|null,"vatRate":number|null,"lineSum":number|null,"lineGross":number|null,"countAs":"contents"|"pieces"|null,` +
    `"packQty":number|null,"packUnit":string|null,"baseUnit":"г"|"мл"|"шт"|null,` +
    `"newHint":{"name":string,"category":string}|null,"doubt":string|null}],` +
    `"discounts":{"total":number|null,"items":[{"name":string,"amount":number|null,"amountGross":number|null,"productName":string|null,` +
    `"supplierCode":string|null,"percent":number|null,"vatRate":number|null,"kind":"line|percent|promotion|unknown","includedInLineSum":boolean|null}]}}\n\n` +
    `КАТАЛОГ СКЛАДА (JSON, id/name/category/unit/aliases): ${JSON.stringify(catalog)}\n` +
    `КАТЕГОРИИ ДЛЯ НОВЫХ ТОВАРОВ (выбирай строго из списка): ${input.categories.join(' | ')}\n` +
    `БАЗОВЫЕ ЕДИНИЦЫ СКЛАДА: ${input.unitCodes.join(', ')}\n\n` +
    `ПРАВИЛА ПО ТОВАРУ И СОПОСТАВЛЕНИЮ:\n` +
    `- productId — id из каталога, если это ТОТ ЖЕ товар, даже с другим сортом/брендом/языком/сокращением. ` +
    `Примеры: «Krompir»/«Kartoffel»/«Potato» -> картофель; «Luk crni»/«Zwiebel» -> лук репчатый; «Mleko 2.8%»/«Milch» -> молоко; ` +
    `«Geb. Kondensmilch» -> сгущённое молоко; «Jogurt» -> йогурт натуральный; «Jaja 30/1» -> яйца куриные; «TOMATO P» (паста) -> томатная паста; ` +
    `«Masline» -> оливки консервированные; «Biber crni zrno» — чёрный перец горошком (не молотый!); «Krastavac» свежий — огурцы свежие (не солёные!). ` +
    `Сербские термины не путай: «luk crni»/«crni luk»/«crveni luk» — репчатый (красный) лук, это НЕ чеснок; ` +
    `«beli luk»/«luk beli»/«cesnjak» — чеснок; «mladi luk» — зелёный лук. ` +
    `Сверяйся с aliases. Если словарь и каталог дают однозначный товар — заполняй productId, а doubt=null: не придумывай «а вдруг это…». ` +
    `Сомнение (doubt) уместно только при реальной неоднозначности, когда два РАЗНЫХ товара одинаково подходят: ` +
    `тогда productId=null, оба id в candidates, а в doubt — короткое понятное объяснение без id и служебных кодов.\n` +
    `- Товара нет в каталоге — productId=null, newHint={name: НЕЙТРАЛЬНОЕ РУССКОЕ СКЛАДСКОЕ ИМЯ без бренда и размера, category: из КАТЕГОРИЙ}. ` +
    `Например «MC KIKIR.SEĆERAC 1.5KG» -> {name:"арахис", category:"бакалея"}; «PIKVA PILEĆA KORAŠI» -> {name:"тыква", category:"овощи"}; ` +
    `«Salata Gosnji dvor» -> {name:"салат Госни двор", category:"консервы"}. Если и категория неясна — category:"прочее" не бывает: выбери ближайшую из списка.\n` +
    `- candidates — до 4 id товаров, которые могут быть ЭТОЙ ЖЕ позицией (тот же продукт/вид). ` +
    `Не предлагай соседний товар только из-за похожего слова: чеснок для лука, соль для сахара, молотый перец для горошка. ` +
    `Если productId уверенно определён — candidates: [].\n` +
    `- НЕ считай товаром строки скидок/промо (POPUST, Kupi više plati manje, Akcija, Gratis, Bonus, Poklon), ` +
    `доставку/возврат/тару/услуги и итоги (Ukupno, Sveukupno, Vrednost, Osnova, PDV, Porez, Za plaćanje). ` +
    `Скидки — в discounts, всё остальное не выводи.\n\n` +
    PACK_RULES +
    `\nПРАВИЛА ПО ЧИСЛАМ:\n` +
    `- Строка транскрипции: название | кол-во | ед | цена | PDV | без PDV | с PDV | фасовка | шифра. ` +
    `Кол-во — число упаковок (qty), фасовка — размер одной упаковки (packQty), не меняй их местами и не теряй кол-во.\n` +
    `- qty, unitCode, price, lineSum — как в транскрипции; десятичную запятую переведи в точку (1.055,00 -> 1055.00).\n` +
    `- METRO: qty = «Кол.» (число упаковок), price = «Цена», lineSum = «Без PDV», lineGross = «С PDV», supplierCode = «Шифра». ` +
    `Весовая строка с единицей kg (Krompir 25 kg) — qty=25, unitCode="kg" (это не упаковки). ` +
    `Все суммы строки относятся к названию на этой же строке: проверь qty×price=lineSum и lineGross/lineSum=1,10/1,20. ` +
    `Не сдвигай цифры на соседние строки — при мелком шрифте это самая частая и самая дорогая ошибка.\n` +
    `- Monolith: qty = MengeME, price = Einzelpreis, lineSum = Gesamtpreis.\n` +
    `- Отпремница: qty = Количина, price = Цена, lineSum = сумма без PDV (Количина×Цена); НЕ бери сумму с PDV как lineSum.\n` +
    `- lineGross — сумма строки С PDV, как напечатана в документе. Нет такой колонки — null.\n` +
    `- vatRate — ставка PDV строки: 1) печатная колонка ставки; 2) если её нет — по отношению lineGross/lineSum: ` +
    `1,10 -> 10, 1,20 -> 20, 1,05 -> 5 (допуск ±0,02); вывел арифметикой — vatInferred=true. Иначе null.\n` +
    `- totalSum — итог БЕЗ PDV; totalGross — к оплате с PDV; чего нет — null. ` +
    `totalVat — напечатанная отдельная строка PDV/Porez, если есть; если отдельной строки нет, но напечатаны оба итога ` +
    `(нетто и к оплате) — totalVat = totalGross − totalSum, это законный расчёт налога из документа. Совсем нет данных — null. currency — RSD/EUR.\n` +
    `- СКИДКИ. POPUST/акция отдельной строкой с отрицательной суммой — это скидка на товар с той же шифрой (шифра в начале строки). ` +
    `Если по одной шифре в транскрипции несколько POPUST-строк (включая пару «−сумма» и «+та же сумма» — служебная арифметика акции), ` +
    `сложи их СО ЗНАКАМИ и выведи ОДНУ скидку на этот товар по модулю. ` +
    `В discounts.items: amount — сумма БЕЗ PDV положительным числом (минус с бумаги не переноси), amountGross — сумма с PDV, ` +
    `productName — точное название товара этой шифры из СТРОКИ, supplierCode — шифра, vatRate — по отношению amountGross/amount, ` +
    `kind="promotion" для «Kupi više, plati manje». ` +
    `Сумма скидки НЕ МОЖЕТ равняться нетто другой товарной строки (или её сумме с PDV) — такие цифры принадлежат соседнему товару: ` +
    `тогда amount=null и doubt «в POPUST-строку попали цифры соседнего товара». ` +
    `includedInLineSum=false — скидка отдельной строкой, в сумму строки товара она не входит (но входит в итоги документа). ` +
    `Если в документе отдельной строки скидки нет — скидку не выдумывай. total — напечатанный итог скидок, иначе null.\n` +
    `- date — YYYY-MM-DD. supplierPib — только цифры (8-9). supplier — продавец из шапки. ` +
    `Если транскрипция называет поставщиком MIX MARKT (или просто переписала блок «Primaoc/Kupac») — ` +
    `это наш склад-получатель, а не продавец: supplier=null, не подставляй его.\n` +
    `- Если транскрипция говорит «НЕ НАКЛАДНАЯ» — верни items:[], в каждом итоге null и discounts {total:0,items:[]}.\n\n` +
    `ТРАНСКРИПЦИЯ НАКЛАДНОЙ:\n${input.transcript}`
  );
}

export interface AgentItem {
  name: string;
  supplierCode: string | null;
  productId: number | null;
  candidates: number[];
  qty: number | null;
  unitCode: string | null;
  price: number | null;
  vatRate: number | null;
  vatInferred?: boolean;
  lineSum: number | null;
  /** Напечатанная сумма строки С PDV — по ней проверяется/выводится ставка. */
  lineGross: number | null;
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
      amountGross?: number | null;
      productName?: string | null;
      supplierCode?: string | null;
      percent?: number | null;
      vatRate?: number | null;
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

/** Нормализация ответа «Каталога» (защита от мусора/строк вместо чисел). */
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
        supplierCode: textOrNull(it.supplierCode),
        productId: typeof it.productId === 'number' ? it.productId : null,
        candidates: Array.isArray(it.candidates) ? it.candidates.filter((x) => typeof x === 'number') : [],
        qty: numOrNull(it.qty),
        unitCode: textOrNull(it.unitCode),
        price: numOrNull(it.price),
        vatRate: numOrNull(it.vatRate),
        vatInferred: it.vatInferred === true,
        lineSum: numOrNull(it.lineSum),
        lineGross: numOrNull(it.lineGross),
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
        amountGross: numOrNull(x.amountGross),
        productName: textOrNull(x.productName),
        supplierCode: textOrNull(x.supplierCode),
        percent: numOrNull(x.percent),
        vatRate: numOrNull(x.vatRate),
        kind: textOrNull(x.kind) ?? 'unknown',
        includedInLineSum: typeof x.includedInLineSum === 'boolean' ? x.includedInLineSum : null,
      })),
  };
  return doc;
}

/** Агент «Распознавание»: vision-проход. */
export async function runReaderAgent(
  files: AgentFile[],
  workDir: string,
  log: (kind: LogKind, text: string) => void
): Promise<string> {
  log('stage', 'Агент «Распознавание»: читаю документ по колонкам');
  // Thinking выключено: это переписывание документа, рассуждения только жгут минуты
  // (в логах модель по 30–60 с «думала» о том, чей PIB напечатан, вместо чтения таблицы).
  const { text, durationMs } = await runCliLogged(readerPrompt(files.map((f) => f.name)), workDir, log, {
    timeoutMs: 600000,
    extraArgs: ['--thinking', 'disabled'],
  });
  if (durationMs != null) log('stage', `Агент «Распознавание» закончил за ${(durationMs / 1000).toFixed(1)} с`);
  let clean = text.trim();
  if (!clean) throw new ApiError(502, 'Агент «Распознавание» не вернул текст документа');
  // Модель иногда добавляет рассуждения до ответа — оставляем блок, начинающийся с ТИП.
  const start = clean.search(/^ТИП\s*:/m);
  if (start > 0) clean = clean.slice(start).trim();
  return clean;
}

/** Агент «Каталог»: текст -> JSON с сопоставлением каталогу. */
export async function runStructurerAgent(
  input: StructureInput,
  workDir: string,
  log: (kind: LogKind, text: string) => void
): Promise<AgentDoc> {
  log('stage', 'Агент «Каталог»: определяю товары, фасовки и категории');
  const { text, durationMs } = await runCliLogged(structurerPrompt(input), workDir, log, {
    timeoutMs: 240000,
    extraArgs: ['--thinking', 'disabled'],
  });
  if (durationMs != null) log('stage', `Агент «Каталог» закончил за ${(durationMs / 1000).toFixed(1)} с`);
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
  log('stage', 'Сверка: суммы расходятся — запускаю повторное распознавание спорных строк');
  const prompt =
    `Ты — агент «Распознавание», сверочный проход. В папке: ${fileList}. ` +
    `Перечитай с фото ТОЛЬКО эти строки и верни цифры посимвольно, колонка за колонкой.\n${asked}\n` +
    `Читай таблицу строго построчно сверху вниз. Строка POPUST (Kupi više, plati manje) своего количества не имеет: ` +
    `она не сдвигает соседние товары и её суммы не переходят к товару. Для товара сумма без PDV = Kol. × цена за упаковку.\n` +
    `Ответ строго JSON: {"lines":[{"name":"название как напечатано","qty":number|null,"unitCode":string|null,` +
    `"price":number|null,"lineSum":number|null,"lineGross":number|null,"vatRate":number|null,"pack":"фасовка как напечатана"}]}. ` +
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
