import { Directive, ElementRef, HostListener, Input, OnDestroy, inject } from '@angular/core';

/**
 * Всплывающая подсказка «?» поверх всего интерфейса.
 * Рисуется в document.body, поэтому не обрезается модалками и панелями с overflow.
 */
@Directive({
  selector: '[appHint]',
  standalone: true,
})
export class HintDirective implements OnDestroy {
  /** Текст подсказки. */
  @Input('appHint') body = '';
  /** Заголовок подсказки. */
  @Input() hintTitle = '';

  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private tip: HTMLDivElement | null = null;

  @HostListener('mouseenter')
  @HostListener('focus')
  show(): void {
    this.hide();
    if (!this.body) return;
    const tip = document.createElement('div');
    tip.className = 'app-hint-pop';
    if (this.hintTitle) {
      const b = document.createElement('b');
      b.textContent = this.hintTitle;
      tip.appendChild(b);
    }
    const text = document.createElement('span');
    text.textContent = this.body;
    tip.appendChild(text);

    const width = Math.min(300, window.innerWidth - 16);
    tip.style.width = width + 'px';
    document.body.appendChild(tip);

    const r = this.host.nativeElement.getBoundingClientRect();
    const h = tip.offsetHeight;
    let left = r.right - width;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = r.top - h - 8;
    top = Math.max(8, top);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    this.tip = tip;
  }

  @HostListener('mouseleave')
  @HostListener('blur')
  hide(): void {
    this.tip?.remove();
    this.tip = null;
  }

  /** Кнопка внутри label не должна открывать поле, к которому привязана. */
  @HostListener('click', ['$event'])
  onClick(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
  }

  @HostListener('window:scroll')
  @HostListener('window:resize')
  onViewportChange(): void {
    this.hide();
  }

  ngOnDestroy(): void {
    this.hide();
  }
}
