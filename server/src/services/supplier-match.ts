/**
 * Опознание поставщика в шапке сканированной накладной по справочнику `suppliers`.
 *
 * Агенты читают документ дословно, но продавец не всегда напечатан отдельной строкой:
 * у WFC в верхней части листа остаются только GLN и банковский счёт, а в шапке —
 * «Primalac: MIX MARKT». Поэтому после разбора детерминированно ищем в тексте
 * реквизиты известных поставщиков (название, PIB, GLN, счёт) и подставляем
 * каноническое имя из справочника. Модель числа и суммы не трогает — только имя.
 */
import type { PoolClient } from 'pg';
import { pool, tx } from '../db';

export interface SupplierRef {
  id: number;
  code: string;
  name: string;
  legalName: string;
  pib: string;
  mb: string;
  gln: string;
  accounts: string[];
}

export interface SupplierDocLike {
  supplier: string | null;
  supplierPib: string | null;
  /** Реквизиты продавца из шапки (заполняются агентом «Каталог» по транскрипции). */
  supplierAddress?: string | null;
  supplierMb?: string | null;
  supplierGln?: string | null;
  supplierAccounts?: string[] | null;
}

/** Плейсхолдеры модели вместо названия — это «не распознано», а не поставщик. */
export function isPlaceholderSupplier(value: string | null | undefined): boolean {
  const s = String(value ?? '').trim();
  return !s || /^[?\-–—.…]+$/.test(s) || /^(не\s*указан[оа]?|неизвестен|не\s*распознан[оа]?|n\/?a|none|null)$/i.test(s);
}

/** Справочник поставщиков для сопоставления с шапкой документа. */
export async function loadSupplierRefs(client?: PoolClient): Promise<SupplierRef[]> {
  const q = client ?? pool;
  const { rows } = await q.query(`
    select id, code, name, legal_name as "legalName", pib, mb, gln, accounts
      from suppliers
     order by id
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    legalName: String(r.legalName ?? ''),
    pib: String(r.pib ?? '').replace(/\D+/g, ''),
    mb: String(r.mb ?? '').replace(/\D+/g, ''),
    gln: String(r.gln ?? '').replace(/\D+/g, ''),
    accounts: Array.isArray(r.accounts) ? (r.accounts as unknown[]).map((x) => String(x)) : [],
  }));
}

const normText = (s: string): string => s.toUpperCase().replace(/Ё/g, 'Е').replace(/[^A-ZА-Я0-9]+/g, ' ').trim();

/** Название поставщика целиком в тексте (по словам, чтобы WFC не совпал с обрывком слова). */
function hasName(text: string, name: string): boolean {
  const n = normText(name);
  if (n.length < 3) return false;
  return new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(text);
}

export interface SupplierMatch {
  ref: SupplierRef;
  /** По чему опознали — для журнала и подсказки оператору. */
  via: 'названию' | 'PIB' | 'GLN' | 'счёту';
}

/** PIB нашей компании (MIX MARKT GASTRO): на бланках стоит в блоке получателя. */
const OWN_PIB = '114917301';

/**
 * Поставщик по данным разбора: сначала явное название, затем PIB, GLN и банковский
 * счёт в транскрипции. Возвращает null, если ни один признак не совпал.
 */
export function matchSupplier(
  refs: SupplierRef[],
  input: { supplier?: string | null; pib?: string | null; transcript?: string | null }
): SupplierMatch | null {
  const supplierText = isPlaceholderSupplier(input.supplier) ? '' : String(input.supplier).trim();
  const supplierNorm = normText(supplierText);
  const pib = String(input.pib ?? '').replace(/\D+/g, '');
  const transcript = String(input.transcript ?? '');
  const transcriptNorm = normText(transcript);
  // Реквизиты в тексте ищем целыми числовыми токенами: склейка соседних сумм не должна
  // случайно дать чужой PIB или счёт.
  const digitTokens = (transcript.match(/\d[\d\s\-/]{7,}\d/g) ?? []).map((t) => t.replace(/\D+/g, ''));
  const pibTokens = new Set([...(transcript.match(/\d{8,9}/g) ?? []), ...digitTokens.filter((t) => t.length === 8 || t.length === 9)]);
  const glnTokens = new Set([...(transcript.match(/\d{13}/g) ?? []), ...digitTokens.filter((t) => t.length === 13)]);

  // 1. Название из ответа модели: «WFC», «WFC DOO BEOGRAD», «MMM LASTA …».
  if (supplierNorm) {
    for (const ref of refs) {
      if (hasName(supplierNorm, ref.name) || (ref.legalName && hasName(supplierNorm, ref.legalName))) {
        return { ref, via: 'названию' };
      }
    }
    // то же название могло попасть в транскрипцию (модель вернула пустое поле)
    for (const ref of refs) {
      const tokens = ref.legalName ? [ref.name, ref.legalName] : [ref.name];
      if (tokens.some((t) => hasName(transcriptNorm, t))) return { ref, via: 'названию' };
    }
  }

  // 2. PIB продавца — самые надёжные 8–9 цифр.
  if (pib) {
    const ref = refs.find((r) => r.pib && r.pib === pib);
    if (ref) return { ref, via: 'PIB' };
  }
  {
    const ref = refs.find((r) => r.pib && pibTokens.has(r.pib));
    if (ref) return { ref, via: 'PIB' };
  }

  // 3. GLN — 13 цифр, напечатаны в верхней части листа рядом с логотипом.
  for (const ref of refs) {
    if (ref.gln.length >= 12 && glnTokens.has(ref.gln)) return { ref, via: 'GLN' };
  }

  // 4. Банковский счёт продавца (только цифры, обычно 18 знаков).
  for (const ref of refs) {
    for (const acc of ref.accounts) {
      const digits = acc.replace(/\D+/g, '');
      if (digits.length >= 10 && digitTokens.includes(digits)) return { ref, via: 'счёту' };
    }
  }

  // 5. Название в транскрипции — последний шанс, когда поле ПОСТАВЩИК пустое.
  for (const ref of refs) {
    if (hasName(transcriptNorm, ref.name)) return { ref, via: 'названию' };
  }
  return null;
}

/**
 * Подставляет канонического поставщика в документ разбора.
 * Возвращает подпись для журнала или null, если поставщик не опознан.
 */
export function applySupplierMatch(
  doc: SupplierDocLike,
  refs: SupplierRef[],
  transcript: string
): SupplierMatch | null {
  if (isPlaceholderSupplier(doc.supplier)) doc.supplier = null;
  const hit = matchSupplier(refs, { supplier: doc.supplier, pib: doc.supplierPib, transcript });
  if (hit) {
    doc.supplier = hit.ref.name;
    // Реквизиты берём из справочника: модель иногда ставит в PIB получателя.
    if (hit.ref.pib) doc.supplierPib = hit.ref.pib;
    return hit;
  }
  // Поставщик не из справочника: PIB получателя (наш) — не его реквизит.
  if (doc.supplierPib === OWN_PIB && !/MIX\s*MARKT/i.test(doc.supplier ?? '')) {
    doc.supplierPib = null;
  }
  return null;
}

// ---------- автосоздание поставщика по накладной ----------

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'j',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ђ: 'dj', ћ: 'c', љ: 'lj', њ: 'nj', ј: 'j', ѕ: 'dz',
  č: 'c', ć: 'c', ž: 'z', š: 's', đ: 'dj',
};

/** Читаемое название поставщика из шапки: без мусора, не длиннее 160 знаков. */
function cleanSupplierName(value: string | null | undefined): string | null {
  if (isPlaceholderSupplier(value)) return null;
  const s = String(value)
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—:;,\s]+|[-–—:;,\s]+$/g, '');
  return s ? s.slice(0, 160) : null;
}

/** Уникальный человекочитаемый код: «monolith-distribution», «mix-markt-gastro»… */
function supplierCodeBase(name: string): string {
  const translit = [...name.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  // Юридические формы в код не тащим: «Monolith Distribution d.o.o.» -> monolith-distribution.
  const cleaned = translit.replace(/\b(d\s*o\s*o|doo|d\.o\.o|llc|ltd|limited|gmbh|inc|plc|a\.d\.|ad)\b/g, ' ');
  const slug = cleaned
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'supplier';
}

interface SupplierRow {
  id: number;
  code: string;
  name: string;
  legalName: string | null;
  pib: string | null;
  mb: string | null;
  gln: string | null;
  accounts: unknown;
}

function rowToRef(r: SupplierRow): SupplierRef {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    legalName: String(r.legalName ?? ''),
    pib: String(r.pib ?? '').replace(/\D+/g, ''),
    mb: String(r.mb ?? '').replace(/\D+/g, ''),
    gln: String(r.gln ?? '').replace(/\D+/g, ''),
    accounts: Array.isArray(r.accounts) ? (r.accounts as unknown[]).map((x) => String(x)) : [],
  };
}

export interface EnsuredSupplier {
  ref: SupplierRef;
  /** true — поставщика не было, строка добавлена из этой накладной. */
  created: boolean;
  /** По чему нашли существующего / «новый». */
  via: string;
}

/**
 * Найти поставщика в справочнике или добавить нового с реквизитами из накладной.
 * Повторное сканирование того же продавца найдёт его по названию/PIB/GLN/счёту.
 * Вызывается после разбора и при проведении накладной (в той же транзакции).
 */
export async function resolveOrCreateSupplier(
  doc: SupplierDocLike,
  transcript: string,
  opts: { client?: PoolClient; actorId?: number | null } = {}
): Promise<EnsuredSupplier | null> {
  const run = async (client: PoolClient): Promise<EnsuredSupplier | null> => {
    const refs = await loadSupplierRefs(client);
    const hit = applySupplierMatch(doc, refs, transcript);
    if (hit) return { ref: hit.ref, created: false, via: hit.via };

    const name = cleanSupplierName(doc.supplier);
    if (!name) return null;
    const pib = String(doc.supplierPib ?? '').replace(/\D+/g, '');
    const mb = String(doc.supplierMb ?? '').replace(/\D+/g, '');
    const gln = String(doc.supplierGln ?? '').replace(/\D+/g, '');
    const address = String(doc.supplierAddress ?? '').trim().slice(0, 300);
    const accounts = [...new Set(
      (doc.supplierAccounts ?? [])
        .map((a) => String(a).trim())
        .filter((a) => a.replace(/\D+/g, '').length >= 6)
    )].slice(0, 6);

    // Повторная проверка после загрузки справочника: поставщика могли добавить параллельно.
    const { rows: existing } = await client.query<SupplierRow>(
      `select id, code, name, legal_name as "legalName", pib, mb, gln, accounts
         from suppliers
        where lower(btrim(name)) = lower(btrim($1))
           or ($2 <> '' and regexp_replace(coalesce(pib, ''), '\\D', '', 'g') = $2)
        limit 1`,
      [name, pib]
    );
    if (existing.length) {
      doc.supplier = String(existing[0].name);
      return { ref: rowToRef(existing[0]), created: false, via: pib ? 'PIB' : 'названию' };
    }

    const base = supplierCodeBase(name);
    for (let attempt = 0; attempt < 30; attempt++) {
      const code = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const { rows } = await client.query<SupplierRow>(
        `insert into suppliers (code, name, legal_name, address, pib, mb, gln, accounts, note)
         values ($1, $2, '', $3, $4, $5, $6, $7::jsonb, $8)
         on conflict (code) do nothing
         returning id, code, name, legal_name as "legalName", pib, mb, gln, accounts`,
        [
          code,
          name,
          address,
          pib,
          mb,
          gln,
          JSON.stringify(accounts),
          'Добавлен автоматически при сканировании накладной',
        ]
      );
      if (rows.length) {
        const ref = rowToRef(rows[0]);
        doc.supplier = ref.name;
        if (pib && !doc.supplierPib) doc.supplierPib = pib;
        return { ref, created: true, via: 'новый' };
      }
    }
    return null;
  };

  return opts.client ? run(opts.client) : tx(run);
}
