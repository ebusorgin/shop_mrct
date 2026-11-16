/**
 * Товароведческий словарь «как это называют в накладных» -> как это лежит на складе.
 *
 * Накладные приходят на сербском/хорватском (krompir, luk, mleko), немецком
 * (Kondensmilch, Kartoffel), английском (potato, milk) и русском. Склад — русский.
 * Точное сравнение имён тут не работает, поэтому:
 *  1) «Чтец» переписывает название дословно;
 *  2) «Товаровед» (этот словарь + каталог) находит существующий товар по смыслу
 *     или подсказывает русское складское имя и категорию для нового;
 *  3) «Счетовод» проверяет арифметику (фасовка, суммы, НДС).
 *
 * Правила консервативности:
 *  - совпадение только по однозначному смыслу; свежий огурец (krastavac) ≠ солёные огурцы,
 *    молотый перец ≠ перец горошком — для таких случаев отдельные записи;
 *  - при совпадении нескольких записей побеждает более длинная (специфичная) фраза.
 */

export type StoreUnit = 'г' | 'мл' | 'шт';

export interface LexEntry {
  /** Фразы, как они встречаются в документах (нормализуются при загрузке). */
  terms: string[];
  /** Точное имя существующего товара в каталоге склада (если товар там есть). */
  product?: string;
  /** Русское складское имя для НОВОГО товара (если в каталоге такого нет). */
  newName?: string;
  /** Категория справочника (должна совпадать с product_categories.name). */
  category: string;
  /** В чём товар хранится на складе, если это новый товар. */
  store?: StoreUnit;
}

/** Нормализация: диакритика -> ASCII, ё->е, только буквы/цифры, одиночные пробелы. */
export function normText(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/đ/g, 'dj')
    .replace(/š/g, 's')
    .replace(/[ćč]/g, 'c')
    .replace(/ž/g, 'z')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normText(s).split(' ').filter(Boolean);
}

/** Слова, которые не помогают понять товар: бренды, фасовка, проценты, сокращения колонок. */
const NOISE = new Set([
  'kg', 'g', 'gr', 'gram', 'grams', 'гр', 'г', 'кг', 'l', 'ml', 'л', 'мл', 'lk', 'lit', 'litar',
  'kom', 'kos', 'komada', 'pcs', 'pc', 'szt', 'ut', 'pack', 'packung', 'dose', 'pak', 'pakovan',
  'pakovanje', 'paket', 'mc', 'aro', 'sp', 'mp', 'gn', 'ik', 'ikg', 'ilk', 'mm', 'pet', 'tet',
  'min', 'max', 'velicina', 'vel', 'class', 'klasa', 'tip', 'vrst', 'vrsta', 'extra', 'premium',
  'fresh', 'svez', 'sveza', 'uht', 'konz', 'konzervis', 'smrznut', 'zamrznut', 'hladjen', 'suvo',
  'oljusten', 'oguljen', 'celo', 'rezano',
]);

/** Слова-сорта/виды, которые важны для смысла (не выбрасываем), поэтому NOISE их не содержит. */
function contentTokens(s: string): string[] {
  return tokens(s).filter((t) => !NOISE.has(t) && !/^\d+([.,]\d+)?$/.test(t));
}

/**
 * Поиск последовательности токенов в строке токенов.
 * 2 — точное совпадение, 1 — только по основе (окончания), 0 — нет.
 * Точное совпадение всегда важнее: «secer» (сахар) не должен проигрывать
 * «secerac» (кукуруза), которое совпало лишь по префиксу.
 */
function seqQuality(line: string[], term: string[]): number {
  if (!term.length) return 0;
  let best = 0;
  for (let i = 0; i + term.length <= line.length; i++) {
    let exact = true;
    let prefix = true;
    for (let j = 0; j < term.length; j++) {
      const a = line[i + j];
      const b = term[j];
      if (a !== b) exact = false;
      // окончания сербских/русских слов: jogurt/jogurta, paprika/paprike.
      // Префиксное равенство — только для длинных слов и малой разницы в длине,
      // иначе «sir» (сыр) ложно совпадёт с «sirce» (уксус).
      const eq =
        a === b ||
        (a.length >= 5 && b.length >= 5 && Math.abs(a.length - b.length) <= 3 && (a.startsWith(b) || b.startsWith(a)));
      if (!eq) {
        prefix = false;
        break;
      }
    }
    if (exact) return 2;
    if (prefix) best = 1;
  }
  return best;
}

/**
 * Записи словаря. Порядок не важен: выбор — по длине совпавшей фразы.
 * product — имя товара, уже существующего в каталоге (локального или боевого — по имени).
 * newName — что предложить, если такого товара на складе нет.
 */
export const LEXICON: LexEntry[] = [
  // ── овощи ────────────────────────────────────────────────────────────────
  { terms: ['krompir', 'kartoffel', 'kartoffeln', 'potato', 'potatoes', 'картофель', 'картошка'], product: 'картофель', category: 'овощи' },
  { terms: ['luk crni', 'crni luk', 'luk crveni', 'luk beli', 'luk', 'zwiebel', 'onion', 'лук репчатый', 'лук'], product: 'лук репчатый', category: 'овощи' },
  { terms: ['luk crni mladi', 'luk mladi crni', 'crni luk mladi', 'mladi luk', 'luk mladi', 'frühlingszwiebel', 'spring onion', 'зелёный лук', 'лук зелёный'], newName: 'лук зелёный', category: 'овощи' },
  { terms: ['sargarepa', 'mrkva', 'karotte', 'möhre', 'carrot', 'морковь'], product: 'морковь', category: 'овощи' },
  { terms: ['kupus', 'kohl', 'cabbage', 'капуста белокочанная', 'капуста'], product: 'капуста белокочанная', category: 'овощи' },
  { terms: ['kineski kupus', 'pekinski kupus', 'chinakohl', 'napa cabbage', 'капуста пекинская'], product: 'капуста пекинская', category: 'овощи' },
  { terms: ['cvekla', 'rote bete', 'beetroot', 'свёкла', 'свекла'], product: 'свёкла', category: 'овощи' },
  { terms: ['sampinjon', 'sampinjoni', 'champignon', 'champignons', 'шампиньоны'], product: 'шампиньоны', category: 'овощи' },
  { terms: ['beli luk', 'cesnjak', 'knoblauch', 'garlic', 'чеснок'], product: 'чеснок', category: 'овощи' },
  { terms: ['djumbir', 'ingwer', 'ginger', 'имбирь'], product: 'имбирь', category: 'овощи' },
  { terms: ['krastavac svez', 'svezi krastavac', 'krastavac', 'gurke', 'cucumber', 'огурцы свежие'], newName: 'огурцы свежие', category: 'овощи' },
  { terms: ['kiseli krastavac', 'krastavci kiseli', 'krastavac kiseli', 'salatni krastavac', 'gurke essig', 'pickles', 'огурцы солёные', 'огурцы маринованные'], product: 'огурцы солёные', category: 'овощи' },
  { terms: ['paprika', 'paprike', 'paprika zelena', 'paprika crvena', 'gemüsepaprika', 'bell pepper', 'перец болгарский', 'перец сладкий'], product: 'перец болгарский', category: 'овощи' },
  { terms: ['pikva', 'bundeva', 'kurbis', 'pumpkin', 'тыква'], newName: 'тыква', category: 'овощи' },
  { terms: ['paradajz', 'tomate', 'tomaten', 'tomato', 'помидоры'], newName: 'помидоры', category: 'овощи' },
  { terms: ['plavi patlidzan', 'patlidzan', 'aubergine', 'eggplant', 'баклажаны'], newName: 'баклажаны', category: 'овощи' },
  { terms: ['tikvice', 'zucchini', 'кабачки'], newName: 'кабачки', category: 'овощи' },
  { terms: ['persun', 'petersilie', 'parsley', 'петрушка'], newName: 'петрушка', category: 'овощи' },
  { terms: ['mirodjija', 'dill', 'укроп'], newName: 'укроп', category: 'овощи' },
  { terms: ['spenat', 'spinat', 'spinach', 'шпинат'], newName: 'шпинат', category: 'овощи' },
  { terms: ['celer', 'sellerie', 'celery', 'сельдерей'], newName: 'сельдерей', category: 'овощи' },
  { terms: ['praziluk', 'lauch', 'porree', 'leek', 'порей', 'лук порей'], newName: 'лук порей', category: 'овощи' },
  { terms: ['repa', 'kohlrabi', 'репа'], newName: 'репа', category: 'овощи' },
  { terms: ['rotkvica', 'radieschen', 'radish', 'редис'], newName: 'редис', category: 'овощи' },

  // ── фрукты и ягоды ───────────────────────────────────────────────────────
  { terms: ['limun', 'zitrone', 'lemon', 'лимон'], product: 'лимон', category: 'фрукты' },
  { terms: ['ananas', 'ananass', 'pineapple', 'ананас'], product: 'ананасы консервированные', category: 'консервы' },
  { terms: ['suva sljiva', 'suve sljive', 'backpflaume', 'prunes', 'чернослив'], product: 'чернослив', category: 'фрукты' },
  { terms: ['cukat', 'cukati', 'sukade', 'цукаты'], product: 'цукаты', category: 'фрукты' },
  { terms: ['jagoda zamrznuta', 'zamrznute jagode', 'smrznute jagode', 'frozen berries', 'ягоды замороженные'], product: 'ягоды замороженные', category: 'фрукты' },
  { terms: ['jabuka', 'apfel', 'apple', 'яблоки'], newName: 'яблоки', category: 'фрукты' },
  { terms: ['pomorandza', 'orange', 'apfelsine', 'апельсины'], newName: 'апельсины', category: 'фрукты' },
  { terms: ['banana', 'banane', 'бананы'], newName: 'бананы', category: 'фрукты' },
  { terms: ['grozdje', 'weintrauben', 'grapes', 'виноград'], newName: 'виноград', category: 'фрукты' },
  { terms: ['breskva', 'pfirsich', 'peach', 'персики'], newName: 'персики', category: 'фрукты' },
  { terms: ['kruska', 'birne', 'pear', 'груши'], newName: 'груши', category: 'фрукты' },

  // ── молочное и яйца ──────────────────────────────────────────────────────
  { terms: ['mleko', 'mlijeko', 'milch', 'milk', 'молоко'], product: 'молоко', category: 'молочные продукты и яйца', store: 'мл' },
  { terms: ['kondensmilch', 'kondenzovano mleko', 'condensed milk', 'сгущённое молоко', 'сгущенное молоко'], product: 'сгущённое молоко', category: 'молочные продукты и яйца' },
  { terms: ['jogurt', 'joghurt', 'yogurt', 'йогурт'], product: 'йогурт натуральный', category: 'молочные продукты и яйца' },
  { terms: ['kefir', 'кефир'], product: 'кефир', category: 'молочные продукты и яйца', store: 'мл' },
  { terms: ['puter', 'butter', 'масло сливочное'], product: 'масло сливочное', category: 'молочные продукты и яйца' },
  { terms: ['margarin', 'margarine', 'маргарин'], newName: 'маргарин', category: 'молочные продукты и яйца' },
  { terms: ['sir', 'kase', 'käse', 'cheese', 'сыр'], product: 'сыр твёрдый', category: 'молочные продукты и яйца' },
  { terms: ['ceddar', 'cheddar', 'чеддер'], newName: 'сыр чеддер', category: 'молочные продукты и яйца' },
  { terms: ['kajmak', 'каймак'], newName: 'каймак', category: 'молочные продукты и яйца' },
  { terms: ['pavlaka', 'smetana', 'sahne', 'cream', 'сметана', 'сливки'], newName: 'сметана', category: 'молочные продукты и яйца' },
  { terms: ['tvorog', 'quark', 'topfen', 'творог'], product: 'творог', category: 'молочные продукты и яйца' },
  { terms: ['jaja', 'jaje', 'eier', 'egg', 'eggs', 'яйца куриные', 'яйцо куриное', 'яйца'], product: 'яйца куриные', category: 'молочные продукты и яйца', store: 'шт' },

  // ── мясо и птица ─────────────────────────────────────────────────────────
  { terms: ['govedina', 'rindfleisch', 'beef', 'говядина'], product: 'говядина', category: 'мясо и птица' },
  { terms: ['svinjetina', 'schweinefleisch', 'pork', 'свинина'], product: 'свинина', category: 'мясо и птица' },
  { terms: ['pileci file', 'pilece file', 'hahnchenfilet', 'chicken fillet', 'куриное филе', 'куриная грудка'], product: 'куриное филе', category: 'мясо и птица' },
  { terms: ['piletina', 'pile', 'hahnchen', 'huhn', 'chicken', 'курица'], product: 'курица', category: 'мясо и птица' },
  { terms: ['curetina', 'truthahn', 'turkey', 'индейка'], newName: 'индейка', category: 'мясо и птица' },
  { terms: ['junetina', 'kalbfleisch', 'veal', 'телятина'], newName: 'телятина', category: 'мясо и птица' },
  { terms: ['sunka', 'schinken', 'ham', 'ветчина'], product: 'ветчина', category: 'мясо и птица' },
  { terms: ['kobasica', 'wurst', 'sausage', 'колбаса'], product: 'колбаса варёная', category: 'мясо и птица' },
  { terms: ['virsla', 'virsle', 'wurstchen', 'sausages', 'сосиски'], newName: 'сосиски', category: 'мясо и птица' },
  { terms: ['slanina', 'speck', 'bacon', 'бекон'], newName: 'бекон', category: 'мясо и птица' },
  { terms: ['cevap', 'cevapi', 'чевапи'], newName: 'чевапи', category: 'мясо и птица' },
  { terms: ['burek', 'pita', 'пирог'], newName: 'пирог с мясом', category: 'мясо и птица' },

  // ── рыба ────────────────────────────────────────────────────────────────
  { terms: ['losos', 'lachs', 'salmon', 'лосось'], product: 'лосось слабосолёный', category: 'рыба и морепродукты' },
  { terms: ['sled', 'hering', 'haring', 'herring', 'сельдь'], product: 'сельдь слабосолёная', category: 'рыба и морепродукты' },
  { terms: ['file minjaj', 'minjaj', 'seelachs', 'pollock', 'филе минтая', 'минтай'], product: 'филе минтая', category: 'рыба и морепродукты' },
  { terms: ['kraba', 'krab', 'surimi', 'крабовые палочки'], product: 'крабовые палочки', category: 'рыба и морепродукты' },
  { terms: ['tuna', 'thunfisch', 'тунец'], newName: 'тунец консервированный', category: 'рыба и морепродукты' },

  // ── бакалея ──────────────────────────────────────────────────────────────
  { terms: ['brasno', 'mehl', 'flour', 'мука'], product: 'мука', category: 'бакалея' },
  { terms: ['secer', 'zucker', 'sugar', 'сахар'], product: 'сахар', category: 'бакалея' },
  { terms: ['so', 'salz', 'salt', 'соль'], product: 'соль', category: 'специи и приправы' },
  { terms: ['pirinac', 'pirinac', 'reis', 'rice', 'рис'], product: 'рис', category: 'бакалея' },
  { terms: ['griz', 'griess', 'манная крупа'], product: 'манная крупа', category: 'бакалея' },
  { terms: ['heljda', 'buchweizen', 'buckwheat', 'гречка'], product: 'гречка', category: 'бакалея' },
  { terms: ['kvasac', 'hefe', 'yeast', 'дрожжи'], product: 'дрожжи', category: 'бакалея' },
  { terms: ['soda bikarbona', 'soda', 'natron', 'сода пищевая'], product: 'сода пищевая', category: 'бакалея' },
  { terms: ['soja', 'sojina', 'sojaspresse', 'спаржа соевая'], product: 'спаржа соевая', category: 'бакалея' },
  { terms: ['funcoza', 'funcoza', 'glasnudeln', 'фунчоза'], product: 'фунчоза', category: 'бакалея' },
  { terms: ['orah', 'walnuss', 'walnut', 'грецкий орех'], product: 'грецкий орех', category: 'бакалея' },
  { terms: ['izum', 'grozdjice', 'rosinen', 'raisins', 'изюм'], product: 'изюм', category: 'бакалея' },
  { terms: ['kikiriki', 'erdnuss', 'peanut', 'арахис'], newName: 'арахис', category: 'бакалея' },
  { terms: ['testenina', 'nudeln', 'pasta', 'макароны'], newName: 'макароны', category: 'бакалея' },
  { terms: ['ovsene pahuljice', 'haferflocken', 'oatmeal', 'овсяные хлопья'], newName: 'овсяные хлопья', category: 'бакалея' },
  { terms: ['kukuruzni skrob', 'maisstarke', 'corn starch', 'кукурузный крахмал'], newName: 'кукурузный крахмал', category: 'бакалея' },
  { terms: ['sirce', 'essig', 'vinegar', 'уксус'], product: 'уксус', category: 'соусы и масла', store: 'мл' },
  { terms: ['ulje', 'ol', 'öl', 'sunflower oil', 'масло растительное', 'подсолнечное масло'], product: 'масло растительное', category: 'соусы и масла', store: 'мл' },
  { terms: ['maslinovo ulje', 'olivenöl', 'olive oil', 'оливковое масло'], newName: 'масло оливковое', category: 'соусы и масла', store: 'мл' },
  { terms: ['majonez', 'mayonnaise', 'майонез'], product: 'майонез', category: 'соусы и масла' },
  { terms: ['kecap', 'ketchup', 'кетчуп'], newName: 'кетчуп', category: 'соусы и масла' },
  { terms: ['senf', 'mustard', 'горчица'], newName: 'горчица', category: 'соусы и масла' },
  { terms: ['soj sos', 'sojasauce', 'soy sauce', 'соевый соус'], product: 'соевый соус', category: 'соусы и масла', store: 'мл' },

  // ── консервы ─────────────────────────────────────────────────────────────
  { terms: ['tomato p', 'tomato paste', 'paradajz pire', 'paradajz koncentrat', 'tomatenmark', 'томатная паста'], product: 'томатная паста', category: 'консервы' },
  { terms: ['masline', 'oliven', 'olives', 'оливки', 'маслины'], product: 'оливки консервированные', category: 'консервы' },
  { terms: ['kukuruz secеrac', 'kukuruz secerac', 'secerac', 'mais', 'corn', 'кукуруза консервированная', 'кукуруза сахарная'], product: 'кукуруза консервированная', category: 'консервы' },
  { terms: ['grasak konzervis', 'grasak', 'erbsen', 'peas', 'горошек зелёный', 'горошек консервированный'], product: 'горошек зелёный консервированный', category: 'консервы' },
  { terms: ['grah', 'pasulj', 'bohnen', 'beans', 'фасоль'], newName: 'фасоль', category: 'бакалея' },
  { terms: ['kapar', 'kapers', 'каперсы'], newName: 'каперсы', category: 'консервы' },
  { terms: ['džem', 'dzem', 'marmelade', 'jam', 'джем'], newName: 'джем', category: 'консервы' },
  { terms: ['med', 'honig', 'honey', 'мёд', 'мед'], newName: 'мёд', category: 'бакалея' },

  // ── специи ───────────────────────────────────────────────────────────────
  { terms: ['biber crni zrno', 'biber zrno', 'pfeffer ganz', 'black peppercorns', 'перец чёрный горошек', 'перец горошком'], newName: 'перец чёрный горошком', category: 'специи и приправы' },
  { terms: ['biber crni mleveni', 'mleveni biber', 'pfeffer gemahlen', 'ground black pepper', 'перец чёрный молотый', 'чёрный перец'], product: 'перец чёрный молотый', category: 'специи и приправы' },
  { terms: ['biber', 'pfeffer', 'pepper', 'перец'], newName: 'перец чёрный молотый', category: 'специи и приправы' },
  { terms: ['cili', 'chili', 'чили'], product: 'перец чили молотый', category: 'специи и приправы' },
  { terms: ['lovor', 'lovorov list', 'lorbeer', 'bay leaf', 'лавровый лист'], product: 'лавровый лист', category: 'специи и приправы' },
  { terms: ['kim', 'kummel', 'kümmel', 'cumin', 'зира'], product: 'зира', category: 'специи и приправы' },
  { terms: ['vanilin', 'vanille', 'vanilla', 'ванилин'], product: 'ванилин', category: 'специи и приправы' },
  { terms: ['korijander', 'koriander', 'coriander', 'кориандр'], newName: 'кориандр', category: 'специи и приправы' },
  { terms: ['ruzmarin', 'rosmarin', 'rosemary', 'розмарин'], newName: 'розмарин', category: 'специи и приправы' },
  { terms: ['origano', 'oregano', 'орегано'], newName: 'орегано', category: 'специи и приправы' },
  { terms: ['bosiljak', 'basilikum', 'basil', 'базилик'], newName: 'базилик', category: 'специи и приправы' },
  { terms: ['hmelj suneli', 'chmeli suneli', 'хмели-сунели', 'хмели сунели'], product: 'хмели-сунели', category: 'специи и приправы' },
  { terms: ['priprava za pilav', 'zacini za pilav', 'приправа для плова'], product: 'приправа для плова', category: 'специи и приправы' },
  { terms: ['priprava za korejsku salatu', 'приправа для корейских салатов'], product: 'приправа для корейских салатов', category: 'специи и приправы' },
  { terms: ['muskatni orascic', 'muskat', 'muskatnuss', 'мускатный орех'], newName: 'мускатный орех', category: 'специи и приправы' },
  { terms: ['cimet', 'zimt', 'cinnamon', 'корица'], newName: 'корица', category: 'специи и приправы' },

  // ── напитки ──────────────────────────────────────────────────────────────
  { terms: ['voda negaz', 'negazirana voda', 'wasser', 'water', 'вода'], newName: 'вода', category: 'бакалея', store: 'мл' },
  { terms: ['sok', 'saft', 'juice', 'сок'], newName: 'сок', category: 'бакалея', store: 'мл' },
  { terms: ['pivo', 'bier', 'beer', 'пиво'], newName: 'пиво', category: 'бакалея', store: 'мл' },
  { terms: ['vino', 'wein', 'wine', 'вино'], newName: 'вино', category: 'бакалея', store: 'мл' },

  // ── хлеб и выпечка ───────────────────────────────────────────────────────
  { terms: ['hleb', 'brot', 'bread', 'хлеб белый', 'хлеб'], product: 'хлеб белый', category: 'бакалея' },
  { terms: ['vafle', 'waffeln', 'вафельные коржи'], product: 'вафельные коржи', category: 'бакалея' },
];

interface NormEntry extends LexEntry {
  normTerms: string[][];
}

const NORM_LEX: NormEntry[] = LEXICON.map((e) => ({
  ...e,
  normTerms: e.terms.map((t) => tokens(t)).filter((t) => t.length),
})).filter((e) => e.normTerms.length);

/** Запись словаря, которая лучше всего описывает строку: сначала точные, затем по основе, внутри — длиннее. */
export function findLexEntry(name: string): { entry: LexEntry; score: number } | null {
  const line = contentTokens(name);
  const full = tokens(name);
  let best: { entry: LexEntry; score: number } | null = null;
  for (const e of NORM_LEX) {
    for (const t of e.normTerms) {
      const q = Math.max(seqQuality(line, t), seqQuality(full, t));
      if (!q) continue;
      const score = q * 10000 + t.join(' ').length;
      if (!best || score > best.score) best = { entry: e, score };
    }
  }
  return best;
}

export interface CatalogLike {
  id: number;
  name: string;
  category: string;
  unitCode: string;
  aliases: string[];
}

/**
 * Найти строку накладной в каталоге по смыслу (словарь + точное имя + псевдонимы).
 * Возвращает найденный товар и/или подсказку для нового товара.
 */
/** Готовые блюда/салаты: «Салат крабовый» — не крабовые палочки и не курица. */
const READY_DISH_RE = /\b(salata|salat|салат|винегрет|vinegret|okroska|окрошка|sirniki|сырники|mimoza|мимоза)\b/;

export function matchByMeaning(
  name: string,
  catalog: CatalogLike[],
  byNormName: Map<string, CatalogLike>,
  byAlias: Map<string, CatalogLike>
): {
  match: { product: CatalogLike; via: 'name' | 'alias' | 'lexicon' } | null;
  hint: { name: string; category: string; unit?: StoreUnit } | null;
} {
  const norm = normText(name);
  const byName = byNormName.get(norm);
  if (byName) return { match: { product: byName, via: 'name' }, hint: null };
  const byAl = byAlias.get(norm);
  if (byAl) return { match: { product: byAl, via: 'alias' }, hint: null };
  // салат/готовое блюдо не сопоставляем с ингредиентом из каталога: имя и категорию даст «Товаровед»
  const lex = READY_DISH_RE.test(norm) ? null : findLexEntry(name);
  if (lex) {
    if (lex.entry.product) {
      const p = catalog.find((x) => normText(x.name) === normText(lex.entry.product!));
      if (p) return { match: { product: p, via: 'lexicon' }, hint: null };
    }
    const hintName = lex.entry.newName ?? lex.entry.product;
    if (hintName) {
      return { match: null, hint: { name: hintName, category: lex.entry.category, unit: lex.entry.store } };
    }
  }
  return { match: null, hint: null };
}

/** Русское складское имя и категория для строки без каталога. */
export function classifyNewProduct(name: string): { name: string; category: string; unit?: StoreUnit } | null {
  if (READY_DISH_RE.test(normText(name))) return null;
  const lex = findLexEntry(name);
  if (lex) {
    const n = lex.entry.newName ?? lex.entry.product;
    if (n) return { name: n, category: lex.entry.category, unit: lex.entry.store };
  }
  return null;
}
