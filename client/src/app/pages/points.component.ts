import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { PointCard, PointHealth } from '../core/models';
import { httpErr } from '../core/format';
import { PointFormComponent } from '../shared/point-form.component';

@Component({
  selector: 'app-points',
  standalone: true,
  imports: [CommonModule, RouterLink, PointFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">🏪 Точки продаж</h1>
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()">⟳</button>
      <button class="btn sm primary" (click)="createOpen.set(true)">+ Точка продаж</button>
    </div>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid">
      @for (p of points(); track p.id) {
        <a class="card panel" [routerLink]="['/points', p.id]" [class.off]="!p.active">
          <div class="head">
            <div class="ttl">
              <span class="dot" [class.on]="p.active" [title]="p.active ? 'активна' : 'не активна'"></span>
              <strong>{{ p.name }}</strong>
              <span class="badge blue">{{ p.code }}</span>
            </div>
            <span class="go" aria-hidden="true">→</span>
          </div>

          <div class="profile">
            @if (p.address) { <div class="pf"><span class="k">Адрес</span><span class="v">{{ p.address }}</span></div> }
            @if (p.phone) { <div class="pf"><span class="k">Телефон</span><span class="v">{{ p.phone }}</span></div> }
            @if (p.contactPerson) { <div class="pf"><span class="k">Контакт</span><span class="v">{{ p.contactPerson }}</span></div> }
            @if (p.openingHours) { <div class="pf"><span class="k">Режим</span><span class="v">{{ p.openingHours }}</span></div> }
            @if (!p.address && !p.phone && !p.contactPerson && !p.openingHours) {
              <div class="muted small">Профиль не заполнен</div>
            }
          </div>

          <div class="health">
            <span class="badge" [class]="healthCls(p.health)">{{ healthLabel(p.health) }}</span>
            @if (p.health.lastOrderDate) {
              <span class="muted small">посл. заказ {{ fmtDate(p.health.lastOrderDate) }}</span>
            }
          </div>

          <div class="trend">
            <div class="trend-cap"><span class="muted small">Объём заказа по доставкам</span></div>
            @if (p.trend.length) {
              <div class="bars">
                @for (b of bars(p); track b.date) {
                  <div class="bcol" [title]="b.date + ': ' + b.val">
                    <div class="bfill" [style.height.%]="b.h"></div>
                    <div class="blab">{{ b.date }}</div>
                  </div>
                }
              </div>
            } @else {
              <div class="muted small">Нет заказов в зеркале</div>
            }
          </div>
        </a>
      } @empty {
        <div class="panel empty-msg">Точек пока нет — создайте первую.</div>
      }
    </div>

    @if (createOpen()) {
      <app-point-form (saved)="onCreated()" (closed)="createOpen.set(false)" />
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
    a.card { display: flex; flex-direction: column; gap: 12px; min-width: 0; text-decoration: none; color: inherit; cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .15s; }
    a.card:hover { border-color: var(--accent); box-shadow: 0 8px 24px rgba(10,18,32,.10); transform: translateY(-1px); }
    a.card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .card.off { opacity: 0.62; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .ttl { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
    .ttl strong { font-size: 15px; overflow-wrap: anywhere; }
    .go { color: var(--muted); font-size: 15px; flex: 0 0 auto; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #c3ccd8; flex: 0 0 auto; }
    .dot.on { background: #2fb36b; }
    .profile { display: flex; flex-direction: column; gap: 4px; }
    .pf { display: flex; gap: 8px; font-size: 13px; }
    .pf .k { color: var(--muted); min-width: 66px; flex: 0 0 auto; }
    .pf .v { overflow-wrap: anywhere; }
    .health { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .small { font-size: 12px; }
    .trend { display: flex; flex-direction: column; gap: 6px; }
    .trend-cap { display: flex; justify-content: space-between; }
    .bars { display: flex; align-items: flex-end; gap: 4px; height: 54px; }
    .bcol { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; min-width: 0; }
    .bfill { width: 100%; max-width: 22px; background: linear-gradient(#3b82f6, #60a5fa); border-radius: 3px 3px 0 0; min-height: 2px; }
    .blab { font-size: 9px; color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; max-width: 100%; }
    .empty-msg { text-align: center; color: var(--muted); grid-column: 1 / -1; }
    @media (max-width: 420px) {
      .bars { gap: 3px; }
      .blab { font-size: 8px; }
    }
    `,
  ],
})
export class PointsComponent implements OnInit {
  private api = inject(ApiService);

  points = signal<PointCard[]>([]);
  err = signal('');
  msg = signal('');
  createOpen = signal(false);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.err.set('');
    this.api.points$().subscribe({
      next: (v) => this.points.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  onCreated(): void {
    this.msg.set('Точка создана');
    setTimeout(() => this.msg.set(''), 3000);
    this.load();
  }

  healthCls(h: PointHealth): string {
    return (
      {
        ok: 'green',
        missed: 'red',
        stale: 'amber',
        none: '',
        inactive: '',
      } as Record<string, string>
    )[h.badge] ?? '';
  }

  healthLabel(h: PointHealth): string {
    switch (h.badge) {
      case 'ok':
        return 'работает';
      case 'missed':
        return 'пропустил доставку';
      case 'stale':
        return `нет заказов ${h.daysSince ?? 0} дн`;
      case 'none':
        return 'заказов ещё не было';
      case 'inactive':
        return 'не активна';
      default:
        return h.badge;
    }
  }

  bars(p: PointCard): { date: string; h: number; val: string }[] {
    const useCost = p.trend.some((t) => t.totalCost !== null);
    const vals = p.trend.map((t) => (useCost ? t.totalCost ?? 0 : t.positions));
    const max = Math.max(1, ...vals);
    return p.trend.map((t, i) => ({
      date: t.tabDate.slice(5).replace('-', '.'),
      h: Math.max(3, Math.round((vals[i] / max) * 100)),
      val: useCost ? `${Math.round(t.totalCost ?? 0)} ₽` : `${t.positions} поз`,
    }));
  }

  fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const p = (x: number) => String(x).padStart(2, '0');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
}
