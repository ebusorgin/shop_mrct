import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { PointCard } from '../core/models';
import { httpErr } from '../core/format';
import { PointFormComponent } from '../shared/point-form.component';

@Component({
  selector: 'app-points',
  standalone: true,
  imports: [CommonModule, RouterLink, PointFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">🏬 Магазины и точки продаж</h1>
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()" title="Обновить">⟳</button>
      <button class="btn sm primary" (click)="createOpen.set(true)">+ Точка продаж</button>
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid">
      @for (p of points(); track p.id) {
        <a class="card panel" [class.off]="!p.active" [routerLink]="['/points', p.id]">
          <div class="head">
            <div class="ttl">
              <span class="dot" [class.on]="p.active" [title]="p.active ? 'активна' : 'не активна'"></span>
              <strong>{{ p.name }}</strong>
              <span class="badge blue">{{ p.code }}</span>
            </div>
            <span class="open">Открыть →</span>
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

          @if (!p.active) {
            <div class="muted small" style="font-size:11px">Точка не активна — откройте карточку, чтобы включить.</div>
          }
        </a>
      } @empty {
        <div class="panel empty-msg">Магазинов пока нет — создайте первую точку.</div>
      }
    </div>

    @if (createOpen()) {
      <app-point-form (saved)="onSaved()" (closed)="createOpen.set(false)" />
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
    .card {
      display: flex; flex-direction: column; gap: 12px; min-width: 0; margin: 0;
      color: var(--text); text-decoration: none;
      transition: border-color .15s, box-shadow .15s, transform .15s;
    }
    .card:hover { border-color: var(--accent); box-shadow: 0 8px 24px rgba(10,18,32,.10); transform: translateY(-1px); }
    .card.off { opacity: 0.62; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .ttl { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
    .ttl strong { font-size: 15px; overflow-wrap: anywhere; }
    .open { font-size: 11.5px; color: var(--accent); font-weight: 600; white-space: nowrap; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #c3ccd8; flex: 0 0 auto; }
    .dot.on { background: #2fb36b; }
    .profile { display: flex; flex-direction: column; gap: 4px; }
    .pf { display: flex; gap: 8px; font-size: 13px; }
    .pf .k { color: var(--muted); min-width: 66px; flex: 0 0 auto; }
    .pf .v { overflow-wrap: anywhere; }
    .small { font-size: 12px; }
    .empty-msg { text-align: center; color: var(--muted); grid-column: 1 / -1; }
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

  onSaved(): void {
    this.message('Сохранено');
    this.load();
  }

  private message(text: string): void {
    this.msg.set(text);
    setTimeout(() => this.msg.set(''), 3000);
  }
}
