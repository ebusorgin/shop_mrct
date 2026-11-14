import { AppLang } from './lang.service';

/** Название сущности на трёх языках; пустой перевод — показываем основное. */
export interface LocalizedNames {
  name: string;
  nameEn?: string | null;
  nameSr?: string | null;
}

/** Название на выбранном языке интерфейса с откатом на основное (русское). */
export function localizedName(item: LocalizedNames, lang: AppLang): string {
  if (lang === 'en' && item.nameEn) return item.nameEn;
  if (lang === 'sr' && item.nameSr) return item.nameSr;
  return item.name;
}
