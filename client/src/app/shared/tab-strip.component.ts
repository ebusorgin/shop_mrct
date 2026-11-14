import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Одна вкладка верхнего меню раздела. */
export interface TabItem {
  id: string;
  label: string;
  /** Эмодзи-иконка перед названием. */
  icon?: string;
  /** id кнопки и панели — для aria-связки вкладки с контентом. */
  buttonId?: string;
  panelId?: string;
}

/**
 * Верхние вкладки браузерного вида — общий элемент для страниц
 * с несколькими разделами (Настройки, Склад): белая активная вкладка,
 * общая линия-подчёркивание и скругления сверху.
 */
@Component({
  selector: 'app-tab-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .tab-strip { display: flex; align-items: flex-end; gap: 2px; overflow-x: auto; padding: 0 4px 1px;
      box-shadow: inset 0 -1px 0 var(--border); scrollbar-width: none; }
    .tab-strip::-webkit-scrollbar { display: none; }
    .tab-strip button { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; min-height: 40px;
      margin-bottom: -1px; padding: 0 16px; border: 1px solid transparent; border-radius: 11px 11px 0 0;
      background: transparent; color: var(--muted); font: inherit; font-size: 13px; font-weight: 600;
      white-space: nowrap; cursor: pointer;
      transition: background .15s ease, color .15s ease, border-color .15s ease; }
    .tab-strip button:hover { background: var(--bg); color: var(--text); }
    .tab-strip button:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand-blue-dark) 30%, transparent); outline-offset: -3px; }
    .tab-strip button.on { background: var(--panel); border-color: var(--border); border-bottom-color: var(--panel); color: var(--text); }
    @media (max-width: 700px) { .tab-strip button { padding: 0 10px; font-size: 12px; } }
  `],
  template: `
    <div class="tab-strip" role="tablist" [attr.aria-label]="ariaLabel() || null">
      @for (t of tabs(); track t.id) {
        <button type="button" role="tab" [attr.id]="t.buttonId || null" [attr.aria-controls]="t.panelId || null"
                [class.on]="active() === t.id" [attr.aria-selected]="active() === t.id"
                (click)="choose(t, $event)">
          @if (t.icon) { <span>{{ t.icon }}</span> }
          <span>{{ t.label }}</span>
        </button>
      }
    </div>
  `,
})
export class TabStripComponent {
  tabs = input.required<TabItem[]>();
  active = input.required<string>();
  ariaLabel = input('');

  pick = output<string>();

  choose(tab: TabItem, event: Event): void {
    this.pick.emit(tab.id);
    // на узком экране дальние вкладки за краем — подтягиваем выбранную в видимую зону
    (event.currentTarget as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
