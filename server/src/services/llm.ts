import OpenAI from 'openai';
import sharp from 'sharp';
import { config } from '../config';
import { ApiError } from '../http';
import { createGptClient } from './gpt-transport';

/** Позиция каталога, которую видит модель. */
export interface CatalogProduct {
  id: number;
  name: string;
  category: string;
  unitCode: string;
  aliases: string[];
}

/** Одна распознанная строка документа (структурированный ответ модели). */
export interface LlmItem {
  name: string;
  productId: number | null;
  candidates: number[];
  qty: number | null;
  unitCode: string | null;
  price: number | null;
  /** Ставка PDV в % (5/10/20) из колонки «ПДВ»; null если без НДС. */
  vatRate: number | null;
  /** Ставка PDV прочитана неуверенно (несколько строк подходят под расхождение итогов) — проверить пользователю. */
  vatSuspect?: boolean;
  /** Ставку не напечатали в документе — вывели из итогов/смысла товара; пусть человек проверит. */
  vatInferred?: boolean;
  lineSum: number | null;
  newHint: { name: string; category: string } | null;
  /** Как позицию класть на склад: 'contents' — содержимым (г/мл), 'pieces' — штуками. Решает модель. */
  countAs: 'contents' | 'pieces' | null;
  /** Фасовка ОДНОЙ упаковки так, как она напечатана в названии/документе (250 из «250G»). */
  packQty: number | null;
  /** Единица фасовки как напечатана (g, kg, ml, l...). */
  packUnit: string | null;
  /** Базовая единица склада, которую модель считает правильной: г | мл | шт. */
  baseUnit: string | null;
  /** Коротко по-русски: почему строка сомнительная и что проверить. Подсвечиваем человеку. */
  doubt: string | null;
}

/** Одна скидка/акция из отдельного блока документа (не товарная строка). */
export interface LlmDiscount {
  name: string;
  /** Товар, к которому относится скидка, если связь однозначна. */
  productName: string | null;
  kind: 'line' | 'percent' | 'promotion' | 'unknown';
  /** Сумма скидки положительным числом в валюте документа; null — не напечатана/не вычислилась. */
  amount: number | null;
  percent: number | null;
  vatRate: number | null;
  /** true — скидка уже учтена в суммах строк; false — отдельная; null — не определить. */
  includedInLineSum: boolean | null;
  doubt: string | null;
}

export interface LlmDoc {
  number: string | null;
  supplier: string | null;
  date: string | null;
  /** PIB/ДАВ поставщика из шапки (9 цифр). */
  supplierPib: string | null;
  /** Код валюты: RSD, EUR... */
  currency: string | null;
  /** Итог без НДС («Вредност»/osnova). */
  totalSum: number | null;
  /** Сумма НДС из блока итогов («ПДВ»). */
  totalVat: number | null;
  /** Итог с НДС («Наплата»/за плаćanje). */
  totalGross: number | null;
  /** Скидки/акции отдельным блоком — промпт требует их всегда, включая {"total":0,"items":[]}. */
  discounts?: { total: number | null; items: LlmDiscount[]; doubt: string | null };
  items: LlmItem[];
}

const OCR_SYSTEM =
  'Ты — внимательный OCR товарных документов (накладные, отпремнице, УПД, ТОРГ-12) на любом языке. ' +
  'Ты ТОЛЬКО переписываешь то, что видно на изображении, дословно, ничего не исправляя и не придумывая.';

const STRUCTURE_SYSTEM =
  'Ты — бухгалтер-аналитик продовольственного склада. По транскрипции товарной накладной составляешь строгий JSON. ' +
  'Используешь ТОЛЬКО числа из транскрипции — не пересчитываешь и не додумываешь их. ' +
  'Единственные исключения, где ты должна рассуждать: вывести ставку PDV, если она не напечатана в документе, ' +
  'и понять фасовку из названия позиции (количество при этом остаётся напечатанным). Отвечаешь строго JSON без markdown.';

/**
 * Вводим модель в курс дела: что за документ и как в таких документах считают количество.
 * Решение «в чём класть позицию на склад» принимает модель — код только пересчитывает
 * количество/цену, чтобы денежная сумма строки не изменилась.
 */
const WAREHOUSE_BRIEF =
  `ЧТО ЗА ДОКУМЕНТ: приходная накладная (отпремница / отпремнаница / УПД) поставщика на ПРОИЗВОДСТВЕННЫЙ СКЛАД ` +
  `пищевого цеха и мини-маркета. Это НЕ продажа розничному покупателю: товар пойдёт в заготовку и в техкарты блюд, ` +
  `поэтому складу важны реальный ВЕС, ОБЪЁМ и число В ШТУКАХ содержимого, а не число коробок/упаковок.\n` +
  `ТОВАРЫ почти всегда продуктовые: овощи и фрукты (krompir/KROMPIR — картофель, luk — лук, šargarepa — морковь), ` +
  `зелень и сушёные травы (persun/першун — петрушка, mirođija — укроп, list lavrov — лавровый лист), специи, ` +
  `молочка (jogurt, kajgana, sir, pavlaka, putar/margarin), мясо и полуфабрикаты (burek, pita, ćevapi), ` +
  `бакалея (brašno, ulje, sirće, sos, kikiriki), напитки (sok, voda), яйцо, упаковка.\n` +
  `ЯЗЫКИ: сербский/хорватский латиницей с диакритикой (č ć š ž đ), иногда кириллица и английский транслит. ` +
  `То же самое изделие может быть названо по-разному — сверяйся с каталогом и его aliases.\n` +
  `ЕДИНИЦЫ В ДОКУМЕНТАХ: kg/KG/kil/kilo, g/G/gram/gr, l/L/lit, ml, a также kom / kos / komada / pcs / szt / шт / шт1 ` +
  `— это «штука», то есть ОДНА УПАКОВКА (пакет, бутылка, коробка, пучок, головка), des/десятка = 10 штук.\n` +
  `ГЛАВНОЕ ПРО ЭТИ «ШТУКИ»: размер упаковки чаще всего написан ВНУТРИ названия, а не в колонке единиц. ` +
  `«PERSUN PAKOVAN 250G» при Кол=4 kom — это 4 пакета по 250 г = 1000 г петрушки, а не 4 предмета. ` +
  `«LIST LAVROV 15g» при 1 kom — 15 г лаврового листа. «JOGURT 1.5KG 1%MM PET» — йогурт 1,5 кг в ПЭТ-бутылке, ` +
  `Кол=2 kom = 3000 г йогурта. «SOK NARANCA 1L», Кол=6 = 6000 мл сока.\n` +
  `Иногда фасовка в названии — только артикул/сорт («KRUPNJAK KG», «LUK CRNI KG», «KROMPIR CRVENI KG» — тут KG ` +
  `означает, что цена и количество уже в килограммах), а товар реально считают поштучно («LUK CRNI MLADI VEZA» — ` +
  `пучок, «JAJA KOM» — яйцо, «KACAKAJLJ 1/1KG» — головка сыра весом 1 кг).\n\n` +
  `КАК РЕШАТЬ ПО КАЖДОЙ СТРОКЕ (решаешь ТЫ, система только посчитает арифметику):\n` +
  `- qty/unitCode/price/lineSum всегда оставляй КАК НАПЕЧАТАНО — никогда не переводи кг в г и не меняй числа сам.\n` +
  `- countAs="contents" ВЕСОМ/ОБЪЁМОМ — сыпучие, зелень, соусы, напитки, масло, йогурт: packQty+packUnit = РАЗМЕР ОДНОЙ ` +
  `УПАКОВКИ как напечатан (250 + "G"; 1.5 + "kg"; 330 + "ml"), baseUnit='г'|'мл'.\n` +
  `- countAs="contents" В ШТУКАХ (мультиупаковка) — когда ОДНА закупочная единица (коробка/лоток/кейс) содержит N одинаковых ` +
  `счётных изделий: яйца «JAJA SVEŽA M 180/1» = 180 шт в коробке, «6/1» = 6 в упаковке, «100/1 kutija». Тогда packQty=N, ` +
  `packUnit — счётная единица содержимого ('kom'/'pcs'/'kos'), baseUnit='шт', а qty оставь КАК НАПЕЧАТАНО (число коробок, ` +
  `напр. 2): система сама перемножит коробки × N и поделит деньги строки на штуку (2×180=360 шт, цена за 1 шт). ` +
  `НЕ своди такую строку к «2 шт» и НЕ путай число упаковок с числом содержимого.\n` +
  `- countAs="pieces" — когда закупочная единица и есть одна складская: 1 предмет/пучок/банка/тара/головка, «JAJA KOM» (яйцо ` +
  `поштучно, фасовка не написана), а также обычная весовая строка (Кол уже в kg/g/l). baseUnit по смыслу ('шт' для предметов).\n` +
  `- Количество в колонке пустое/неразборчивое, а из названия ясна фасовка — ставь qty как видишь (обычно 1 упаковка) ` +
  `и countAs="contents" с packQty/packUnit: система посчитает содержимое.\n` +
  `- Если строка сомнительная — НЕ молчи: напиши doubt одной короткой фразой по-русски, что именно не так и что ` +
  `посмотреть на фото («название 250g, но Кол=4 kom — сверь, 4 пакета или 4 кг», «цена за кг или за упаковку?», ` +
  `«в каталоге эта позиция в штуках, а приходит граммами»). Такие строки человек получит подсвеченными.\n` +
  `\nУНИВЕРСАЛЬНЫЙ АНАЛИЗ ТОВАРА/ФАСОВКИ/ЕДИНИЦ (сжато, к каждой строке):\n` +
  `- Определи ФИЗИЧЕСКИЙ СМЫСЛ: отдельный предмет, сырьё по массе, жидкость по объёму, коробка/лоток/мешок/бутылка с ` +
  `N изделий внутри. «kom/komad» ≠ всегда 1 физическая штука: это может быть ящик, лоток или упаковка.\n` +
  `- Различай ТРИ единицы (могут не совпадать, к одной насильно не своди): закупочная (за что платишь в строке) · ` +
  `складская базовая (г/мл/шт, в чём хранишь) · единица техкарты (в чём расходуют).\n` +
  `- ИЕРАРХИЯ ДОКАЗАТЕЛЬСТВ: а) напечатанные количество/единица/цена/сумма; б) фасовка и baseUnit из каталога при ` +
  `совпадении товара; в) однозначное обозначение фасовки в названии («180/1», «500 g», «1/1kg»); г) физический смысл ` +
  `и торговая практика; д) правдоподобность цены. Нижестоящее НЕ отменяет вышестоящее; при противоречии — число не правь, пиши doubt.\n` +
  `- НЕ ИЗМЕНЯЙ ДАННЫЕ: qty/unitCode/price/lineSum — строго как напечатано. Свою гипотезу о фасовке выражай ТОЛЬКО через ` +
  `packQty/packUnit — перевод в складское количество делает система деньго-сохраняющей арифметикой. Не подгоняй числа под ` +
  `итог документа, остаток или рецептуру.\n` +
  `- ШТУКИ↔ГРАММЫ: массу одного предмета (массу яйца и т.п.) НЕ ВЫДУМЫВАЙ. Если товар приходит счётными штуками, а ` +
  `техкарта ест его в граммах — оставляй countAs в штуках ('шт') и НЕ переводи в граммы: пересчёт штук в массу возможен ` +
  `только по подтверждённому коэффициенту каталога (масса 1 шт), которого в документе нет. Оставшийся нестыкующийся ` +
  `размер единиц склада подсветит система — человек настроит коэффициент.\n` +
  `- Оценивай уверенность: фасовка явная/подтверждённая каталогом — заполняй packQty/packUnit; вероятная, но не доказанная — ` +
  `не выдавай за факт, ставь countAs=null + doubt и опиши, что подтвердить по фото. Не запускай пересчёт по одной догадке.\n`;

const TRANSCRIBE_TASK =
  'Полностью и точно транскрибируй документ в текст:\n' +
  'НОМЕР: <номер документа>\n' +
  'ДАТА: <дата в исходном виде>\n' +
  'ПОСТАВЩИК: <продавец/отправитель из шапки, НЕ перевозчик/превозник>\n' +
  'ПОКУПАТЕЛЬ: <получатель/прималац>\n' +
  'PIB: <ДАВ/PIB/Matični број поставщика — 8-9 цифр из его блока в шапке>\n' +
  'ВАЛЮТА: <RSD/₽/EUR... (напр. ДИН. = RSD)>\n' +
  'ТАБЛИЦА — каждая строка с новой строки, колонки через | :\n' +
  '<№>|<название как напечатано>|<количество>|<единица>|<цена за единицу>|<ставка PDV, напр. 5%/10% или пусто>|<сумма строки>\n' +
  'ИТОГИ: <все напечатанные итоги по отдельности, напр. Vrednost bez PDV=7.289,50; PDV=638,60; Za plaćanje/Naplata=7.928,10>\n' +
  'Документ может быть передан целиком и/или горизонтальными фрагментами-полосами с нахлёстом — транскрибируй его как ОДИН документ, не дублируя строки из зон нахлёста; цифры сверяй по полосам (они с увеличением).\n' +
  'НЕСКОЛЬКО файлов в запросе — это ОДИН документ: листы накладной (продолжение таблицы) и/или дубли фото одного листа с разных ракурсов. ' +
  'Слей их в одну транскрипцию: строки, видимые на нескольких фото/листах, пиши ОДИН раз (цифры бери с наиболее чёткого снимка), ' +
  'листы склеивай в непрерывную таблицу с сквозной нумерацией. В ИТОГАХ пиши только финальные итоги документа (с последнего листа), не промежуточные.\n' +
  'ГЛАВНОЕ ПРАВИЛО ЦИФР: переписывай каждое число ПОСИМВОЛЬНО с напечатанного, ДАЖЕ если количество × цена не совпадает с суммой строки — ' +
  'никаких арифметических проверок, округлений и «исправлений очевидных опечаток» на этапе транскрипции. ' +
  'Лучше «?», чем выдуманное число. Сохраняй разделители тысяч/десятичных дробей как напечатаны. Пустых строк не выдумывай.';

function structureTask(catalog: CatalogProduct[], unitCodes: string[], transcript: string): string {
  return (
    `Составь JSON вида\n` +
    `{"number":string|null,"supplier":string|null,"date":"YYYY-MM-DD"|null,"supplierPib":string|null,"currency":string|null,` +
    `"totalSum":number|null,"totalVat":number|null,"totalGross":number|null,` +
    `"items":[{"name":"дословно из транскрипции","productId":int|null,"candidates":[int],"qty":number|null,` +
    `"unitCode":string|null,"price":number|null,"vatRate":number|null,"vatInferred":boolean,"lineSum":number|null,` +
    `"countAs":"contents"|"pieces"|null,"packQty":number|null,"packUnit":string|null,"baseUnit":"г"|"мл"|"шт"|null,` +
    `"doubt":string|null,"newHint":{"name":string,"category":string}|null}]}\n\n` +
    `${WAREHOUSE_BRIEF}\n` +
    `КАТАЛОГ СКЛАДА (JSON): ${JSON.stringify(catalog)}\n` +
    `БАЗОВЫЕ ЕДИНИЦЫ СКЛАДА: ${unitCodes.join(', ')} — в них количество приведёт система; ты сама переводить числа НЕ должна.\n\n` +
    `Правила по числам и полям:\n` +
    `- Все числа бери СТРОГО из транскрипции: price — колонка «цена за единицу», lineSum — колонка «сумма строки». ` +
    `Для строк с запятой-десятичной (50,25 | 95,00 | 4.773,75) приведи к числу (50.25, 95, 4773.75). Не пересчитывай и не подменяй числа других строк.\n` +
    `- Проверка: qty*price ≈ lineSum. Если в транскрипции не сходится — оставь числа как в транскрипции, расхождение система заметит сама.\n` +
    `- Если цены за единицу в документе нет, а есть только сумма строки — price = lineSum/qty.\n` +
    `- vatRate — ставка PDV строки в процентах числом  из колонки «ПДВ» (% без символа).\n` +
    `- ЕСЛИ СТАВКА В СТРОКЕ НЕ НАПЕЧАТАНА (колонки ПДВ нет или ячейки пустые) — не оставляй null просто так, ВЫВЕДИ её сама по имеющимся в документе данным:\n` +
    `  1) есть итоги: ставка = (ПДВ из итогов − Σ НДС строк, где ставка прочитана) ÷ Σ сумм остальных строк × 100 (0 — если НДС в документе нет);\n` +
    `  2) сверься с «Наплата»: нетто + ПДВ должно равняться итогу к оплате;\n` +
    `  3) если итог ПДВ не читается — суди по товару (Сербия): 5% — продукты первой необходимости (условно: овощи, зелень, молоко, мясо, хлеб, масло), ` +
    `10% — остальные продукты и напитки, 20% — непродовольственное/упаковка.\n` +
    `  Выведенную ставку отдавай так: vatRate=число, vatInferred=true, и doubt одной фразой «ставка PDV не напечатана — вычислено X% по итогам документа». ` +
    `Для ставки, которую реально прочитал в колонке, vatInferred=false.\n` +
    `- totalSum — ИТОГ БЕЗ НДС из блока ИТОГИ (Vrednost/osnova bez PDV/Ukupno без НДС). totalVat — сумма НДС (PDV). totalGross — итог к оплате с НДС (Наплата/Za plaćanje). Если какой-то итог не напечатан — null.\n` +
    `- supplierPib — ДАВ/PIB поставщика (8-9 цифр) из строки PIB; без префиксов. currency — код валюты (RSD/EUR), если не указана — RSD.\n` +
    `- supplier — из строки ПОСТАВЩИК транскрипции (продавец), не перевозчик.\n` +
    `- name — ДОСЛОВНАЯ копия названия строки, с сортами/брендами/фасовкой; не сокращай и не приводи к каталогу — по нему система запоминает псевдонимы.\n` +
    `- productId — id товара из КАТАЛОГА, если это тот же товар, даже с другим сортом/брендом/языком ` +
    `("KROMPIR CRVENI KG" -> "Картофель", "LUK BELI OGULJENI" -> "Лук репчатый", "PERŠUN" -> "Укроп"). Сверяй и с aliases.\n` +
    `- Товара нет в каталоге — productId=null и newHint={name: нейтральное складское имя, category: из категорий каталога}.\n` +
    `- candidates — до 3 id самых похожих, иначе [].\n` +
    `- unitCode — ЕДИНИЦА КАК НАПЕЧАТАНО в колонке единиц (kg, kom, G...), даже если она странная; qty/price под неё не пересчитывай. ` +
    `В items НЕ включай пустые и НЕ-товарные строки: итоги (Укупно/Свеупкупно/Рекапитулација/Vrednost/Osnova/PDV/Pорез/«Наплата»/Za plaćanje), ` +
    `скидки/попуст (Popust/«POUPST: 503207: Kupi više, plati manje!»), промо/акции (Akcija/Bonus/Gratis/Poklon), доставку/возврат/служебные пометки. ` +
    `Товар — это строка с реальным наименованием позиции и количеством; всё перечисленное выше позицией не является.\n` +
    `- countAs/packQty/packUnit/baseUnit/doubt — твоё решение по смыслу строки (см. «КАК РЕШАТЬ ПО КАЖДОЙ СТРОКЕ» выше). ` +
    `Для обычных весовых строк (Кол уже в kg/g/l/ml) ставь countAs="pieces", baseUnit по единице строки, packQty=null — ` +
    `перевод в граммы система сделает сама. Сомневаешься — лучше countAs=null и doubt с вопросом, чем догадка.\n` +

    `ПРАВИЛА РАСПОЗНАВАНИЯ И УЧЁТА СКИДОК:\n` +
    `- Все скидки возвращай в отдельном блоке discounts. Не включай скидки, акции и промо-строки в items.\n` +
    `- discounts.items — список обнаруженных скидок и акций. Каждую скидку учитывай отдельной записью, если она явно присутствует в документе.\n` +
    `- discounts.total — общая сумма скидок, фактически подтверждённая документом. Это положительное число в валюте документа.\n` +
    `- Если сумма скидки явно напечатана, используй её, не пересчитывай по предположению.\n` +
    `- Если скидка указана процентом и известна однозначная база расчёта, вычисли сумму скидки. Если база неизвестна — amount=null, percent=прочитанный процент, добавь пояснение в doubt.\n` +
    `- Если скидка указана отдельной отрицательной строкой, верни amount как положительную величину скидки. Не добавляй эту строку в items.\n` +
    `- name — название скидки или акции дословно, насколько возможно.\n` +
    `- productName — название товара, к которому относится скидка, если связь однозначна; иначе null.\n` +
    `- kind="line" — отдельная строка скидки с суммой; "percent" — скидка с указанным процентом; "promotion" — акция, бонус или промо; "unknown" — тип скидки нельзя надёжно определить.\n` +
    `- vatRate — ставка PDV скидки, только если она указана или однозначно выводится из документа; иначе null.\n` +
    `- includedInLineSum=true, если скидка уже учтена в сумме товарной строки или цене; false, если скидка указана отдельно и не учтена в товарной сумме; null, если это невозможно определить.\n` +
    `- Не вычитай скидку повторно из price, lineSum, totalSum или totalGross. Сохраняй товарные значения согласно документу.\n` +
    `- Если скидка уже отражена в уменьшенной цене товара, но отдельная сумма скидки нигде не указана и её нельзя достоверно вычислить, не выдумывай сумму. Укажи discounts.total=null, если общую сумму скидок невозможно установить полностью.\n` +
    `- Если скидка указана отдельно, но неизвестно, учтена ли она в итогах документа, не делай предположений: includedInLineSum=null и объясни сомнение.\n` +
    `- Не считай обычные товарные строки скидками только потому, что их цена кажется низкой.\n` +
    `- Не считай бонусный товар денежной скидкой, если документ не указывает его денежную стоимость как скидку. Промо-строку можно записать в discounts.items с amount=null и kind="promotion".\n` +
    `- Если скидок нет, верни discounts={"total":0,"items":[],"doubt":null}.\n` +
    `- Если скидки обнаружены, но их общую сумму нельзя достоверно установить, верни discounts.total=null, а не 0. В discounts.doubt кратко объясни причину.\n` +
    `- Если все скидки распознаны, discounts.total должен равняться сумме amount всех отдельных скидок, для которых сумма известна. Если часть скидок неизвестна, не выдавай частичную сумму за общий итог: используй null и объясни причину.\n` +
    `\nТРАНСКРИПЦИЯ ДОКУМЕНТА:\n${transcript}`
  );
}

/** Один файл пакета (лист/фрагмент накладной). */
export interface LlmFile {
  mime: string;
  base64: string;
}

/**
 * Части vision-сообщения. Режим задаётся env LLM_IMAGE_MODE (server/.env):
 *  full   — только оригинал целиком;  strips — только полосы (по умолчанию);
 *  both   — оригинал целиком + полосы сверху (целостность страницы + читаемость цифр).
 * API масштабирует КАЖДОЕ изображение к короткой стороне ~768, поэтому полосы дают ~2x
 * эффективное разрешение шрифта — на целиком сжатом высоком фото модель путает цифры.
 * Полосование включаем только когда документ даёт один фото-лист: несколько листов
 * режем на полосы не надо — их и так достаточно, а число картинок в запросе ограничено.
 */
async function toVisionParts(files: LlmFile[]): Promise<OpenAI.ChatCompletionContentPart[]> {
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  const multi = files.length > 1;
  for (let fi = 0; fi < files.length; fi++) {
    const { mime, base64 } = files[fi];
    const full: OpenAI.ChatCompletionContentPart = {
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
    };
    if (multi) parts.push({ type: 'text', text: `Лист/фрагмент ${fi + 1} из ${files.length}:` });
    if (!mime.startsWith('image/')) {
      parts.push({
        type: 'file',
        file: { filename: `nakladnaya${fi + 1}.pdf`, file_data: `data:application/pdf;base64,${base64}` },
      });
      continue;
    }
    const mode = (process.env.LLM_IMAGE_MODE ?? 'strips').toLowerCase();
    if (mode === 'full' || files.length > 1) {
      parts.push(full);
      continue;
    }
    try {
      // обрезаем однотонные поля — полосы дают больше эффективных пикселей на текст
      let buf = Buffer.from(base64, 'base64');
      try {
        buf = await sharp(buf).trim({ threshold: 8 }).toBuffer();
      } catch { /* фон не однотонный — режем как есть */ }
      const meta = await sharp(buf).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (!w || h < w * 1.2) {
        parts.push(full); // квадратное/альбомное — одной картинкой лучше
        continue;
      }
      const n = Math.min(4, Math.max(2, Math.round(h / (w * 0.75))));
      const stripH = Math.ceil(h / n);
      const overlap = Math.round(stripH * 0.12);
      if (mode === 'both') {
        parts.push({ type: 'text', text: 'Оригинал целиком (общая структура страницы):' });
        parts.push(full);
        parts.push({ type: 'text', text: 'Тот же документ горизонтальными полосами с увеличением — ЦИФРЫ сверяй по ним:' });
      }
      for (let i = 0; i < n; i++) {
        const top = Math.max(0, i * stripH - (i > 0 ? overlap : 0));
        const bottom = Math.min(h, (i + 1) * stripH + (i < n - 1 ? overlap : 0));
        const slice = await sharp(buf).extract({ left: 0, top, width: w, height: bottom - top }).jpeg({ quality: 88 }).toBuffer();
        parts.push({ type: 'text', text: `Фрагмент ${i + 1}/${n} (сверху вниз):` });
        parts.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${slice.toString('base64')}`, detail: 'high' },
        });
      }
    } catch {
      parts.push(full); // sharp недоступен или фото странное — исходный вариант
    }
  }
  return parts;
}

/**
 * Нормализация названий строк для матчинга между проходами (diacritics, регистр, пунктуация).
 */
function normName(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/đ/g, 'dj')
    .replace(/š/g, 's')
    .replace(/[ćč]/g, 'c')
    .replace(/ž/g, 'z')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


/**
 * Задание сверочного перечитывания таблицы при расхождении
 * суммы строк с напечатанным итогом нетто.
 */
function verifyTask(
    rows: LlmDoc['items'],
    dNet: number,
    totalNet: number,
): string {
  const table = rows
      .map(
          (r, i) =>
              `${i + 1} | ${r.name} | qty=${r.qty ?? '?'} | price=${r.price ?? '?'} | PDV=${r.vatRate ?? '?'}% | сумма=${r.lineSum ?? '?'}`,
      )
      .join('\n');

  const d = Math.round(dNet * 100) / 100;
  const absD = Math.abs(d);

  return (
      `Σ сумм товарных строк расходится с напечатанным итогом нетто ${totalNet} din на ${d > 0 ? '+' : ''}${d} din.\n` +
      `${dNet > 0 ? 'Сумма строк меньше итога — возможно, пропущены строки или неверно прочитаны числа.' : 'Сумма строк больше итога — возможно, неверно прочитаны числа или скидка вычтена из итога отдельно.'}\n\n` +

      `ТАК ТАБЛИЦА БЫЛА ПРОЧИТАНА РАНЬШЕ:\n${table}\n\n` +

      `ЗАДАЧА:\n` +
      `Заново перечитай таблицу на изображении, построчно и посимвольно, по соответствующим колонкам. Используй увеличенные фрагменты таблицы, если они доступны.\n` +
      `Не доверяй предыдущему распознаванию автоматически: проверяй цифры по изображению.\n\n` +

      `ЧТО ИСКАТЬ:\n` +
      `- Пропущенные или перепутанные цифры в количестве, цене и сумме строки: 1↔7, 4↔7, потерянный ноль (700→70 или 00).\n` +
      `- Перепутанные колонки количества, цены за единицу и суммы строки.\n` +
      `- Пропущенные товарные строки, в том числе в середине или конце таблицы.\n` +
      `- Ошибочно распознанные номера строк, если по ним можно заметить пропуск позиции.\n` +
      `- Отдельные строки скидок, попустов и промоакций, которые могли быть ошибочно приняты за товарные строки или не учтены при сравнении итогов.\n\n` +

      `ПРАВИЛА ОБРАБОТКИ СКИДОК:\n` +
      `- Скидка не является товарной строкой. Не добавляй её в исправленные товарные строки.\n` +
      `- Проверь, не объясняется ли расхождение отдельной строкой скидки, попустом или промоакцией.\n` +
      `- Если скидка уже учтена в сумме товарной строки, не вычитай её повторно.\n` +
      `- Если скидка напечатана отдельно, не исправляй товарные суммы только ради совпадения с итогом нетто.\n` +
      `- Не вычисляй отсутствующую сумму скидки из разницы между итогом и суммой строк и не объявляй всю разницу скидкой без подтверждения на изображении.\n` +
      `- Если расхождение может быть вызвано скидкой, но это нельзя достоверно установить по изображению, оставь товарные строки без изменений, если в них не видна конкретная ошибка чтения.\n\n` +

      `ПРАВИЛА СВЕРКИ:\n` +
      `- Сравнивай именно суммы товарных строк с напечатанным итогом нетто, учитывая, что документ может содержать скидки, корректировки и другие отдельные строки.\n` +
      `- Не считай расхождение доказательством ошибки распознавания конкретной строки.\n` +
      `- Для каждой исправляемой строки qty × price должно соответствовать lineSum с учётом точности округления, используемой в документе.\n` +
      `- lineSum должен совпадать с суммой, фактически напечатанной в колонке «Vrednost» или соответствующей колонке суммы строки.\n` +
      `- Не рассчитывай lineSum из qty × price вместо чтения напечатанного значения.\n` +
      `- Если qty × price не совпадает с напечатанной суммой, проверь все три значения по изображению. Исправляй только те значения, для которых ошибка чтения визуально подтверждена.\n\n` +

      `ЕСЛИ СУММА СТРОК МЕНЬШЕ ИТОГА:\n` +
      `Расхождение составляет ${absD} din. Проверь, не пропущены ли целые товарные строки, особенно в конце и между соседними номерами строк. Проверь строки, которые могли быть не распознаны из-за мелкого текста или плохого качества изображения.\n` +
      `Не создавай пропущенные строки и не придумывай их значения. Если пропуск виден, но прочитать его содержание уверенно нельзя, не добавляй его в результат.\n\n` +

      `ЕСЛИ СУММА СТРОК БОЛЬШЕ ИТОГА:\n` +
      `Расхождение составляет ${absD} din. Проверь, не завышены ли цифры в суммах строк, не перепутаны ли количество и цена, не учтена ли скидка отдельно в итогах документа.\n` +
      `Не уменьшай суммы строк на величину расхождения без визуального подтверждения ошибки.\n\n` +

      `ГЛАВНОЕ ПРАВИЛО:\n` +
      `Запрещено изменять числа ради того, чтобы сумма строк совпала с итогом документа.\n` +
      `Если qty × price уже соответствует напечатанному lineSum, не меняй строку только потому, что общая сумма не сходится.\n` +
      `Если строка визуально прочитана правильно, оставь её без изменений, даже если расхождение сохраняется.\n` +
      `Возвращай только строки, в которых ты уверенно видишь ошибку распознавания на изображении. Не возвращай строки без изменений и не включай в результат предположения.\n\n` +

      `ФОРМАТ ОТВЕТА:\n` +
      `Верни только валидный JSON без Markdown и пояснений вне JSON.\n` +
      `Если уверенно ошибочных строк нет, верни {"lines":[]}.\n` +
      `JSON: {"lines":[{"name":"название дословно","qty":number,"price":number,"vatRate":number|null,"lineSum":number}]}\n`
  );
}


/** НДС строки по печатным правилам: сумма строки × ставка, округление до копейки (сотой dinara). */
function lineVat(sum: number, rate: number): number {
  return Math.round((sum * rate) / 100 * 100) / 100;
}

/** Вытащить JSON из ответа: режем markdown-обёртки ```json ... ``` если модель всё же их вернула. */
function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  return s >= 0 && e > s ? t.slice(s, e + 1) : t;
}

/**
 * Починить обрезанный/битый JSON: сканируем посимвольно (строки/escapes/глубина),
 * запоминаем точки, где JSON можно оборвать без потери предыдущих данных (после } ] и «,»),
 * и с конца пробуем: откат -> снять висящий «,{"key":» -> дослать закрытие скобок -> JSON.parse.
 * Теряем максимум полоследней записи, остальное спасаем целиком.
 */
function repairJson(text: string): string | null {
  const opens: string[] = [];
  const cands: { pos: number; stack: string[] }[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') {
      opens.push(c);
    } else if (c === '}' || c === ']') {
      const open = opens.pop();
      if (!open || (open === '{' ? c !== '}' : c !== ']')) return null; // настоящая рассогласованность — не чиним
      cands.push({ pos: i + 1, stack: [...opens] });
    } else if (c === ',') {
      cands.push({ pos: i, stack: [...opens] });
    }
  }
  if (!inStr && !opens.length) return null; // ничего не открыто и не оборвано — причина другая
  for (let k = cands.length - 1; k >= 0; k--) {
    const { pos, stack } = cands[k];
    let head = text.slice(0, pos);
    // висящий незакрытый «{»/«[» (с запятой или без) — последний оборванный элемент
    head = head.replace(/(?:,\s*)?(?:\{|\[)?\s*$/, (m) => (/[{[]|,\s*$/.test(m) ? '' : m));
    // висящие «"ключ":» в хвосте (в т.ч. несколько подряд) — обрывался на середине пары
    head = head.replace(/(?:\s*"[^"]*"\s*:\s*)+$/, '');
    const candidate = head + stack.slice().reverse().map((o) => (o === '{' ? '}' : ']')).join('');
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* пробуем точку отката раньше */
    }
  }
  return null;
}

/**
 * JSON-вызов с самовылечением cutoff: если ответ упёрся в лимит токенов
 * (finish_reason='length') или парсится криво — ретрай с удвоенным max_completion_tokens,
 * но если модель снова отдаёт тот же обрезанный текст (упёрлись в потолок вывода модели) —
 * не жжём токены, а чиним JSON структурно: досылаем закрытие скобок и теряем лишь полстрок.
 */
async function jsonChat(
  oa: OpenAI,
  req: { messages: OpenAI.ChatCompletionMessageParam[]; maxTokens: number; system: string; label: string }
): Promise<{ data: unknown; recovered: boolean }> {
  let limit = req.maxTokens;
  let lastErr = '';
  let lastText = '';
  for (let attempt = 0; attempt < 3 && limit <= 16000; attempt++, limit *= 2) {
    let text = '';
    let truncated = false;
    let apiErr = '';
    try {
      const r = await oa.chat.completions.create({
        model: config.openaiModel,
        response_format: { type: 'json_object' },
        max_completion_tokens: limit,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      });
      const choice = r.choices[0];
      text = choice?.message?.content ?? '';
      truncated = choice?.finish_reason === 'length';
    } catch (e) {
      // лимит токенов выше потолка модели — дальше дробить бессмысленно
      apiErr = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    if (!apiErr && !truncated) {
      try {
        return { data: JSON.parse(extractJson(text)), recovered: false };
      } catch {
        lastErr = 'ответ не парсится как JSON';
      }
    } else {
      lastErr = apiErr ? `ошибка API: ${apiErr}` : `ответ обрезан на лимите ${limit} токенов`;
    }
    // ретраить с бо́льшим лимитом есть смысл, пока текст стал длиннее предыдущего
    if (text.length <= lastText.length && lastText) {
      lastErr += ' (потолок вывода модели — повтор бы дал то же)';
      break;
    }
    lastText = text;
  }
  // спасение обрезанного/битого ответа: закрываем незакрытые скобки по структуре
  for (const candidate of [repairJson(lastText), extractJson(lastText)]) {
    if (!candidate) continue;
    try {
      return { data: JSON.parse(candidate), recovered: true };
    } catch {
      /* пробуем следующий способ */
    }
  }
  throw new ApiError(
    502,
    `GPT вернул не JSON (${lastErr}, документ скорее всего слишком длинный). Фрагмент: ${lastText.slice(0, 200)}`
  );
}

/** Задание для прицельного перечитывания строк, у которых не сходится сводка PDV. */
function recheckTask(names: string[], delta: number): string {
  const d = Math.round(delta * 100) / 100;
  return (
    `Сумма PDV по строкам не сходится с итогом PDV в документе (расхождение ${d > 0 ? '+' : ''}${d} din. — одна из строк напечатана с более высокой ставкой, чем показалось при первом чтении).\n` +
    `Перечитай с изображения ПОЗИЦИОННО, колонка за колонкой, эти строки: ${names.map((n) => `«${n}»`).join(', ')}\.\n` +
    `Для каждой строки выпиши цифры посимвольно в порядке колонок: № | название | JМ | Кол | Цена | ПДВ(%) | Вред.\n` +
    `Смотри на строки ВНИМАТЕЛЬНО, увеличивая взглядом именно эти ячейки. Пиши ТОЛЬКО то, что реально напечатано, даже если итоги не сходятся — «дотянуть» расхождение подбором ставки НЕЛЬЗЯ.\n` +
    `ПРОВЕРКА: Кол × Цена = Вред. Если 10×70=700 и 4×175=700 — оба варианта сходятся арифметически, значит ориентир — только то, что НАПИСАНО в колонках: целое число штук стоит в Кол, цена за единицу — в Цена.\n` +
    `Ответь строго JSON: {"lines":[{"name":"название дословно","qty":number,"price":number,"vatRate":number|null}]}`
  );
}

/**
 * Разбор пакета файлов одной накладной (листы/дубли фото — от 1 до 8):
 * 1) OCR-транскрипция всего пакета как одного документа, 2) структурирование по транскрипции,
 * 3) (при расхождении PDV) прицельное перечитывание suspect-строк с картинок.
 * Разделение проходов резко снижает числовые галлюцинации модели на таблицах.
 * Ключ — только серверный (config.openaiKey), во фронтенд не попадает.
 */
export async function parseWaybillDoc(opts: {
  files: LlmFile[];
  catalog: CatalogProduct[];
  unitCodes: string[];
}): Promise<{ doc: LlmDoc; model: string; transcript: string; corrections: string[] }> {
  if (!config.openaiKey) {
    throw new ApiError(501, 'OPENAI_API_KEY не задан в server/.env — импорт из файлов недоступен');
  }
  // транспорт выбирается настройкой «GPT через Tor» (страница «Настройки», только админ)
  const oa = await createGptClient();

  const files = opts.files ?? [];
  if (!files.length) throw new ApiError(400, 'Не передано ни одного файла');
  if (files.length > 8) throw new ApiError(400, 'Слишком много фото — не больше 8 на одну накладную');
  for (const f of files) {
    if (!f.mime.startsWith('image/') && f.mime !== 'application/pdf') {
      throw new ApiError(400, 'Поддерживаются изображения (png/jpg/webp/gif) и PDF');
    }
  }
  const hasImage = files.some((f) => f.mime.startsWith('image/'));
  const imageParts = await toVisionParts(files);
  const visionParts: OpenAI.ChatCompletionContentPart[] = [...imageParts, { type: 'text', text: TRANSCRIBE_TASK }];

  // проход 1: транскрипция (если обрезалась на лимите — повторяем с удвоенным)
  let transcript = '';
  {
    let limit = Number(process.env.LLM_TRANSCRIBE_MAX_TOKENS ?? 3000);
    for (let attempt = 0; attempt < 3 && limit <= 12000; attempt++, limit *= 2) {
      let res: { text: string; truncated: boolean } | null = null;
      try {
        const r1 = await oa.chat.completions.create({
          model: config.openaiModel,
          max_completion_tokens: limit,
          messages: [
            { role: 'system', content: OCR_SYSTEM },
            { role: 'user', content: visionParts },
          ],
        });
        const choice = r1.choices[0];
        res = { text: choice?.message?.content?.trim() ?? '', truncated: choice?.finish_reason === 'length' };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ApiError(502, `GPT не ответил: ${msg.slice(0, 300)}`);
      }
      if (!res.truncated || res.text.length > transcript.length) transcript = res.text;
      if (!res.truncated) break;
    }
  }
  if (!transcript) throw new ApiError(502, 'GPT не смог прочитать документ (пустая транскрипция)');

  // проход 2: структурирование по тексту (лимит с запасом + ретраи с удвоением при обрезке ответа)
  let doc: LlmDoc;
  let docRecovered = false;
  try {
    const r = await jsonChat(oa, {
      system: STRUCTURE_SYSTEM,
      label: 'структурирование',
      maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 8000),
      messages: [{ role: 'user', content: structureTask(opts.catalog, opts.unitCodes, transcript) }],
    });
    doc = r.data as LlmDoc;
    docRecovered = r.recovered;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, `GPT вернул не JSON: ${String(e).slice(0, 200)}`);
  }
  if (!Array.isArray(doc.items)) doc.items = [];
  const numOrNull = (x: unknown): number | null => (typeof x === 'number' && isFinite(x) ? x : null);
  doc.totalSum = numOrNull(doc.totalSum);
  doc.totalVat = numOrNull(doc.totalVat);
  doc.totalGross = numOrNull(doc.totalGross);
  doc.supplierPib = doc.supplierPib ? String(doc.supplierPib).replace(/[^0-9]/g, '') || null : null;
  doc.currency = doc.currency ? String(doc.currency).trim().toUpperCase().replace('ДИН.', 'RSD').replace('ЕВР', 'EUR').slice(0, 3) : null;
  // страховка от мусора в ответах модели
  doc.items = doc.items.map((it) => ({
    name: String(it?.name ?? '').trim(),
    productId: typeof it?.productId === 'number' ? it.productId : null,
    candidates: Array.isArray(it?.candidates) ? it.candidates.filter((x) => typeof x === 'number') : [],
    qty: typeof it?.qty === 'number' && it.qty > 0 ? it.qty : null,
    unitCode: it?.unitCode ? String(it.unitCode).trim().toLowerCase() : null,
    price: typeof it?.price === 'number' && it.price >= 0 ? it.price : null,
    vatRate: typeof it?.vatRate === 'number' && it.vatRate > 0 && it.vatRate <= 30 ? it.vatRate : null,
    vatInferred: it?.vatInferred === true,
    lineSum: typeof it?.lineSum === 'number' && it.lineSum >= 0 ? it.lineSum : null,
    newHint:
      it?.newHint && String(it.newHint.name ?? '').trim()
        ? { name: String(it.newHint.name).trim(), category: String(it.newHint.category ?? '').trim() || 'прочее' }
        : null,
    // решение модели «как считать позицию на склад» — числа при этом остаются печатными
    countAs: it?.countAs === 'contents' ? 'contents' : it?.countAs === 'pieces' ? 'pieces' : null,
    packQty: typeof it?.packQty === 'number' && it.packQty > 0 ? it.packQty : null,
    packUnit: it?.packUnit ? String(it.packUnit).trim().toLowerCase() : null,
    baseUnit: it?.baseUnit ? String(it.baseUnit).trim().toLowerCase() : null,
    doubt: it?.doubt && String(it.doubt).trim() ? String(it.doubt).trim().slice(0, 300) : null,
  }));

  // блок скидок: та же страховка от мусора, что и для items; цифры не трогаем — только типы и границы
  {
    const dk = (doc as { discounts?: unknown }).discounts as
      | { total?: unknown; items?: unknown; doubt?: unknown }
      | undefined;
    const boolOrNull = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
    const itemsRaw = Array.isArray(dk?.items) ? dk!.items : [];
    const itemsClean: LlmDiscount[] = itemsRaw.map((d: Record<string, unknown>) => ({
      name: String(d?.name ?? '').trim().slice(0, 200),
      productName: d?.productName ? String(d.productName).trim().slice(0, 200) : null,
      kind: (['line', 'percent', 'promotion'].includes(String(d?.kind)) ? String(d.kind) : 'unknown') as LlmDiscount['kind'],
      amount: typeof d?.amount === 'number' && isFinite(d.amount) ? Math.round(Math.abs(d.amount) * 100) / 100 : null,
      percent: typeof d?.percent === 'number' && d.percent > 0 && d.percent <= 100 ? d.percent : null,
      vatRate: typeof d?.vatRate === 'number' && d.vatRate >= 0 && d.vatRate <= 30 ? d.vatRate : null,
      includedInLineSum: boolOrNull(d?.includedInLineSum),
      doubt: d?.doubt && String(d.doubt).trim() ? String(d.doubt).trim().slice(0, 300) : null,
    }));
    doc.discounts = {
      total: typeof dk?.total === 'number' && isFinite(dk.total) ? Math.round(Math.abs(dk.total) * 100) / 100 : null,
      items: itemsClean,
      doubt: dk?.doubt && String(dk.doubt).trim() ? String(dk.doubt).trim().slice(0, 300) : null,
    };
  }

  // страховка на случай, если модель всё же продублировала строку со второго листа/дубля фото
  const corrections: string[] = [];
  // скидки — не позиции: сводку по блоку отдаём человеку так, как вывела модель (подсчёт и показ на фронте)
  {
    const dk = doc.discounts;
    if (dk && dk.items.length) {
      const known = dk.items.reduce((s, x) => s + (x.amount ?? 0), 0);
      corrections.push(
        dk.total != null
          ? `Скидки/акции отдельным блоком: ${dk.items.length}, сумма скидок ${Math.round(dk.total * 100) / 100}`
          : `Скидок/акций: ${dk.items.length}, их общую сумму документ однозначнo не даёт${dk.doubt ? ` — ${dk.doubt}` : ''} (известные суммы: ${Math.round(known * 100) / 100})`
      );
    } else if (dk && dk.total == null && dk.doubt) {
      corrections.push(`Скидки: ${dk.doubt}`);
    }
  }
  {
    const seen = new Set<string>();
    const uniq = doc.items.filter((it) => {
      const k = `${normName(it.name)}|${it.qty ?? ''}|${it.price ?? ''}|${it.lineSum ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (uniq.length !== doc.items.length) {
      corrections.push(`Убрано дублей строк между листами/фото: ${doc.items.length - uniq.length}`);
      doc.items = uniq;
    }
  }

  // проход 3: сверочные перечитывания с картинки по контрольным суммам документа
  if (docRecovered) {
    corrections.push(`Ответ GPT обрезался на лимите вывода — сохранены прочитанные позиции, хвост таблицы мог потеряться: сверьте Σ строк с итогом документа`);
  }

  // 3a: Σ сумм строк против напечатанного нетто — итеративное «второе мнение» по таблице (ловит потерянные цифры)
  if (hasImage && doc.totalSum != null && doc.totalSum > 0 && doc.items.length) {
    const sumLines0 = doc.items.reduce((s, it) => s + (it.lineSum ?? 0), 0);
    const dNet0 = doc.totalSum - sumLines0;
    const maxLine0 = Math.max(0, ...doc.items.map((it) => it.lineSum ?? 0));
    // Одиночная опечатка меняет Σ не больше чем примерно на порядок значения самой строки. Если нехватка
    // больше — целые позиции просто не попали в разбор, и «дотягивать» итог правкой существующих строк
    // нельзя (так и рождаются выдуманные суммы). Перечитывание пропускаем; человеком это будет показано
    // как предупреждение в маршруте /parse.
    const missingRows = dNet0 > 0 && dNet0 > maxLine0 * 10 + 10;
    for (let pass = 0; !missingRows && pass < 3; pass++) {
      const sumLines = doc.items.reduce((s, it) => s + (it.lineSum ?? 0), 0);
      const dNet = doc.totalSum - sumLines;
      if (Math.abs(dNet) <= 2) break;
      if (pass === 0) {
        corrections.push(`Σ строк ${Math.round(sumLines * 100) / 100} ≠ нетто в документе ${doc.totalSum} (Δ ${Math.round(dNet * 100) / 100}) — сверочное перечитывание таблицы`);
      }
      let applied = 0;
      try {
        const rv = await oa.chat.completions.create({
          model: config.openaiModel,
          response_format: { type: 'json_object' },
          max_completion_tokens: 1000,
          messages: [
            { role: 'system', content: OCR_SYSTEM },
            { role: 'user', content: [...imageParts, { type: 'text', text: verifyTask(doc.items, dNet, doc.totalSum) }] },
          ],
        });
        const vtext = rv.choices[0]?.message?.content ?? '';
        let res: { lines?: { name?: string; qty?: number; price?: number; vatRate?: number; lineSum?: number }[] };
        try {
          res = JSON.parse(extractJson(vtext)) as typeof res;
        } catch {
          // ответ мог обрезаться на лимите: берём только полностью закрытые объекты lines
          const cut = vtext.lastIndexOf('}');
          res = JSON.parse(extractJson(vtext.slice(0, cut + 1) + ']}')) as typeof res;
        }
        let remaining = dNet;
        for (const ln of res.lines ?? []) {
          const nln = normName(ln.name);
          const it = doc.items.find((x) => normName(x.name) === nln) ??
            (nln ? doc.items.find((x) => normName(x.name).includes(nln) || nln.includes(normName(x.name))) : undefined);
          if (!it) continue;
          const q = typeof ln.qty === 'number' && ln.qty > 0 ? ln.qty : null;
          const p = typeof ln.price === 'number' && ln.price >= 0 ? ln.price : null;
          const ls = typeof ln.lineSum === 'number' && ln.lineSum > 0 ? ln.lineSum : null;
          if (q == null || p == null || ls == null) continue;
          // строка должна быть внутренне согласована и сдвигать Σ к итогу документа без перебора
          if (Math.abs(q * p - ls) > Math.max(1, ls * 0.02)) continue;
          // правка обязана выглядеть как OCR-ошибка в тех же цифрах, а не как подгонка под итог:
          // значение строки не может меняться больше чем на порядок (потеря/лишний ноль — максимум ×10)
          {
            const hi = Math.max(ls, it.lineSum ?? 0);
            const lo = Math.min(ls, it.lineSum ?? 0);
            if (lo > 0 && hi > lo * 10 + 1) continue;
          }
          const diff = ls - (it.lineSum ?? 0);
          if (diff === 0) continue;
          if (Math.sign(diff) !== Math.sign(remaining)) continue;
          if (Math.abs(diff) > Math.abs(remaining) + 2) continue;
          const qtyChanged = q !== it.qty;
          it.qty = q;
          it.price = p;
          it.lineSum = ls;
          if (typeof ln.vatRate === 'number' && ln.vatRate >= 0 && ln.vatRate <= 30) it.vatRate = ln.vatRate;
          // количество поменялось — прежнее решение «в чём считать» могло относиться к другой цифре
          if (qtyChanged && it.countAs) {
            it.countAs = null;
            it.packQty = null;
            it.doubt = it.doubt ?? 'количество исправлено при сверке — решите заново, в чём считать (штуки/упаковки или граммы)';
          }
          remaining -= diff;
          applied += diff;
          corrections.push(`«${it.name}» — сверка с итогом исправила: ${q} × ${p}, сумма ${ls}, PDV ${it.vatRate ?? 0}%`);
        }
      } catch {
        corrections.push('сверочное перечитывание таблицы не удалось — проверьте строки вручную');
        break;
      }
      if (Math.abs(applied) < 0.01) break; // модель ничего не улучшила — повторять бессмысленно
    }
  }

  /**
   * Колонку ПДВ в накладной часто не печатают — перечитывать её с картинки бессмысленно: модель
   * начинает «видеть» несуществующую колонку и портит уже правильную выводку. Поэтому ставку,
   * которую не напечатали, выводим арифметикой по итогам документа; что арифметика не закрыла —
   * уходит на сверочное перечитывание ниже.
   */
  const vatOpen = doc.items.filter((it) => it.vatRate == null || it.vatInferred);
  if (doc.totalVat != null && vatOpen.length) {
    const vatSum = (n: number) => Math.round(n * 100) / 100;
    const known = doc.items.reduce(
      (s, it) => (it.vatRate == null || it.vatInferred ? s : s + lineVat(it.lineSum ?? 0, it.vatRate ?? 0)),
      0
    );
    const rest = doc.totalVat - known;
    const rate = [0, 5, 10, 20].find((r) => Math.abs(vatOpen.reduce((s, it) => s + lineVat(it.lineSum ?? 0, r), 0) - rest) <= 1.5);
    if (rate != null) {
      for (const it of vatOpen) {
        it.vatRate = rate;
        it.vatInferred = rate > 0; // 0% — «без НДС» по итогу документа, это не догадка, а факт
        // старая формулировка сомнения про другую ставку больше не годится
        if (it.doubt && /PDV|ПДВ|НДС/i.test(it.doubt)) {
          it.doubt = rate > 0 ? `ставка PDV не напечатана — вычислено ${rate}% по итогам документа` : null;
        }
      }
      corrections.push(
        rate > 0
          ? `Ставку PDV в строках не напечатали — вывел ${rate}%: Σ НДС по строкам сходится с итогом ПДВ ${vatSum(doc.totalVat)}`
          : `PDV в строках не напечатан: итог ПДВ ${vatSum(doc.totalVat)} уже дают строки со ставкой, остальные без НДС`
      );
    }
  }

  // 3b: если сводный PDV строк не бьется с напечатанным — перечитываем подозреваемые строки
  if (hasImage && doc.totalVat != null && doc.totalVat > 0 && doc.items.length) {
    const calcVat = doc.items.reduce((s, it) => s + lineVat(it.lineSum ?? 0, it.vatRate ?? 0), 0);
    const delta = doc.totalVat - calcVat;
    if (Math.abs(delta) > 1.5) {
      const suspects: { idx: number; rate: number }[] = [];
      doc.items.forEach((it, idx) => {
        if (!it.lineSum) return;
        for (const rate of [0, 5, 10, 20]) {
          if (Math.abs(lineVat(it.lineSum, rate) - lineVat(it.lineSum, it.vatRate ?? 0) - delta) <= 1.5) {
            suspects.push({ idx, rate });
            break;
          }
        }
      });
      if (suspects.length) {
        const names = suspects.map((s) => doc.items[s.idx].name);
        corrections.push(`PDV не бьется (Δ ${Math.round(delta * 100) / 100}) — перечитываю строки: ${names.join('; ')}`);
        try {
          const r3 = await oa.chat.completions.create({
            model: config.openaiModel,
            response_format: { type: 'json_object' },
            max_completion_tokens: 800,
            messages: [
              { role: 'system', content: OCR_SYSTEM },
              { role: 'user', content: [...imageParts, { type: 'text', text: recheckTask(names, delta) }] },
            ],
          });
          const rtext = r3.choices[0]?.message?.content ?? '';
          let res: { lines?: { name?: string; qty?: number; price?: number; vatRate?: number }[] };
          try {
            res = JSON.parse(extractJson(rtext)) as typeof res;
          } catch {
            const cut = rtext.lastIndexOf('}');
            res = JSON.parse(extractJson(rtext.slice(0, cut + 1) + ']}')) as typeof res;
          }
          for (const ln of res.lines ?? []) {
            const nln = normName(ln.name);
            let s = suspects.find((x) => normName(doc.items[x.idx].name) === nln);
            if (!s && suspects.length === 1) s = suspects[0];
            if (!s) continue;
            const it = doc.items[s.idx];
            const q = typeof ln.qty === 'number' && ln.qty > 0 ? ln.qty : null;
            const p = typeof ln.price === 'number' && ln.price >= 0 ? ln.price : null;
            const vr = typeof ln.vatRate === 'number' && ln.vatRate >= 0 && ln.vatRate <= 30 ? ln.vatRate : it.vatRate;
            if (q != null && p != null && it.lineSum && Math.abs(q * p - it.lineSum) <= Math.max(1, it.lineSum * 0.02)) {
              const changed = q !== it.qty || p !== it.price || vr !== it.vatRate;
              const qtyChanged = q !== it.qty;
              // ставку вывели не из колонки, а перечитывание принесло другую — прежнее «выведено X%» уже неправда
              if (vr !== it.vatRate && it.vatInferred) {
                it.vatSuspect = true;
                if (it.doubt && /PDV|ПДВ|НДС/i.test(it.doubt)) {
                  it.doubt = `ставка PDV в документе не напечатана — сверьте ${vr ?? 0}% по фото`;
                }
              }
              it.qty = q;
              it.price = p;
              it.vatRate = vr;
              if (qtyChanged && it.countAs) {
                it.countAs = null;
                it.packQty = null;
                it.doubt = it.doubt ?? 'количество исправлено при перечитывании — проверьте, в чём считать позицию';
              }
              corrections.push(`«${it.name}»${changed ? ' — исправлено' : ' подтверждено'}: ${q} × ${p}, PDV ${vr ?? 0}%`);
            }
          }
        } catch {
          corrections.push('прицельное перечитывание не удалось — проверьте ставки PDV вручную');
        }
      }
      // арифметика после перечитывания: если расхождение осталось и кандидат один — ставим ставку по итогу
      const calcVat2 = doc.items.reduce((s, it) => s + lineVat(it.lineSum ?? 0, it.vatRate ?? 0), 0);
      const stillOff = Math.abs(doc.totalVat - calcVat2) > 1.5;
      if (stillOff && suspects.length === 1) {
        const it = doc.items[suspects[0].idx];
        it.vatRate = suspects[0].rate;
        corrections.push(`«${it.name}»: PDV ${suspects[0].rate}% — единственная строка, объясняющая итог (пересчитано по сумме НДС)`);
      } else if (stillOff && suspects.length > 1) {
        // расхождение не закрыто, а строк-кандидатов несколько — атрибуция недостоверна: просим проверить
        for (const s of suspects) doc.items[s.idx].vatSuspect = true;
        corrections.push(`Ставку PDV ${delta > 0 ? '+' : ''}${Math.round((delta * 100)) / 100} дает одна из строк: ${suspects.map((s) => `«${doc.items[s.idx].name}»`).join(', ')} — проверьте по фото`);
      }
      // если перечитывание закрыло расхождение (Σ PDV = как в документе) — доверяем атрибуции,
      // отдельных предупреждений не даём: остаётся только заметка «исправлено/подтверждено»
    }
  }

  return { doc, model: config.openaiModel, transcript, corrections };
}
