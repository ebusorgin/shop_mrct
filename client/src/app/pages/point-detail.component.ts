import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { PointCard, PointDayOrder, PointHealth, PointTrendPoint } from '../core/models';
import { httpErr } from '../core/format';
import { PointFormComponent } from '../shared/point-form.component';
import { PointDayCardComponent, ResizeDir } from '../shared/point-day-card.component';

// ---------- генератор демонстрационных данных (детерминированный по id точки) ----------
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round = (n: number): number => Math.round(n);
const clamp = (lo: number, hi: number, v: number): number => Math.max(lo, Math.min(hi, v));

/** Захват указателя: событие может быть без активного pointerId — тогда просто без захвата. */
function capture(el: HTMLElement, ev: PointerEvent): void {
  try {
    el.setPointerCapture(ev.pointerId);
  } catch {
    /* указатель уже отпущен */
  }
}

// геометрия линейного графика
const W = 340;
const H = 120;
const PAD = 8;
function poly(vals: number[], offset: number, total: number, min: number, max: number): string {
  const span = max - min || 1;
  return vals
    .map((v, i) => {
      const x = PAD + (offset + i) * ((W - 2 * PAD) / Math.max(1, total - 1));
      const y = H - PAD - ((v - min) / span) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

interface CatSeg {
  name: string;
  value: number;
  color: string;
}
interface HeatCell {
  d: string;
  v: number;
}
interface DayCard {
  id: number;
  z: number;
  date: string;
  x: number;
  y: number;
  /** null — размер по содержимому */
  w: number | null;
  h: number | null;
  data: PointDayOrder | null;
  loading: boolean;
}

interface Stats {
  avgCost: number;
  avgPos: number;
  orders30: number;
  catalogFill: number;
  belowMinPct: number;
  deltaPct: number;
  // выручка + прогноз
  revenueA: string;
  revenueF: string;
  weekly: number[];
  forecast: number[];
  // заполненность каталога
  fillPath: string;
  fill: number[];
  // топ товаров
  top: { name: string; qty: number; pct: number }[];
  // категории
  cats: CatSeg[];
  donut: string;
  // активность по дням недели
  heat: HeatCell[];
  // прогнозы
  nextQty: number;
  nextCost: number;
  monthCost: number;
  confidence: number;
  riskMiss: number;
  // сравнение с сетью
  storeAvg: number;
  netAvg: number;
}

function buildStats(p: PointCard): Stats {
  const r = rng(p.id || 1);
  const costs = p.trend.map((t) => t.totalCost).filter((v): v is number => v !== null);
  const avgCost = costs.length ? round(mean(costs)) : 25000;
  const avgPos = p.trend.length ? Math.max(1, round(mean(p.trend.map((t) => t.positions)))) : 18;

  // 12 недель факта вокруг среднего, с лёгким трендом
  const slope = (r() - 0.5) * 0.12;
  const weekly: number[] = [];
  for (let i = 0; i < 12; i++) {
    const drift = 1 + slope * (i - 6) / 6;
    weekly.push(Math.max(1000, round(avgCost * drift * (0.8 + r() * 0.4))));
  }
  const forecast: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const prev = forecast.length ? forecast[forecast.length - 1] : weekly[11];
    forecast.push(Math.max(1000, round(prev * (1 + slope * 0.6) * (0.96 + r() * 0.1))));
  }
  const all = [...weekly, ...forecast];
  const rMin = Math.min(...all) * 0.9;
  const rMax = Math.max(...all) * 1.05;
  const revenueA = poly(weekly, 0, all.length, rMin, rMax);
  const revenueF = poly([weekly[11], ...forecast], 11, all.length, rMin, rMax);

  // заполненность каталога, %
  const fill: number[] = [];
  let f0 = 0.62 + r() * 0.2;
  for (let i = 0; i < 12; i++) {
    f0 = clamp(0.5, 0.99, f0 + (r() - 0.42) * 0.06);
    fill.push(Math.round(f0 * 100));
  }
  const fillPath = poly(fill, 0, fill.length, 40, 100);

  const names = ['Борщ', 'Сельдь с/с', 'Куриное филе', 'Оливье', 'Сырники', 'Плов', 'Гречка', 'Блины', 'Цезарь', 'Хумус'];
  const top = names
    .map((name) => ({ name, qty: 10 + round(r() * 120) }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);
  const topMax = Math.max(1, ...top.map((t) => t.qty));

  const catPal = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];
  const catNames = ['Салаты', 'Супы', 'Горячее', 'Гарниры', 'Выпечка', 'Напитки'];
  const cats: CatSeg[] = catNames.map((name, i) => ({ name, value: 5 + round(r() * 40), color: catPal[i] }));
  const catTotal = cats.reduce((s, c) => s + c.value, 0);
  let acc = 0;
  const stops: string[] = [];
  for (const c of cats) {
    const from = (acc / catTotal) * 360;
    acc += c.value;
    const to = (acc / catTotal) * 360;
    stops.push(`${c.color} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`);
  }
  const donut = `conic-gradient(${stops.join(', ')})`;

  // активность по дням недели (Ср/Сб — доставки)
  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const heat: HeatCell[] = dayNames.map((d, i) => {
    const base = i === 2 || i === 5 ? 0.7 : 0.2;
    return { d, v: clamp(0.1, 1, base + r() * 0.3) };
  });

  const last = weekly[11];
  const prev = weekly[10] || last;
  const deltaPct = prev ? Math.round(((last - prev) / prev) * 1000) / 10 : 0;

  const cv = mean(costs) ? Math.sqrt(mean(costs.map((c) => (c - mean(costs)) ** 2))) / mean(costs) : 0.2;
  const confidence = clamp(60, 95, round(94 - cv * 100));

  let riskMiss = 8;
  if (!p.active) riskMiss = 0;
  else if (p.health.badge === 'missed') riskMiss = 62;
  else if (p.health.badge === 'stale') riskMiss = 46;
  else if (p.health.badge === 'none') riskMiss = 30;

  const storeAvg = avgCost;
  const netAvg = round(avgCost * (0.82 + r() * 0.36));

  return {
    avgCost,
    avgPos,
    orders30: p.trend.length,
    catalogFill: Math.round(fill[fill.length - 1]),
    belowMinPct: 6 + round(r() * 18),
    deltaPct,
    revenueA,
    revenueF,
    weekly,
    forecast,
    fillPath,
    fill,
    top: top.map((t) => ({ ...t, pct: Math.round((t.qty / topMax) * 100) })),
    cats,
    donut,
    heat,
    nextQty: Math.max(1, round(avgPos * (1 + slope * 0.5))),
    nextCost: forecast[0],
    monthCost: forecast[0] * 8,
    confidence,
    riskMiss,
    storeAvg,
    netAvg,
  };
}

@Component({
  selector: 'app-point-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, PointFormComponent, PointDayCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <a class="btn sm" routerLink="/points">← Точки продаж</a>
      <span class="spacer"></span>
      @if (point(); as p) {
        <button class="btn sm" (click)="editOpen.set(true)" title="Изменить">✎ Изменить</button>
        @if (p.active) {
          <button class="btn sm" (click)="deactivate()" title="Деактивировать">⏻ Деактивировать</button>
        }
        <a class="btn sm" [routerLink]="['/orders', p.id]" title="Открыть заказ">🧾 Заказ</a>
        <button class="btn sm danger" (click)="remove()" title="Удалить">🗑 Удалить</button>
      }
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    @if (point(); as p) {
      <div class="hero panel">
        <div class="hero-main">
          <span class="dot" [class.on]="p.active"></span>
          <h1>{{ p.name }}</h1>
          <span class="badge blue">{{ p.code }}</span>
          <span class="badge" [class]="healthCls(p.health)">{{ healthLabel(p.health) }}</span>
        </div>
        <div class="hero-sub muted">
          @if (p.address) { {{ p.address }} }
          @if (p.phone) { · {{ p.phone }} }
          @if (p.openingHours) { · {{ p.openingHours }} }
          @if (p.health.lastOrderDate) { · посл. заказ {{ fmtDate(p.health.lastOrderDate) }} }
          @if (p.health.lastSyncAt) { · синхр. {{ when(p.health.lastSyncAt) }} }
        </div>
      </div>

      @if (s(); as st) {
        <!-- KPI -->
        <div class="kpis">
          <div class="kpi"><div class="v">{{ money(st.avgCost) }}</div><div class="l">средний заказ</div></div>
          <div class="kpi"><div class="v">{{ st.avgPos }}</div><div class="l">позиций в заказе</div></div>
          <div class="kpi"><div class="v">{{ volume().length }}</div><div class="l">доставок в периоде</div></div>
          <div class="kpi"><div class="v">{{ st.catalogFill }}%</div><div class="l">заполненность каталога</div></div>
          <div class="kpi"><div class="v">{{ st.belowMinPct }}%</div><div class="l">ниже минимума</div></div>
          <div class="kpi"><div class="v">{{ p.health.daysSince ?? '—' }}</div><div class="l">дней без заказа</div></div>
        </div>

        <div class="dash">
          <!-- факт: объём по доставкам -->
          <div class="panel">
            <div class="cap">Объём заказа по доставкам <span class="muted small">(факт из зеркала)</span></div>
            <div class="ranges">
              @for (r of ranges; track r.m) {
                <button type="button" class="rbtn" [class.on]="rangeMonths() === r.m" (click)="setRange(r.m)">{{ r.l }}</button>
              }
            </div>
            @if (volume().length) {
              <div class="bars big" [style.gap.px]="gapPx()" (mousemove)="scrub($event)" (mouseleave)="hideTip()" (click)="pin($event)">
                @for (b of barsOf(volume()); track $index) {
                  <div class="bcol" [class.on]="hasCard(b.tab)">
                    <div class="bfill" [style.height.%]="b.h"></div>
                    @if (b.show) { <div class="blab">{{ b.date }}</div> }
                  </div>
                }
              </div>
              <div class="axis" [class.one]="volume().length <= 12">
                @if (volume().length > 12) { <span>{{ tabLabel(volume()[0]) }}</span> }
                <span>{{ volume().length }} доставок · {{ rangeLabel() }}</span>
                @if (volume().length > 12) { <span>{{ tabLabel(volume()[volume().length - 1]) }}</span> }
              </div>
            } @else {
              <div class="muted small">Нет заказов за период</div>
            }
          </div>

          <!-- прогноз -->
          <div class="panel">
            <div class="cap">Прогноз <span class="badge">демо</span></div>
            <div class="fcast">
              <div class="fc"><div class="v">{{ st.nextQty }}</div><div class="l">позиций · след. заказ</div></div>
              <div class="fc"><div class="v">{{ money(st.nextCost) }}</div><div class="l">стоимость · след. заказ</div></div>
              <div class="fc"><div class="v">{{ money(st.monthCost) }}</div><div class="l">прогноз на месяц</div></div>
              <div class="fc"><div class="v">{{ st.confidence }}%</div><div class="l">уверенность модели</div></div>
            </div>
            <div class="risk">
              <div class="cap2">Риск пропуска доставки</div>
              <div class="track"><div class="fillx" [class.warn]="st.riskMiss >= 40" [style.width.%]="st.riskMiss"></div></div>
              <div class="muted small">{{ st.riskMiss }}%</div>
            </div>
          </div>

          <!-- выручка по неделям + прогноз -->
          <div class="panel">
            <div class="cap">Выручка по неделям + прогноз <span class="badge">демо</span></div>
            <svg viewBox="0 0 340 120" preserveAspectRatio="none" class="line">
              <polyline [attr.points]="st.revenueA" class="la" />
              <polyline [attr.points]="st.revenueF" class="lf" />
            </svg>
            <div class="axis"><span>12 недель назад</span><span>сейчас</span><span>+4 нед</span></div>
          </div>

          <!-- заполненность каталога -->
          <div class="panel">
            <div class="cap">Заполненность каталога, % <span class="badge">демо</span></div>
            <svg viewBox="0 0 340 120" preserveAspectRatio="none" class="line">
              <polyline [attr.points]="st.fillPath" class="la green" />
            </svg>
            <div class="axis"><span>12 недель назад</span><span>сейчас {{ st.catalogFill }}%</span></div>
          </div>

          <!-- топ товаров -->
          <div class="panel">
            <div class="cap">Топ товаров по объёму <span class="badge">демо</span></div>
            <div class="hbars">
              @for (t of st.top; track t.name) {
                <div class="hb">
                  <span class="hb-n">{{ t.name }}</span>
                  <span class="hb-track"><span class="hb-fill" [style.width.%]="t.pct"></span></span>
                  <span class="hb-v">{{ t.qty }}</span>
                </div>
              }
            </div>
          </div>

          <!-- категории -->
          <div class="panel">
            <div class="cap">Структура заказа по категориям <span class="badge">демо</span></div>
            <div class="donut-wrap">
              <div class="donut" [style.background]="st.donut"></div>
              <ul class="legend">
                @for (c of st.cats; track c.name) {
                  <li><span class="sw" [style.background]="c.color"></span>{{ c.name }} <b>{{ c.value }}</b></li>
                }
              </ul>
            </div>
          </div>

          <!-- активность по дням недели -->
          <div class="panel">
            <div class="cap">Активность по дням недели <span class="badge">демо</span></div>
            <div class="heat">
              @for (h of st.heat; track h.d) {
                <div class="hcell" [style.background]="'rgba(59,130,246,' + (0.12 + h.v * 0.7) + ')'">
                  <span class="hd">{{ h.d }}</span>
                </div>
              }
            </div>
            <div class="muted small">Ср и Сб — дни доставки</div>
          </div>

          <!-- сравнение с сетью -->
          <div class="panel">
            <div class="cap">Сравнение с сетью <span class="badge">демо</span></div>
            <div class="cmp">
              <div class="cmp-row"><span class="cmp-n">Эта точка</span><span class="cmp-track"><span class="cmp-fill" [style.width.%]="100"></span></span><span class="cmp-v">{{ money(st.storeAvg) }}</span></div>
              <div class="cmp-row"><span class="cmp-n">Среднее по сети</span><span class="cmp-track"><span class="cmp-fill grey" [style.width.%]="pct(st.netAvg, st.storeAvg)"></span></span><span class="cmp-v">{{ money(st.netAvg) }}</span></div>
            </div>
            <div class="muted small">
              {{ st.storeAvg >= st.netAvg ? 'Выше' : 'Ниже' }} среднего на {{ pct(abs(st.storeAvg - st.netAvg), st.netAvg) }}%
            </div>
          </div>

          <!-- профиль -->
          <div class="panel">
            <div class="cap">Профиль точки</div>
            <div class="info">
              <div><span class="k">Адрес</span><span>{{ p.address || '—' }}</span></div>
              <div><span class="k">Телефон</span><span>{{ p.phone || '—' }}</span></div>
              <div><span class="k">Контакт</span><span>{{ p.contactPerson || '—' }}</span></div>
              <div><span class="k">Email</span><span>{{ p.email || '—' }}</span></div>
              <div><span class="k">Режим</span><span>{{ p.openingHours || '—' }}</span></div>
              <div><span class="k">Порядок</span><span>{{ p.position }}</span></div>
              @if (p.note) { <div class="wide"><span class="k">Заметка</span><span>{{ p.note }}</span></div> }
            </div>
          </div>
        </div>
      }
    } @else if (!err()) {
      <div class="muted">Загрузка…</div>
    }

    <!-- закреплённые карточки: тянутся мышью, ресайзятся за края/углы -->
    @for (c of cards(); track c.id) {
      <app-point-day-card
        class="tip pin"
        [class.dragging]="draggingId() === c.id"
        [class.sized]="c.h !== null"
        [date]="c.date"
        [data]="c.data"
        [loading]="c.loading"
        [pinned]="true"
        [selected]="selection()"
        [style.left.px]="c.x"
        [style.top.px]="c.y"
        [style.width.px]="c.w"
        [style.height.px]="c.h"
        [style.z-index]="c.z"
        (closed)="closeCard(c.id)"
        (picked)="toggleLine($event)"
        (pointerdown)="dragStart($event, c)"
        (pointermove)="cardMove($event)"
        (pointerup)="cardUp()"
        (pointercancel)="cardUp()"
        (wheel)="onTipWheel($event)"
        (resizeStart)="onResizeStart($event.ev, c, $event.dir)" />
    }

    <!-- превью при наведении -->
    @if (hover(); as t) {
      <app-point-day-card
        class="tip"
        [date]="t.date"
        [data]="hoverData()"
        [loading]="hoverLoading()"
        [selected]="selection()"
        [style.left.px]="t.x"
        [style.top.px]="t.y" />
    }

    @if (editOpen() && point()) {
      <app-point-form [point]="point()" (saved)="onSaved()" (closed)="editOpen.set(false)" />
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .hero { margin-bottom: 14px; }
    .hero-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .hero-main h1 { margin: 0; font-size: 20px; overflow-wrap: anywhere; }
    .hero-sub { margin-top: 6px; font-size: 13px; overflow-wrap: anywhere; }
    .dot { width: 11px; height: 11px; border-radius: 50%; background: #c3ccd8; flex: 0 0 auto; }
    .dot.on { background: #2fb36b; }
    .dash { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .dash .panel { min-width: 0; }
    .cap { font-weight: 600; font-size: 14px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .small { font-size: 12px; }
    .ranges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
    .rbtn { appearance: none; border: 1px solid var(--border); background: #fff; color: inherit; font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
    .rbtn.on { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    /* карточки заказа (.tip*) живут в app-point-day-card */
    .bars { display: flex; align-items: flex-end; gap: 5px; overflow: hidden; }
    .bars.big { height: 120px; cursor: pointer; }
    .bcol { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; min-width: 0; }
    .bcol.on .bfill { background: linear-gradient(#1d4ed8, #60a5fa); }
    .bfill { width: 100%; max-width: 26px; background: linear-gradient(#3b82f6, #60a5fa); border-radius: 3px 3px 0 0; min-height: 2px; }
    .blab { font-size: 9px; color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; max-width: 100%; }
    .fcast { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .fc { background: var(--bg, #f6f8fb); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
    .fc .v { font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
    .fc .l { font-size: 11px; color: var(--muted); }
    .risk { margin-top: 12px; }
    .cap2 { font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .track { height: 10px; background: #eef2f7; border-radius: 6px; overflow: hidden; margin-bottom: 4px; }
    .fillx { height: 100%; width: 0; background: #22c55e; border-radius: 6px; }
    .fillx.warn { background: #ef4444; }
    svg.line { width: 100%; height: 130px; display: block; }
    svg.line .la { fill: none; stroke: #3b82f6; stroke-width: 2.2; vector-effect: non-scaling-stroke; }
    svg.line .la.green { stroke: #22c55e; }
    svg.line .lf { fill: none; stroke: #f59e0b; stroke-width: 2.2; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
    .axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 4px; }
    .axis.one { justify-content: center; }
    .hbars { display: flex; flex-direction: column; gap: 8px; }
    .hb { display: grid; grid-template-columns: 96px 1fr 40px; align-items: center; gap: 8px; font-size: 12px; }
    .hb-n { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-track { height: 10px; background: #eef2f7; border-radius: 6px; overflow: hidden; }
    .hb-fill { display: block; height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 6px; }
    .hb-v { text-align: right; font-variant-numeric: tabular-nums; }
    .donut-wrap { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .donut { width: 120px; height: 120px; border-radius: 50%; -webkit-mask: radial-gradient(circle 42px at center, transparent 98%, #000 100%); mask: radial-gradient(circle 42px at center, transparent 98%, #000 100%); flex: 0 0 auto; }
    .legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; font-size: 12px; }
    .legend li { display: flex; align-items: center; gap: 7px; }
    .legend b { margin-left: auto; font-variant-numeric: tabular-nums; }
    .sw { width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; }
    .heat { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-bottom: 8px; }
    .hcell { aspect-ratio: 1 / 1; border-radius: 8px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 5px; }
    .hd { font-size: 11px; color: #1e3a5f; }
    .cmp { display: flex; flex-direction: column; gap: 10px; }
    .cmp-row { display: grid; grid-template-columns: 120px 1fr 90px; align-items: center; gap: 8px; font-size: 12px; }
    .cmp-n { color: var(--muted); }
    .cmp-track { height: 12px; background: #eef2f7; border-radius: 6px; overflow: hidden; }
    .cmp-fill { display: block; height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 6px; }
    .cmp-fill.grey { background: #c3ccd8; }
    .cmp-v { text-align: right; font-variant-numeric: tabular-nums; }
    .info { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; font-size: 13px; }
    .info > div { display: flex; gap: 8px; }
    .info .k { color: var(--muted); min-width: 72px; flex: 0 0 auto; }
    .info .wide { grid-column: 1 / -1; }
    @media (max-width: 900px) { .dash { grid-template-columns: 1fr; } }
    @media (max-width: 520px) {
      .fcast { grid-template-columns: 1fr; }
      .info { grid-template-columns: 1fr; }
      .hb { grid-template-columns: 80px 1fr 34px; }
      .cmp-row { grid-template-columns: 92px 1fr 72px; }
      .blab { font-size: 8px; }
    }
    `,
  ],
})
export class PointDetailComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  point = signal<PointCard | null>(null);
  err = signal('');
  msg = signal('');
  editOpen = signal(false);
  volume = signal<PointTrendPoint[]>([]);
  rangeMonths = signal(1);
  ranges = [
    { m: 1, l: '1 мес' },
    { m: 3, l: '3 мес' },
    { m: 6, l: '6 мес' },
    { m: 12, l: '1 год' },
    { m: 0, l: 'всё' },
  ];
  /** Превью при наведении (не закреплено, не перехватывает мышь). */
  hover = signal<{ date: string; x: number; y: number } | null>(null);
  hoverData = signal<PointDayOrder | null>(null);
  hoverLoading = signal(false);
  /** Открытые карточки: их можно таскать, растягивать и закрывать по одной. */
  cards = signal<DayCard[]>([]);
  /** Выделенные позиции (id товара) — общие для всех открытых карточек. */
  selection = signal<ReadonlySet<number>>(new Set());
  draggingId = signal<number | null>(null);
  private cardSeq = 0;
  private zTop = 60;
  /** После клика превью не показываем, пока мышь не уйдёт с графика. */
  private suppressHover = false;
  private dayCache = new Map<string, PointDayOrder | null>();
  private dayWaiters = new Map<string, ((d: PointDayOrder | null) => void)[]>();
  private drag: { id: number; px: number; py: number; x: number; y: number } | null = null;
  private rez: { id: number; dir: string; px: number; py: number; x: number; y: number; w: number; h: number } | null = null;
  s = computed<Stats | null>(() => {
    const p = this.point();
    return p ? buildStats(p) : null;
  });

  ngOnInit(): void {
    this.load();
  }

  private id(): number {
    return Number(this.route.snapshot.paramMap.get('id'));
  }

  load(): void {
    this.err.set('');
    this.api.point$(this.id()).subscribe({
      next: (v) => {
        this.point.set(v);
        this.loadVolume(this.rangeMonths());
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  onSaved(): void {
    this.msg.set('Сохранено');
    setTimeout(() => this.msg.set(''), 3000);
    this.load();
  }

  loadVolume(months: number): void {
    this.api.pointVolume$(this.id(), months).subscribe({
      next: (v) => this.volume.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  setRange(months: number): void {
    this.cards.set([]);
    this.selection.set(new Set());
    this.hover.set(null);
    this.rangeMonths.set(months);
    this.loadVolume(months);
  }

  rangeLabel(): string {
    return this.ranges.find((r) => r.m === this.rangeMonths())?.l ?? '';
  }

  // ---------- карточки заказа на графике ----------

  /** Наведение на график — превью заказа за день под курсором. */
  scrub(ev: MouseEvent): void {
    if (this.suppressHover) return;
    const b = this.barAt(ev);
    if (!b) return;
    const pos = this.place(ev.clientX, ev.clientY, 340, 300);
    const same = this.hover()?.date === b.tab;
    this.hover.set({ date: b.tab, x: pos.x, y: pos.y });
    if (same) return;
    const cached = this.dayCache.get(b.tab);
    if (cached !== undefined) {
      this.hoverData.set(cached);
      this.hoverLoading.set(false);
      return;
    }
    this.hoverData.set(null);
    this.hoverLoading.set(true);
    this.loadDay(b.tab, (d) => {
      if (this.hover()?.date !== b.tab) return;
      this.hoverData.set(d);
      this.hoverLoading.set(false);
    });
  }

  /** Клик по столбцу открывает ещё одну карточку — прежние остаются. */
  pin(ev: MouseEvent): void {
    const b = this.barAt(ev);
    if (!b) return;
    this.suppressHover = true;
    this.hover.set(null);
    this.openCard(b.tab, ev.clientX, ev.clientY);
  }

  /** Уход мыши с графика: превью прячется. */
  hideTip(): void {
    this.suppressHover = false;
    this.hover.set(null);
  }

  hasCard(date: string): boolean {
    return this.cards().some((c) => c.date === date);
  }

  closeCard(id: number): void {
    this.cards.update((l) => l.filter((c) => c.id !== id));
    this.dropSelectionIfIdle();
  }

  /** Клик по позиции: выделение живёт во всех карточках и снимается кликом по ней же. */
  toggleLine(id: number): void {
    const next = new Set(this.selection());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selection.set(next);
  }

  /**
   * Колесо над карточкой не уходит в страницу:
   * список позиций скроллится сам, остальное гасим.
   */
  onTipWheel(ev: WheelEvent): void {
    const sc = (ev.currentTarget as HTMLElement).querySelector('.tip-scroll') as HTMLElement | null;
    if (!sc || sc.scrollHeight <= sc.clientHeight + 1) {
      ev.preventDefault();
      return;
    }
    // курсор не над списком (шапка/итог) — прокручиваем список сами
    if (!sc.contains(ev.target as Node)) {
      ev.preventDefault();
      sc.scrollTop += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    }
  }

  /** Клик вне карточек и вне графика закрывает все карточки. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.cards().length) return;
    const el = ev.target as HTMLElement | null;
    if (el && (el.closest('.tip') || el.closest('.bars'))) return;
    this.cards.set([]);
    this.dropSelectionIfIdle();
  }

  private dropSelectionIfIdle(): void {
    if (!this.cards().length) this.selection.set(new Set());
  }

  // ---------- перетаскивание и ресайз ----------

  dragStart(ev: PointerEvent, c: DayCard): void {
    const t = ev.target as HTMLElement;
    if (t.closest('.tip-scroll') || t.closest('button') || t.closest('.rz')) return;
    capture(ev.currentTarget as HTMLElement, ev);
    this.drag = { id: c.id, px: ev.clientX, py: ev.clientY, x: c.x, y: c.y };
    this.draggingId.set(c.id);
    this.raise(c.id);
    ev.preventDefault();
  }

  onResizeStart(ev: PointerEvent, c: DayCard, dir: ResizeDir): void {
    const host = (ev.target as HTMLElement).closest('app-point-day-card') as HTMLElement | null;
    if (!host) return;
    const box = host.getBoundingClientRect();
    capture(ev.target as HTMLElement, ev);
    this.rez = { id: c.id, dir, px: ev.clientX, py: ev.clientY, x: c.x, y: c.y, w: Math.round(box.width), h: Math.round(box.height) };
    this.draggingId.set(c.id);
    this.raise(c.id);
    ev.preventDefault();
    ev.stopPropagation();
  }

  cardMove(ev: PointerEvent): void {
    if (this.rez) return this.resizeTo(ev);
    if (this.drag) return this.moveTo(ev);
  }

  cardUp(): void {
    this.drag = null;
    this.rez = null;
    this.draggingId.set(null);
  }

  private moveTo(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const c = this.cards().find((x) => x.id === d.id);
    if (!c) return;
    const w = c.w ?? 340;
    const h = c.h ?? 300;
    const x = clamp(0, Math.max(0, window.innerWidth - w), d.x + (ev.clientX - d.px));
    const y = clamp(0, Math.max(0, window.innerHeight - h), d.y + (ev.clientY - d.py));
    this.patchCard(c.id, { x, y });
  }

  private resizeTo(ev: PointerEvent): void {
    const r = this.rez;
    if (!r) return;
    const dx = ev.clientX - r.px;
    const dy = ev.clientY - r.py;
    let x = r.x;
    let y = r.y;
    let w = r.w;
    let h = r.h;
    if (r.dir.includes('e')) w = Math.max(240, r.w + dx);
    if (r.dir.includes('s')) h = Math.max(140, r.h + dy);
    if (r.dir.includes('w')) { w = Math.max(240, r.w - dx); x = r.x + (r.w - w); }
    if (r.dir.includes('n')) { h = Math.max(140, r.h - dy); y = r.y + (r.h - h); }
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    w = Math.min(w, window.innerWidth - x);
    h = Math.min(h, window.innerHeight - y);
    this.patchCard(r.id, { x, y, w, h });
  }

  private raise(id: number): void {
    this.patchCard(id, { z: ++this.zTop });
  }

  private openCard(date: string, x: number, y: number): void {
    const existing = this.cards().find((c) => c.date === date);
    if (existing) {
      // за этот день уже открыта — просто поднимаем её наверх
      this.raise(existing.id);
      return;
    }
    // каждая следующая карточка чуть смещается, чтобы не лечь ровно на предыдущую
    const shift = (this.cards().length % 5) * 18;
    const pos = this.place(x + shift, y + shift, 340, 300);
    const cached = this.dayCache.get(date);
    const card: DayCard = {
      id: ++this.cardSeq,
      z: ++this.zTop,
      date,
      x: pos.x,
      y: pos.y,
      w: null,
      h: null,
      data: cached ?? null,
      loading: cached === undefined,
    };
    this.cards.update((l) => [...l, card]);
    if (card.loading) {
      this.loadDay(date, (d) => this.patchCard(card.id, { data: d, loading: false }));
    }
  }

  private patchCard(id: number, patch: Partial<DayCard>): void {
    this.cards.update((l) => l.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  /** Позиция всплывашки у курсора с прижатием к краям экрана. */
  private place(x: number, y: number, w: number, h: number): { x: number; y: number } {
    let px = x + 14;
    let py = y + 14;
    if (px + w > window.innerWidth - 8) px = Math.max(8, x - w - 14);
    if (py + h > window.innerHeight - 8) py = Math.max(8, y - h - 14);
    return { x: px, y: py };
  }

  private barAt(ev: MouseEvent): { tab: string } | null {
    const el = ev.currentTarget as HTMLElement;
    const bars = this.barsOf(this.volume());
    if (!bars.length) return null;
    const r = el.getBoundingClientRect();
    const idx = Math.min(bars.length - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / Math.max(1, r.width)) * bars.length)));
    return bars[idx];
  }

  /** Заказ за день: кеш + дедупликация параллельных запросов. */
  private loadDay(date: string, apply: (d: PointDayOrder | null) => void): void {
    const cached = this.dayCache.get(date);
    if (cached !== undefined) {
      apply(cached);
      return;
    }
    const waiters = this.dayWaiters.get(date);
    if (waiters) {
      waiters.push(apply);
      return;
    }
    this.dayWaiters.set(date, [apply]);
    const done = (d: PointDayOrder | null): void => {
      this.dayCache.set(date, d);
      const list = this.dayWaiters.get(date) ?? [];
      this.dayWaiters.delete(date);
      for (const cb of list) cb(d);
    };
    this.api.pointDay$(this.id(), date).subscribe({
      next: (d) => done(d),
      error: () => done(null),
    });
  }

  deactivate(): void {
    const p = this.point();
    if (!p) return;
    if (!confirm(`Деактивировать «${p.name}»? История заказов сохранится.`)) return;
    this.api.deactivatePoint(p.id).subscribe({
      next: () => this.onSaved(),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  remove(): void {
    const p = this.point();
    if (!p) return;
    if (!confirm(`Удалить точку «${p.name}» навсегда? Это нельзя отменить.`)) return;
    this.api.deletePoint(p.id).subscribe({
      next: () => this.router.navigate(['/points']),
      error: (e) => {
        const m = httpErr(e);
        this.err.set(/заказ/i.test(m) ? `${m}. Можно деактивировать точку вместо удаления.` : m);
      },
    });
  }

  barsOf(series: PointTrendPoint[]): { tab: string; date: string; h: number; val: string; show: boolean }[] {
    if (!series.length) return [];
    const useCost = series.some((t) => t.totalCost !== null);
    const vals = series.map((t) => (useCost ? t.totalCost ?? 0 : t.positions));
    const max = Math.max(1, ...vals);
    const n = series.length;
    return series.map((t, i) => ({
      tab: t.tabDate,
      date: t.tabDate.slice(5).replace('-', '.'),
      h: Math.max(2, Math.round((vals[i] / max) * 100)),
      val: useCost ? `${Math.round(t.totalCost ?? 0)} ₽` : `${t.positions} поз`,
      show: n <= 12,
    }));
  }

  /** Зазор между столбцами: чем больше доставок в диапазоне, тем плотнее. */
  gapPx(): number {
    const n = this.volume().length;
    return n > 60 ? 0 : n > 24 ? 1 : 5;
  }

  tabLabel(t: PointTrendPoint | undefined): string {
    return t ? t.tabDate.slice(5).replace('-', '.') : '—';
  }

  pct(a: number, b: number): number {
    return clamp(0, 100, Math.round((a / Math.max(1, b)) * 100));
  }

  abs(n: number): number {
    return Math.abs(n);
  }

  money(n: number): string {
    return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
  }

  healthCls(h: PointHealth): string {
    return ({ ok: 'green', missed: 'red', stale: 'amber', none: '', inactive: '' } as Record<string, string>)[h.badge] ?? '';
  }

  healthLabel(h: PointHealth): string {
    switch (h.badge) {
      case 'ok': return 'работает';
      case 'missed': return 'пропустил доставку';
      case 'stale': return `нет заказов ${h.daysSince ?? 0} дн`;
      case 'none': return 'заказов ещё не было';
      case 'inactive': return 'не активна';
      default: return h.badge;
    }
  }

  fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const p = (x: number) => String(x).padStart(2, '0');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  when(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}
