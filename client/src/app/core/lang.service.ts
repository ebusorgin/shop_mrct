import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

export type AppLang = 'ru' | 'en' | 'sr';

const STORAGE_KEY = 'app_lang';
const SUPPORTED: AppLang[] = ['ru', 'en', 'sr'];
const DEFAULT: AppLang = 'ru';

@Injectable({ providedIn: 'root' })
export class LangService {
  private translate = inject(TranslateService);

  readonly currentLang = signal<AppLang>(this.load());

  init(): void {
    this.translate.addLangs(SUPPORTED);
    this.translate.use(this.currentLang());
  }

  setLang(lang: AppLang): void {
    if (!SUPPORTED.includes(lang)) return;
    localStorage.setItem(STORAGE_KEY, lang);
    this.currentLang.set(lang);
    this.translate.use(lang);
  }

  private load(): AppLang {
    const saved = localStorage.getItem(STORAGE_KEY) as AppLang | null;
    return saved && SUPPORTED.includes(saved) ? saved : DEFAULT;
  }
}
