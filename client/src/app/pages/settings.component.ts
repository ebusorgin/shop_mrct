import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, finalize } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService } from '../core/api.service';
import { AppSettings, DeliveryRule, GoogleSheet, GptTestResult, ProductCatalog, RawCategory, TechCard } from '../core/models';
import { fmtQty, httpErr } from '../core/format';
import { packagingLabel } from '../core/packaging-label';
import { PasswordFormComponent } from '../shared/password-form.component';
import { PickOption, PickerComponent } from '../shared/picker.component';

interface DeliveryDay {
  date: string;
  number: number;
  label: string;
  weekend: boolean;
}

function calendarDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Сдвиг календарной даты через UTC: без наложения поясов и перевода часов. */
function shiftCalendarDate(value: string, days: number): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
      : value;
}

/** Разделы верхнего меню настроек. */
type SettingsTab = 'delivery' | 'gpt' | 'categories' | 'catalogs' | 'excel';

/** Тот же признак, что считает сервер: чем именно дата покрыта правилом. */
type RuleKind = 'week' | 'month' | 'both';

function ruleDayKind(date: string, weekdays: number[], monthDays: number[]): RuleKind | null {
  const day = new Date(`${date}T00:00:00Z`);
  const weekly = weekdays.includes(day.getUTCDay() || 7);
  const monthly = monthDays.includes(day.getUTCDate());
  if (weekly && monthly) return 'both';
  return weekly ? 'week' : monthly ? 'month' : null;
}

/** Совпадения правила ИЛИ за окно; прошлое отсечено, сегодня ещё считается. Только предпросмотр. */
function ruleMatches(from: string, to: string, weekdays: number[], monthDays: number[], today: string): { date: string; kind: RuleKind }[] {
  const out: { date: string; kind: RuleKind }[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= end; time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    const kind = date >= today ? ruleDayKind(date, weekdays, monthDays) : null;
    if (kind) out.push({ date, kind });
  }
  return out;
}
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe, PasswordFormComponent, PickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cat-badge { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:8px; margin-right:8px; font-size:15px; line-height:1; vertical-align:middle; }
    .pc-icon { width:150px; }
    .pc-color { width:46px; height:34px; padding:2px; }
    /* ---------- блок «Доставки»: шапка, вкладки, календарь, правило ---------- */
    .delivery-head, .delivery-nav, .delivery-footer, .delivery-legend, .delivery-summary { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .delivery-head { justify-content:space-between; margin-bottom:18px; }
    .delivery-head h2 { font-size:19px; margin:0 0 6px; letter-spacing:-.02em; }
    .delivery-head p { margin:0; font-size:13px; color:var(--muted); }
    .delivery-summary { gap:8px; }
    .delivery-tabs { margin:0 0 18px; padding:4px; gap:4px; border:1px solid var(--border); border-radius:12px; background:var(--bg); }
    .delivery-tabs button { flex:1 1 auto; min-height:38px; padding:0 14px; border:0; border-radius:8px; background:transparent; color:var(--muted); font-size:13px; }
    .delivery-tabs button.on { background:var(--brand-blue-dark); color:#fff; box-shadow:0 2px 6px rgba(0,102,153,.22); }
    .delivery-nav { margin-bottom:14px; gap:8px; }
    .delivery-nav .btn { min-height:38px; justify-content:center; }
    .delivery-arrow { width:38px; padding:6px; font-size:18px; }
    .delivery-range { margin-right:auto; font-size:13px; font-weight:600; color:var(--muted); }
    .delivery-months { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:20px; }
    .delivery-month { min-width:0; border:1px solid var(--border); border-radius:12px; background:var(--panel); padding:16px 12px; }
    .delivery-month-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border); }
    .delivery-month h3 { margin:0; font-size:15px; font-weight:700; text-transform:capitalize; }
    .delivery-month-head span { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .delivery-grid { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:4px; }
    .delivery-weekday { padding:0 0 10px; text-align:center; color:var(--muted); font-size:11px; font-weight:600; }
    .delivery-day { position:relative; min-width:0; height:40px; padding:0; border:1px solid transparent; border-radius:7px; background:transparent; color:var(--text); font:inherit; font-size:13px; font-variant-numeric:tabular-nums; cursor:pointer; transition:background .12s ease,border-color .12s ease; }
    .delivery-day.weekend { background:var(--bg); color:var(--muted); }
    .delivery-day:hover:not(:disabled) { border-color:var(--brand-blue-dark); }
    .delivery-day:hover:not(.rule):not(:disabled) { background:var(--accent-soft); }
    .delivery-day.today { border-color:var(--brand-blue-dark); font-weight:700; }
    .delivery-day.selected { background:var(--brand-blue-dark); color:white; font-weight:700; box-shadow:0 2px 5px rgba(15,23,42,.12); }
    .delivery-day.selected:hover:not(.rule):not(:disabled) { background:var(--brand-blue-dark); box-shadow:inset 0 0 0 2px var(--brand-yellow); }
    /* источники дня: ручная отметка, правило недели, правило месяца. Совпадения делят клетку полосами */
    .delivery-day.rule { font-weight:700; box-shadow:none; }
    .delivery-day.rule-week { border-color:var(--green); background:var(--green-soft); color:var(--green); }
    .delivery-day.rule-month { border-color:var(--amber); background:var(--amber-soft); color:var(--amber); }
    .delivery-day.rule-both { border-color:var(--green); color:var(--text); background:linear-gradient(135deg, var(--green-soft) 0 50%, var(--amber-soft) 50% 100%); box-shadow:inset 0 0 0 1px var(--amber); }
    .delivery-day.selected.rule { color:var(--text); }
    .delivery-day.selected.rule-week { background:linear-gradient(135deg, var(--accent-soft) 0 50%, var(--green-soft) 50% 100%); }
    .delivery-day.selected.rule-month { background:linear-gradient(135deg, var(--accent-soft) 0 50%, var(--amber-soft) 50% 100%); }
    .delivery-day.selected.rule-both { background:linear-gradient(135deg, var(--accent-soft) 0 33.4%, var(--green-soft) 33.4% 66.7%, var(--amber-soft) 66.7% 100%); box-shadow:none; }
    .delivery-day.selected.rule svg { color:var(--brand-blue-dark); }
    .delivery-day.rule:disabled { opacity:1; }
    .delivery-day svg { position:absolute; top:3px; right:3px; width:9px; height:9px; }
    .delivery-day:disabled { opacity:.45; cursor:wait; }
    .delivery-day.locked { opacity:.6; cursor:not-allowed; }
    .delivery-day.pending { background:var(--accent-soft); }
    .delivery-day:focus-visible, .delivery-nav .btn:focus-visible, .delivery-tabs button:focus-visible, .rule-chip:focus-visible { outline:3px solid var(--brand-blue-dark); outline-offset:2px; }
    .delivery-footer { justify-content:space-between; border-top:1px solid var(--border); margin-top:18px; padding-top:14px; font-size:12px; color:var(--muted); gap:14px; }
    .delivery-legend span { display:inline-flex; align-items:center; gap:6px; }
    .delivery-swatch { width:14px; height:14px; border-radius:4px; display:inline-block; }
    .delivery-swatch.selected { background:var(--brand-blue-dark); }
    .delivery-swatch.today { border:1px solid var(--brand-blue-dark); }
    .delivery-swatch.rule-week { border:1px solid var(--green); background:var(--green-soft); }
    .delivery-swatch.rule-month { border:1px solid var(--amber); background:var(--amber-soft); }
    .delivery-swatch.rule-both { border:1px solid var(--green); background:linear-gradient(135deg, var(--green-soft) 0 50%, var(--amber-soft) 50% 100%); box-shadow:inset 0 0 0 1px var(--amber); }
    .delivery-swatch.selected.rule-week { border:1px solid var(--brand-blue-dark); background:linear-gradient(135deg, var(--accent-soft) 0 50%, var(--green-soft) 50% 100%); }
    .delivery-swatch.selected.rule-both { border:1px solid var(--brand-blue-dark); background:linear-gradient(135deg, var(--accent-soft) 0 33.4%, var(--green-soft) 33.4% 66.7%, var(--amber-soft) 66.7% 100%); box-shadow:none; }
    .delivery-status { min-height:18px; text-align:right; }
    .delivery-error { display:flex; align-items:center; gap:12px; justify-content:space-between; }

    /* ---------- вкладки правила ---------- */
    .rule-panel { padding:18px; border:1px solid var(--border); border-left:3px solid var(--brand-blue-dark); border-radius:12px; background:var(--bg); }
    .rule-panel h3 { margin:0 0 6px; font-size:16px; }
    .rule-panel > p { max-width:760px; margin:0 0 16px; color:var(--muted); font-size:12px; line-height:1.55; }
    .rule-chips { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:8px; max-width:560px; }
    .rule-chips-month { grid-template-columns:repeat(auto-fill, minmax(58px, 1fr)); max-width:none; }
    .rule-chip { min-width:0; min-height:40px; padding:4px; border:1px solid var(--border); border-radius:8px; background:var(--panel); color:var(--text); font:inherit; font-variant-numeric:tabular-nums; cursor:pointer; transition:background .12s ease,border-color .12s ease; }
    .rule-chip.active { background:var(--brand-blue-dark); border-color:var(--brand-blue-dark); color:#fff; font-weight:600; }
    .rule-chip:hover:not(:disabled) { border-color:var(--brand-blue-dark); }
    .rule-chip:disabled { opacity:.6; cursor:wait; }
    /* цвет чипов повторяет цвет этих дат в календаре: неделя — зелёный, месяц — янтарный */
    .rule-week-mode .rule-chip.active { background:var(--green); border-color:var(--green); }
    .rule-month-mode .rule-chip.active { background:var(--amber); border-color:var(--amber); }
    .rule-chip-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; font-size:12px; color:var(--muted); }
    .rule-note { margin-top:12px; color:var(--muted); font-size:12px; line-height:1.5; }
    .rule-upcoming { margin-top:18px; padding-top:14px; border-top:1px dashed var(--border); }
    .rule-upcoming b { display:block; margin-bottom:8px; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
    .rule-dates { display:flex; flex-wrap:wrap; gap:6px; margin:0; padding:0; list-style:none; }
    .rule-dates li { padding:5px 10px; border:1px solid var(--border); border-radius:999px; background:var(--panel); font-size:12px; font-variant-numeric:tabular-nums; text-transform:capitalize; }
    .rule-dates li.rule-week { border-color:var(--green); background:var(--green-soft); color:var(--green); }
    .rule-dates li.rule-month { border-color:var(--amber); background:var(--amber-soft); color:var(--amber); }
    .rule-dates li.rule-both { border-color:var(--green); color:var(--text); background:linear-gradient(135deg, var(--green-soft) 0 50%, var(--amber-soft) 50% 100%); box-shadow:inset 0 0 0 1px var(--amber); }
    .rule-status { margin-top:14px; min-height:18px; font-size:12px; color:var(--muted); }
    .rule-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-top:16px; }
    @media (max-width:640px) {
      .rule-panel { padding:14px 10px; }
      .rule-chips { gap:6px; }
      .rule-chip { min-height:44px; }
      .delivery-months { grid-template-columns:1fr; }
    }
    @media (max-width:1150px) and (min-width:901px) {
      .delivery-months { gap:10px; }
      .delivery-month { padding:12px 6px; }
      .delivery-grid { gap:2px; }
      .delivery-day { height:36px; }
      .delivery-month-head { flex-direction:column; align-items:flex-start; }
    }
    @media (max-width:900px) {
      .delivery-months { grid-template-columns:1fr; gap:14px; }
      .delivery-day { height:44px; }
    }

    /* Settings page visual system */
    :host { display:block; color:var(--text); }
    .settings-topbar { align-items:center; gap:16px; margin-bottom:18px; }
    .settings-heading { min-width:0; }
    .settings-heading .page-title { display:flex; align-items:center; gap:10px; font-size:26px; font-weight:750; letter-spacing:-.035em; }
    .settings-heading p { margin:6px 0 0; color:var(--muted); font-size:13px; line-height:1.5; }
    .settings-top-actions { display:flex; align-items:center; gap:8px; margin-left:auto; }
    /* ---------- верхнее меню: вкладки браузерного вида, у каждой свой контент ---------- */
    .settings-tabs { margin:0 0 20px; }
    .settings-nav { display:flex; align-items:flex-end; gap:2px; overflow-x:auto; padding:0 8px 1px; box-shadow:inset 0 -1px 0 var(--border); scrollbar-width:none; }
    .settings-nav::-webkit-scrollbar { display:none; }
    .settings-nav button { display:inline-flex; align-items:center; gap:8px; flex:0 0 auto; min-height:40px; margin-bottom:-1px; padding:0 16px; border:1px solid transparent; border-radius:11px 11px 0 0; background:transparent; color:var(--muted); font:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:background .15s ease,color .15s ease,border-color .15s ease; }
    .settings-nav button:hover { background:var(--bg); color:var(--text); }
    .settings-nav button:focus-visible { outline:3px solid color-mix(in srgb,var(--brand-blue-dark) 30%,transparent); outline-offset:-3px; }
    .settings-nav button.on { background:var(--panel); border-color:var(--border); border-bottom-color:var(--panel); color:var(--text); }
    .settings-tabbody .settings-section { margin:0; border-top:0; border-radius:0 0 14px 14px; }
    .settings-section { margin:0 0 18px; padding:22px; border:1px solid var(--border); border-radius:14px; background:var(--panel); box-shadow:0 5px 18px rgba(15,23,42,.035); }
    .settings-section > h3 { display:flex; align-items:center; gap:9px; margin:0 0 7px; font-size:17px; font-weight:700; letter-spacing:-.015em; }
    .settings-section > .muted { max-width:850px; margin-bottom:16px !important; line-height:1.55; }
    .settings-section .hr { border:0; border-top:1px solid var(--border); margin:20px 0; }
    .settings-section .btn { transition:background .15s ease,border-color .15s ease,transform .15s ease; }
    .settings-section .btn:not(:disabled):active { transform:translateY(1px); }
    .settings-section input:not([type="checkbox"]):not([type="color"]), .settings-section select { min-height:38px; border-radius:8px; }
    .settings-section input:focus-visible, .settings-section select:focus-visible, .settings-section button:focus-visible { outline:3px solid color-mix(in srgb,var(--brand-blue-dark) 30%,transparent); outline-offset:2px; }
    .settings-section .tbl { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border:1px solid var(--border); border-radius:10px; }
    .settings-section .tbl th { padding:11px 13px; background:var(--bg); color:var(--muted); font-size:11px; font-weight:700; letter-spacing:.055em; text-transform:uppercase; }
    .settings-section .tbl td { padding:11px 13px; border-top:1px solid var(--border); vertical-align:middle; }
    .settings-section .tbl tr:hover td { background:color-mix(in srgb,var(--bg) 55%,transparent); }
    .settings-section .tbl .btn { min-width:34px; min-height:32px; }
    .settings-section .row.mt { display:flex; align-items:center; flex-wrap:wrap; gap:9px; padding:14px; margin-top:12px; border:1px dashed var(--border); border-radius:10px; background:var(--bg); }
    .settings-section .row.mt input:first-child { flex:1 1 200px; max-width:320px !important; }
    .cat-badge { flex:0 0 28px; width:28px; height:28px; border:1px solid rgba(15,23,42,.06); }
    .pc-icon { min-width:145px; }
    .pc-color { cursor:pointer; border:1px solid var(--border); border-radius:7px; background:var(--panel); }
    .settings-section .badge { vertical-align:middle; }
    .settings-section .ok-msg, .settings-section .err { border-radius:9px; padding:10px 12px; }
    .excel-sync { display:flex; align-items:center; gap:16px; margin-top:16px; padding:18px; border:1px dashed var(--border); border-radius:12px; background:var(--bg); }
    .excel-sync-info { display:flex; flex-direction:column; gap:4px; min-width:0; }
    .excel-sync-info b { font-size:14px; }
    .excel-sync-info span { max-width:640px; color:var(--muted); font-size:12px; line-height:1.5; }
    .excel-sync .btn { flex:0 0 auto; margin-left:auto; }
    /* глобальный --accent сейчас почти белый — для главного действия берём фирменный тёмно-синий */
    .excel-sync .btn.primary { background:var(--brand-blue-dark); border-color:var(--brand-blue-dark); color:#fff; }
    .excel-sync .btn.primary:hover:not(:disabled) { background:var(--brand-blue); border-color:var(--brand-blue); }
    .excel-sync .btn:disabled { cursor:progress; opacity:.75; }
    /* ---------- документ копии: сетка и листы как в Excel ---------- */
    .excel-doc { margin-top:16px; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:#fff; }
    .excel-doc-bar { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 14px; padding:9px 12px; border-bottom:1px solid var(--border); background:var(--bg); font-size:12px; }
    .excel-doc-name { font-size:13px; font-weight:700; }
    .excel-doc-bar a { color:var(--brand-blue-dark); font-weight:600; text-decoration:none; }
    .excel-doc-bar a:hover { text-decoration:underline; }
    /* Лист разворачивается на всю высоту: вертикальной прокрутки внутри нет, только окно браузера. */
    .excel-grid-wrap { overflow-x:auto; overflow-y:visible; }
    .excel-grid { width:100%; border-collapse:separate; border-spacing:0; font-size:12px; }
    .excel-grid th, .excel-grid td { padding:5px 9px; border-right:1px solid #e3e8ef; border-bottom:1px solid #e3e8ef; text-align:left; white-space:nowrap; }
    .excel-grid td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .excel-grid thead th { position:sticky; top:0; z-index:1; height:23px; padding:3px 9px; background:#f3f2f1; color:#5f6368; font-weight:600; }
    .excel-grid thead .link-col { background:#dcebf9; color:var(--brand-blue-dark); text-align:center; }
    .excel-grid thead .local-name { background:#eaf5ea; color:#2f6b3a; text-align:center; }
    .excel-grid thead .local-min { background:#eaf5ea; color:#2f6b3a; text-align:center; }
    .excel-grid td.link-id { background:#f4f9ff; color:var(--brand-blue-dark); font-weight:600; text-align:right; font-variant-numeric:tabular-nums; }
    .excel-grid td.link-id.miss { background:#fff; color:#c7cdd5; font-weight:400; }
    .excel-grid td.local-name { background:#f5fbf5; color:#2f6b3a; white-space:nowrap; }
    .excel-grid td.local-name.miss { background:#fff; }
    .excel-grid td.local-min { background:#f5fbf5; color:#2f6b3a; text-align:right; font-variant-numeric:tabular-nums; }
    .excel-grid td.local-min.miss { background:#fff; color:#c7cdd5; }
    .excel-grid td.link-pick { background:#fffdf3; padding:2px 4px; }
    .excel-grid td.link-pick button { width:100%; border:1px dashed #c9a227; border-radius:6px; background:#fff; color:#7a5b00; font:inherit; font-size:11px; padding:3px 6px; cursor:pointer; white-space:nowrap; }
    .excel-grid td.link-pick button:hover { background:#fff7dd; }
    .excel-grid .link-edit { border:0; background:transparent; color:var(--brand-blue-dark); font-size:11px; padding:0 2px; cursor:pointer; }
    .link-scrim { position:fixed; inset:0; z-index:80; }
    .link-pop { position:fixed; z-index:81; width:300px; padding:8px; background:var(--panel); border:1px solid var(--border); border-radius:10px; box-shadow:0 12px 30px rgba(10,18,32,.22); }
    .link-pop-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:6px; font-size:12px; }
    .link-pop-head span { overflow:hidden; text-overflow:ellipsis; }
    .link-pop-x { border:0; background:transparent; color:var(--muted); font-size:14px; cursor:pointer; line-height:1; }
    .link-unset { width:100%; margin-top:6px; padding:6px; border:1px solid var(--border); border-radius:8px; background:#fff; color:var(--red); font:inherit; font-size:12px; cursor:pointer; }
    .link-unset:disabled { opacity:.6; cursor:progress; }
    .sheet-unmatched { padding:8px 12px; border-bottom:1px solid var(--border); background:var(--amber-soft); color:#7a5b00; font-size:12px; line-height:1.5; }
    .excel-grid .corner { position:sticky; left:0; z-index:2; min-width:38px; width:38px; background:#f3f2f1; color:#9aa0a6; text-align:center; font-weight:400; }
    .excel-grid thead .corner { z-index:3; }
    .excel-grid .row-num { position:sticky; left:0; z-index:1; min-width:38px; width:38px; background:#f8f9fa; color:#9aa0a6; text-align:center; font-weight:400; }
    .excel-grid tbody tr:hover td { background:#f6faff; }
    .excel-grid .no-rows { padding:18px; color:var(--muted); text-align:center; }
    .excel-tabs { display:flex; overflow-x:auto; border-top:1px solid var(--border); background:#f3f2f1; scrollbar-width:thin; }
    .excel-tabs button { flex:0 0 auto; padding:7px 14px; border:0; border-right:1px solid #dcdcdc; background:transparent; color:#4a4a4a; font:inherit; font-size:12px; cursor:pointer; }
    .excel-tabs button:hover { background:#e8e8e8; }
    .excel-tabs button.on { background:#fff; color:#217346; font-weight:700; box-shadow:inset 0 -2px 0 #217346; }
    .excel-tabs .tab-badge { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; margin-left:6px; padding:0 5px; border-radius:9px; background:#d93025; color:#fff; font-size:11px; font-weight:700; line-height:1; vertical-align:middle; }
    @media (max-width:640px) {
      .excel-sync { align-items:stretch; flex-direction:column; }
      .excel-sync .btn { margin-left:0; min-height:44px; }
    }
    @media (max-width:700px) {
      .settings-heading .page-title { font-size:22px; }
      .settings-topbar { align-items:flex-start; }
      .settings-top-actions { gap:6px; }
      .settings-section, .delivery-block { padding:16px 12px; border-radius:11px; }
      .settings-tabbody .settings-section { border-radius:0 0 11px 11px; }
      .settings-tabs { margin-bottom:14px; }
      .settings-nav button { padding:0 12px; }
      .settings-section .tbl { display:block; overflow-x:auto; white-space:nowrap; }
      .delivery-head { gap:14px; }
      .delivery-tabs { flex-wrap:wrap; }
      .delivery-tabs button { flex:1 1 40%; }
      .delivery-nav { width:100%; }
      .delivery-nav .btn:not(.delivery-arrow) { flex:1; }
      .delivery-footer { align-items:flex-start; flex-direction:column; }
      .delivery-status { text-align:left; }
      .settings-section .row.mt input:first-child { flex-basis:100%; max-width:none !important; }
    }
    @media (prefers-reduced-motion:reduce) {
      .settings-section .btn, .delivery-day, .rule-chip, .settings-nav button { transition:none; }
    }
  `],
  template: `
    <div class="bar settings-topbar">
      <div class="settings-heading">
        <h1 class="page-title" style="margin:0">⚙️ Настройки</h1>
        <p>Управление доставками, интеграциями и справочниками производства</p>
      </div>
      <div class="settings-top-actions">
        <button class="btn sm" (click)="pwdOpen.set(true)">🔒 {{ 'common.password' | translate }}</button>
        <button class="btn sm" (click)="load()" [disabled]="busy()" aria-label="Обновить настройки" title="Обновить">⟳</button>
      </div>
    </div>
    @if (pwdOpen()) {
      <app-password-form (closed)="pwdOpen.set(false)" />
    }
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="settings-tabs">
      <div class="settings-nav" role="tablist" aria-label="Разделы настроек">
        <button type="button" role="tab" id="settings-tab-delivery" aria-controls="settings-panel-delivery"
                [class.on]="settingsTab() === 'delivery'" [attr.aria-selected]="settingsTab() === 'delivery'"
                (click)="openSettingsTab('delivery', $event)">📅 <span>Доставки</span></button>
        <button type="button" role="tab" id="settings-tab-gpt" aria-controls="settings-panel-gpt"
                [class.on]="settingsTab() === 'gpt'" [attr.aria-selected]="settingsTab() === 'gpt'"
                (click)="openSettingsTab('gpt', $event)">🤖 <span>GPT и прокси</span></button>
        <button type="button" role="tab" id="settings-tab-categories" aria-controls="settings-panel-categories"
                [class.on]="settingsTab() === 'categories'" [attr.aria-selected]="settingsTab() === 'categories'"
                (click)="openSettingsTab('categories', $event)">📦 <span>Категории склада</span></button>
        <button type="button" role="tab" id="settings-tab-catalogs" aria-controls="settings-panel-catalogs"
                [class.on]="settingsTab() === 'catalogs'" [attr.aria-selected]="settingsTab() === 'catalogs'"
                (click)="openSettingsTab('catalogs', $event)">🥗 <span>Каталоги продукции</span></button>
        <button type="button" role="tab" id="settings-tab-excel" aria-controls="settings-panel-excel"
                [class.on]="settingsTab() === 'excel'" [attr.aria-selected]="settingsTab() === 'excel'"
                (click)="openSettingsTab('excel', $event)">📄 <span>Синхронизация Excel</span></button>
      </div>
      <div class="settings-tabbody">

    <section id="settings-panel-delivery" class="panel settings-section delivery-block" role="tabpanel"
             aria-labelledby="settings-tab-delivery" [hidden]="settingsTab() !== 'delivery'"
             [attr.aria-busy]="calendarLoading()">
      <div class="delivery-head">
        <div>
          <h2 id="delivery-title">📅 Доставки</h2>
          <p>Календарь производственных доставок и правила, которые заполняют его сами.</p>
        </div>
        <div class="delivery-summary" aria-label="Сводка по доставкам">
          <span class="pill blue">Ближайшая: {{ nextDeliveryLabel() }}</span>
          <span class="pill gray">В периоде: {{ deliveriesInWindow() }}</span>
          <span class="pill" [class.green]="ruleActive()" [class.gray]="!ruleActive()">Авто: {{ ruleSummaryLabel() }}</span>
        </div>
      </div>

      <div class="tabs delivery-tabs" role="tablist" aria-label="Разделы доставок">
        <button type="button" role="tab" [class.on]="deliveryTab() === 'calendar'"
                [attr.aria-selected]="deliveryTab() === 'calendar'" (click)="goDeliveryTab('calendar')">🗓 Календарь</button>
        <button type="button" role="tab" [class.on]="deliveryTab() === 'week'"
                [attr.aria-selected]="deliveryTab() === 'week'" (click)="goDeliveryTab('week')">🔁 Каждую неделю</button>
        <button type="button" role="tab" [class.on]="deliveryTab() === 'month'"
                [attr.aria-selected]="deliveryTab() === 'month'" (click)="goDeliveryTab('month')">📆 Каждый месяц</button>
      </div>

      @if (ruleErr()) { <div class="err" role="alert">{{ ruleErr() }}</div> }
      @if (calendarErr()) {
        <div class="err delivery-error" role="alert">
          <span>{{ calendarErr() }}</span>
          <button type="button" class="btn sm" [disabled]="calendarLoading() || calendarSaving().size > 0 || ruleSaving()" (click)="loadCalendar()">Обновить</button>
        </div>
      }

      @if (deliveryTab() === 'calendar') {
        <div class="delivery-nav" aria-label="Период календаря">
          <span class="delivery-range">{{ calendarMonths()[0].label }} — {{ calendarMonths()[2].label }}</span>
          <button type="button" class="btn delivery-arrow" aria-label="Предыдущие три месяца"
                  [disabled]="calendarLoading() || calendarSaving().size > 0 || ruleSaving()" (click)="moveCalendar(-3)">←</button>
          <button type="button" class="btn" [disabled]="calendarLoading() || calendarSaving().size > 0 || ruleSaving() || calendarOffset() === 0"
                  (click)="moveCalendar(-calendarOffset())">Текущий месяц</button>
          <button type="button" class="btn delivery-arrow" aria-label="Следующие три месяца"
                  [disabled]="calendarLoading() || calendarSaving().size > 0 || ruleSaving()" (click)="moveCalendar(3)">→</button>
        </div>
        <div class="delivery-months">
          @for (month of calendarMonths(); track month.key) {
            <section class="delivery-month" [attr.aria-labelledby]="'delivery-month-' + month.key">
              <div class="delivery-month-head">
                <h3 [id]="'delivery-month-' + month.key">{{ month.label }}</h3>
                <span>Доставок: {{ deliveriesInMonth(month.key) }}</span>
              </div>
              <div class="delivery-grid">
                @for (weekday of calendarWeekdays; track weekday) {
                  <span class="delivery-weekday" aria-hidden="true">{{ weekday }}</span>
                }
                @for (day of month.days; track $index) {
                  @if (day) {
                    <button type="button" class="delivery-day" [class.weekend]="day.weekend"
                            [class.today]="day.date === calendarToday()" [class.selected]="deliveryDates().has(day.date)"
                            [class.rule]="ruleKind(day.date)" [class.rule-week]="ruleKind(day.date) === 'week'"
                            [class.rule-month]="ruleKind(day.date) === 'month'" [class.rule-both]="ruleKind(day.date) === 'both'"
                            [class.locked]="day.date <= calendarToday()"
                            [class.pending]="calendarSaving().has(day.date)" [attr.data-date]="day.date"
                            [attr.aria-label]="day.label" [attr.aria-pressed]="deliveryDates().has(day.date)"
                            [attr.aria-current]="day.date === calendarToday() ? 'date' : null"
                            [attr.title]="ruleHint(day.date)"
                            [disabled]="!calendarReady() || ruleSaving() || day.date <= calendarToday() || calendarSaving().has(day.date)" (click)="toggleDelivery(day)">
                      {{ day.number }}
                      @if (deliveryDays().has(day.date)) {
                        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6l2.5 2.5L10 3" fill="none" stroke="currentColor" stroke-width="1.7" /></svg>
                      }
                    </button>
                  } @else { <span aria-hidden="true"></span> }
                }
              </div>
            </section>
          }
        </div>
        <div class="delivery-footer">
          <div class="delivery-legend">
            <span><i class="delivery-swatch selected" aria-hidden="true"></i>Вручную</span>
            <span><i class="delivery-swatch rule-week" aria-hidden="true"></i>По правилу недели</span>
            <span><i class="delivery-swatch rule-month" aria-hidden="true"></i>По правилу месяца</span>
            <span><i class="delivery-swatch rule-both" aria-hidden="true"></i>Оба правила</span>
            <span><i class="delivery-swatch selected rule-week" aria-hidden="true"></i>Вручную + правило</span>
            <span><i class="delivery-swatch today" aria-hidden="true"></i>Сегодня</span>
          </div>
          <div class="delivery-status" role="status" aria-live="polite">
            @if (calendarLoading()) { Загружаем расписание… }
            @else if (calendarSaving().size) { Сохраняем… }
            @else { {{ calendarMsg() || 'Изменения сохраняются автоматически. Клик ставит или снимает ручную отметку, правило он не выключает.' }} }
          </div>
        </div>
      }

      @if (deliveryTab() === 'week' || deliveryTab() === 'month') {
        <div class="rule-panel" [class.rule-week-mode]="deliveryTab() === 'week'" [class.rule-month-mode]="deliveryTab() === 'month'">
          <h3>{{ deliveryTab() === 'week' ? 'Доставки каждую неделю' : 'Доставки каждый месяц' }}</h3>
          <p>
            @if (deliveryTab() === 'week') {
              Выберите дни недели — сервер сам добавит доставки во все будущие недели, пока правило включено.
              Никакого периода указывать не нужно.
            } @else {
              Выберите числа месяца — сервер сам добавит доставки в каждый будущий месяц.
              Если числа в месяце нет (например 31 февраля), оно просто пропускается.
            }
          </p>

          <div class="rule-chip-head">
            <span>{{ deliveryTab() === 'week' ? 'Дни недели' : 'Числа месяца' }}</span>
            @if (deliveryTab() === 'week' ? !!ruleWeekdays().length : !!ruleMonthDays().length) {
              <button type="button" class="btn sm" [disabled]="ruleSaving()" (click)="clearCurrentRule()">Сбросить выбор</button>
            }
          </div>
          <div class="rule-chips" [class.rule-chips-month]="deliveryTab() === 'month'">
            @if (deliveryTab() === 'week') {
              @for (weekday of calendarWeekdays; track weekday; let i = $index) {
                <button type="button" class="rule-chip" [class.active]="ruleWeekdays().includes(i + 1)"
                        [attr.aria-label]="ruleWeekdayNames[i]" [attr.aria-pressed]="ruleWeekdays().includes(i + 1)"
                        [disabled]="ruleSaving()" (click)="toggleRuleDay('week', i + 1)">{{ weekday }}</button>
              }
            } @else {
              @for (day of ruleMonthDayOptions; track day) {
                <button type="button" class="rule-chip" [class.active]="ruleMonthDays().includes(day)"
                        [attr.aria-label]="day + '-е число каждого месяца'" [attr.aria-pressed]="ruleMonthDays().includes(day)"
                        [disabled]="ruleSaving()" (click)="toggleRuleDay('month', day)">{{ day }}</button>
              }
            }
          </div>

          <div class="rule-note">
            Дни недели и числа месяца складываются: дате достаточно совпасть с одним из списков.
            В календаре дни недели окрашены зелёным, числа месяца — янтарным, совпадение обоих списков
            делит клетку пополам, а ручная отметка на дне правила добавляет синюю полосу. Клик правило
            не выключает: он ставит или снимает только ручную отметку.
          </div>

          <div class="rule-upcoming">
            <b>Ближайшие даты по правилу</b>
            @if (ruleUpcoming().length) {
              <ul class="rule-dates">
                @for (entry of ruleUpcoming(); track entry.date) {
                  <li [class.rule-week]="entry.kind === 'week'" [class.rule-month]="entry.kind === 'month'"
                      [class.rule-both]="entry.kind === 'both'">{{ entry.label }}</li>
                }
              </ul>
            } @else {
              <span class="muted">
                {{ deliveryTab() === 'week' ? 'Ни один день недели не выбран — недели доставки не добавляют.' : 'Ни одно число месяца не выбрано — месяца доставку не добавляют.' }}
              </span>
            }
          </div>

          <div class="rule-actions">
            <button type="button" class="btn" (click)="goDeliveryTab('calendar')">🗓 Открыть календарь</button>
            <span class="rule-status" role="status" aria-live="polite">
              @if (ruleSaving()) { Сохраняем правило… }
              @else { {{ ruleMsg() || 'Выбор сохраняется сразу и действует, пока его не снять.' }} }
            </span>
          </div>
        </div>
      }
    </section>

    <!-- GPT -->
    <div id="settings-panel-gpt" class="panel settings-section" role="tabpanel"
         aria-labelledby="settings-tab-gpt" [hidden]="settingsTab() !== 'gpt'">
      <h3>🤖 GPT и подключение к OpenAI</h3>
      @if (st(); as s) {
        <div class="row gpt-settings-grid" style="gap:24px; align-items:flex-start">
          <div style="flex:1 1 380px; min-width:0">
            <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer; font-weight:600">
              <input type="checkbox" [(ngModel)]="viaProxy" [disabled]="busy()" style="width:18px; height:18px; margin:1px 0 0; flex:none" />
              <span>Работать через Tor (прокси)</span>
            </label>
            <div class="muted" style="font-size:12px; margin-top:6px">
              Включайте, если сервер в стране, где OpenAI недоступен: запросы к GPT идут через SOCKS5-прокси.
            </div>
            <label class="f" style="margin-top:14px; max-width:430px">
              Адрес прокси
              <input [(ngModel)]="proxyUrl" [disabled]="busy() || !viaProxy" placeholder="socks5h://127.0.0.1:9050" />
            </label>
          </div>
          <div style="flex:0 1 260px; min-width:0">
            <div class="muted" style="font-size:12px">Прокси</div>
            <div style="margin:4px 0 12px">
              <span class="mono">{{ s.proxy.scheme }}://{{ s.proxy.host }}:{{ s.proxy.port }}</span>
              <span class="badge" [class.green]="s.proxy.reachable" [class.red]="!s.proxy.reachable">
                {{ s.proxy.reachable ? 'порт доступен' : 'недоступен' }}
              </span>
            </div>
            <div class="muted" style="font-size:12px">Ключ OpenAI</div>
            <div style="margin-top:4px">
              @if (s.openai.keyConfigured) { <span class="badge green">ключ задан</span> }
              @else { <span class="badge red">не задан в .env</span> }
              <span class="mono"> {{ s.openai.model }}</span>
            </div>
          </div>
        </div>
        <hr class="hr" />
        <div class="row">
          <button class="btn primary" (click)="save()" [disabled]="busy()">{{ busy() ? 'Сохраняем…' : 'Сохранить' }}</button>
          <button class="btn" (click)="runTest()" [disabled]="testing() || busy()">{{ testing() ? 'Проверяем…' : 'Проверить связь с GPT' }}</button>
        </div>
        @if (test(); as t) {
          @if (t.ok) { <div class="ok-msg" style="margin:12px 0 0">GPT через {{ t.transport }} за {{ (t.ms / 1000).toFixed(1) }} с: «{{ t.reply }}»</div> }
          @else { <div class="err" style="margin:12px 0 0">{{ t.transport }}: {{ t.error }}</div> }
        }
      } @else { <div class="muted" style="font-size:12px">Загружаем…</div> }
    </div>

    <!-- КАТЕГОРИИ НОМЕНКЛАТУРЫ -->
    <div id="settings-panel-categories" class="panel settings-section" role="tabpanel"
         aria-labelledby="settings-tab-categories" [hidden]="settingsTab() !== 'categories'">
      <h3>📦 Категории номенклатуры</h3>
      <div class="muted" style="font-size:12px; margin-bottom:10px">
        Список предлагается при выборе категории у позиции склада. При удалении категории её позиции переходят в «прочее».
      </div>
      @if (catsErr()) { <div class="err">{{ catsErr() }}</div> }
      @if (catsMsg()) { <div class="ok-msg">{{ catsMsg() }}</div> }
      <table class="tbl" aria-label="Категории номенклатуры">
        <tr><th>Категория</th><th class="num">Позиций</th><th></th></tr>
        @for (c of cats(); track c.id) {
          <tr>
            @if (editingCat() === c.id) {
              <td>
                <div class="row" style="gap:6px; align-items:center">
                  <input [ngModel]="editCatName()" (ngModelChange)="editCatName.set($event)"
                    (keyup.enter)="saveRename()" (keyup.escape)="editingCat.set(null)" />
                  <select class="pc-icon" title="Иконка" [ngModel]="editCatIcon()" (ngModelChange)="editCatIcon.set($event)">
                    <option value="">— без иконки —</option>
                    @for (ic of catalogIcons; track ic) {
                      <option [value]="ic" [disabled]="!!catIconOwner(ic, c.id)">{{ ic }}{{ catIconOwner(ic, c.id) ? ' — занята: ' + catIconOwner(ic, c.id) : '' }}</option>
                    }
                  </select>
                  <input class="pc-color" type="color" title="Фоновый цвет"
                    [ngModel]="editCatColor()" (ngModelChange)="editCatColor.set($event)" />
                </div>
              </td>
              <td class="num muted">{{ c.productCount }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm primary" [disabled]="!editCatName().trim()" (click)="saveRename()">✓</button>
                <button class="btn sm" (click)="editingCat.set(null)">✕</button>
              </td>
            } @else {
              <td>
                <span class="cat-badge" [style.background]="c.color || '#eef2f7'">{{ c.icon || '·' }}</span>
                <b style="text-transform:capitalize">{{ c.name }}</b>
              </td>
              <td class="num muted">{{ c.productCount }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm" (click)="startRename(c)" title="Изменить">✎</button>
                <button class="btn sm danger" (click)="deleteCat(c)" title="Удалить">🗑</button>
              </td>
            }
          </tr>
        } @empty { <tr class="empty"><td colspan="3">Категорий пока нет — добавьте первую</td></tr> }
      </table>
      <div class="row mt">
        <input style="max-width:240px" placeholder="Новая категория" [ngModel]="newCatName()"
          (ngModelChange)="newCatName.set($event)" (keyup.enter)="createCat()" />
        <select class="pc-icon" title="Иконка" [ngModel]="newCatIcon()" (ngModelChange)="newCatIcon.set($event)">
          <option value="">— без иконки —</option>
          @for (ic of catalogIcons; track ic) {
            <option [value]="ic" [disabled]="!!catIconOwner(ic, null)">{{ ic }}{{ catIconOwner(ic, null) ? ' — занята: ' + catIconOwner(ic, null) : '' }}</option>
          }
        </select>
        <input class="pc-color" type="color" title="Фоновый цвет"
          [ngModel]="newCatColor()" (ngModelChange)="newCatColor.set($event)" />
        <button class="btn sm primary" [disabled]="!newCatName().trim()" (click)="createCat()">+ Добавить</button>
      </div>
    </div>

    <!-- КАТАЛОГ ПРОДУКЦИИ -->
    <div id="settings-panel-catalogs" class="panel settings-section" role="tabpanel"
         aria-labelledby="settings-tab-catalogs" [hidden]="settingsTab() !== 'catalogs'">
      <h3>🥗 Каталог продукции</h3>
      <div class="muted" style="font-size:12px; margin-bottom:10px">
        Список предлагается при создании техкарты. При удалении каталога техкарты остаются, но без каталога.
      </div>
      @if (pcErr()) { <div class="err">{{ pcErr() }}</div> }
      @if (pcMsg()) { <div class="ok-msg">{{ pcMsg() }}</div> }
      <table class="tbl" aria-label="Каталоги продукции">
        <tr><th>Каталог</th><th class="num">Техкарт</th><th></th></tr>
        @for (c of productCatalogs(); track c.id) {
          <tr>
            @if (editingPc() === c.id) {
              <td>
                <div class="row" style="gap:6px; align-items:center">
                  <input [ngModel]="editPcName()" (ngModelChange)="editPcName.set($event)"
                    (keyup.enter)="savePcRename()" (keyup.escape)="editingPc.set(null)" />
                  <select class="pc-icon" title="Иконка" [ngModel]="editPcIcon()" (ngModelChange)="editPcIcon.set($event)">
                    <option value="">— без иконки —</option>
                    @for (ic of catalogIcons; track ic) {
                      <option [value]="ic" [disabled]="!!iconOwner(ic, c.id)">{{ ic }}{{ iconOwner(ic, c.id) ? ' — занята: ' + iconOwner(ic, c.id) : '' }}</option>
                    }
                  </select>
                  <input class="pc-color" type="color" title="Фоновый цвет"
                    [ngModel]="editPcColor()" (ngModelChange)="editPcColor.set($event)" />
                </div>
              </td>
              <td class="num muted">{{ c.cardCount ?? 0 }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm primary" [disabled]="!editPcName().trim()" (click)="savePcRename()">✓</button>
                <button class="btn sm" (click)="editingPc.set(null)">✕</button>
              </td>
            } @else {
              <td>
                <span class="cat-badge" [style.background]="c.color || '#eef2f7'">{{ c.icon || '·' }}</span>
                <b style="text-transform:capitalize">{{ c.name }}</b>
              </td>
              <td class="num muted">{{ c.cardCount ?? 0 }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm" (click)="startPcRename(c)" title="Изменить">✎</button>
                <button class="btn sm danger" (click)="deletePc(c)" title="Удалить">🗑</button>
              </td>
            }
          </tr>
        } @empty { <tr class="empty"><td colspan="3">Каталогов пока нет — добавьте первый</td></tr> }
      </table>
      <div class="row mt">
        <input style="max-width:240px" placeholder="Новый каталог" [ngModel]="newPcName()"
          (ngModelChange)="newPcName.set($event)" (keyup.enter)="createPc()" />
        <select class="pc-icon" title="Иконка" [ngModel]="newPcIcon()" (ngModelChange)="newPcIcon.set($event)">
          <option value="">— без иконки —</option>
          @for (ic of catalogIcons; track ic) {
            <option [value]="ic" [disabled]="!!iconOwner(ic, null)">{{ ic }}{{ iconOwner(ic, null) ? ' — занята: ' + iconOwner(ic, null) : '' }}</option>
          }
        </select>
        <input class="pc-color" type="color" title="Фоновый цвет"
          [ngModel]="newPcColor()" (ngModelChange)="newPcColor.set($event)" />
        <button class="btn sm primary" [disabled]="!newPcName().trim()" (click)="createPc()">+ Добавить</button>
      </div>
    </div>

    <!-- СИНХРОНИЗАЦИЯ EXCEL -->
    <div id="settings-panel-excel" class="panel settings-section" role="tabpanel"
         aria-labelledby="settings-tab-excel" [hidden]="settingsTab() !== 'excel'">
      <h3>📄 Синхронизация Excel</h3>
      <div class="muted" style="font-size:12px">
        Таблица «Микс Маркт Гастро» из Google Sheets: скачанные листы хранятся в отдельной базе
        данных и показываются здесь со всеми листами. Позиции сопоставляются с фасовками продукции
        по названию — локальный ID стоит в колонке ID между A и B, а минимальный заказ связанной
        фасовки — в колонке Min Заказ(local) между E и F.
      </div>
      @if (sheetErr()) { <div class="err">{{ sheetErr() }}</div> }
      @if (sheetMsg()) { <div class="ok-msg">{{ sheetMsg() }}</div> }
      <div class="excel-sync">
        <div class="excel-sync-info">
          <b>Google-таблица «Микс Маркт Гастро»</b>
          <span>Документ читается сервисным аккаунтом Google (credentials.json) только на чтение.
            Кнопка «Синхронизировать» заменяет сохранённые в отдельной базе листы свежими данными из
            Google — все листы сразу.</span>
        </div>
        <button class="btn primary" (click)="syncSheet()" [disabled]="sheetBusy()">
          {{ sheetBusy() ? 'Скачиваем…' : '🔄 Синхронизировать' }}
        </button>
      </div>

      @if (sheetDoc(); as doc) {
        <div class="excel-doc">
          <div class="excel-doc-bar">
            <span class="excel-doc-name">📄 {{ doc.title }}</span>
            <span class="muted">Листов: {{ sheetTabs().length }} · скачано {{ sheetLoadedLabel() }}</span>
            <a [href]="doc.url" target="_blank" rel="noopener">Открыть в Google Sheets ↗</a>
          </div>
          @if (doc.unmatched.length) {
            <div class="sheet-unmatched">
              <b>Не найдено в фасовках ({{ doc.unmatched.length }}):</b>
              {{ doc.unmatched.join(', ') }}
            </div>
          }
          @if (sheetActive(); as sheet) {
            <div class="excel-grid-wrap" role="region" [attr.aria-label]="'Лист ' + sheet.name" tabindex="0">
              <table class="excel-grid">
                <thead>
                  <tr>
                    <th class="corner" aria-hidden="true"></th>
                    @for (column of sheetColumns(); track $index) {
                      @if ($index === 1) {
                        <th class="link-col">ID</th>
                        <th class="local-name">localName</th>
                      }
                      <th class="col-letter">{{ excelColumn($index) }}</th>
                      @if ($index === 4) {
                        <th class="local-min">Min Заказ(local)</th>
                      }
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of sheet.rows; track $index; let rowIndex = $index) {
                    <tr>
                      <th class="row-num">{{ rowIndex + 1 }}</th>
                      @for (cell of row; track $index) {
                        @if ($index === 1) {
                          @if (sheetLink(rowIndex); as id) {
                            <td class="link-id">{{ id }}</td>
                            <td class="local-name">
                              {{ sheetLocalName(rowIndex) || '—' }}
                              <button type="button" class="link-edit" title="Изменить или снять сопоставление"
                                      (click)="openLinkPicker($event, rowIndex)">✎</button>
                            </td>
                          } @else if (sheetMiss(rowIndex)) {
                            <td class="link-pick" colspan="2">
                              <button type="button" (click)="openLinkPicker($event, rowIndex)">🔍 Сопоставить…</button>
                            </td>
                          } @else {
                            <td class="link-id miss"></td>
                            <td class="local-name miss"></td>
                          }
                        }
                        <td [class.num]="isNumber(cell)">{{ cell }}</td>
                        @if ($index === 4) {
                          @if (sheetMinOrder(rowIndex); as minOrder) {
                            <td class="local-min">{{ minOrder }}</td>
                          } @else {
                            <td class="local-min miss">—</td>
                          }
                        }
                      }
                    </tr>
                  } @empty {
                    <tr><td class="no-rows" [attr.colspan]="sheetColumns().length + 4">Пустой лист — данных нет</td></tr>
                  }
                </tbody>
              </table>
            </div>
            <div class="excel-tabs" role="tablist" aria-label="Листы документа">
              @for (item of sheetTabs(); track item.name) {
                <button type="button" role="tab" [class.on]="item.name === sheet.name"
                        [attr.aria-selected]="item.name === sheet.name"
                        [attr.title]="item.misses.length ? 'Нераспознанных блюд: ' + item.misses.length : null"
                        (click)="openSheet(item.name, $event)">{{ item.name }}@if (item.misses.length) {<span class="tab-badge">{{ item.misses.length }}</span>}</button>
              }
            </div>
            @if (linkTarget(); as target) {
              <div class="link-scrim" (click)="closeLinkPicker()"></div>
              <div class="link-pop" [style.left.px]="target.x" [style.top.px]="target.y"
                   role="dialog" aria-label="Сопоставление с фасовкой">
                <div class="link-pop-head">
                  <span>Строка {{ target.row + 1 }}: «{{ target.rowName }}»</span>
                  <button type="button" class="link-pop-x" aria-label="Закрыть" (click)="closeLinkPicker()">✕</button>
                </div>
                <app-picker [options]="linkOptions()" [selectedId]="target.packagingId" [autoOpen]="true"
                            placeholder="Найти фасовку…" (picked)="pickLink($event)"></app-picker>
                @if (target.packagingId != null) {
                  <button type="button" class="link-unset" [disabled]="linkSaving()" (click)="clearLink()">
                    Снять сопоставление
                  </button>
                }
              </div>
            }
          }
        </div>
      } @else {
        <div class="muted" style="font-size:12px; margin-top:12px">
          Таблица ещё не загружена — нажмите «Синхронизировать», и данные листов сохранятся в отдельной базе.
        </div>
      }
    </div>
      </div>
    </div>

  `,
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private calendarRequest?: Subscription;
  private calendarAnchor = new Date();
  private monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
  private dayFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  private shortDayFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });

  /** Верхнее меню настроек: одна вкладка — один раздел, как в браузере. */
  settingsTab = signal<SettingsTab>('delivery');

  /** Выбор вкладки и прокрутка полосы к ней: на узком экране дальние вкладки за краем. */
  openSettingsTab(tab: SettingsTab, event: Event): void {
    this.settingsTab.set(tab);
    (event.currentTarget as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (tab === 'excel') this.loadSheet();
  }

  // ---- синхронизация Excel: сохранённые листы Google-таблицы из отдельной базы ----
  readonly sheetDoc = signal<GoogleSheet | null>(null);
  /** Имя открытого листа; пусто — показывается первый. */
  sheetTab = signal('');
  sheetBusy = signal(false);
  sheetErr = signal('');
  sheetMsg = signal('');
  private sheetFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });

  readonly sheetTabs = computed(() => this.sheetDoc()?.tabs ?? []);
  readonly sheetActive = computed(() => {
    const tabs = this.sheetTabs();
    return tabs.find((tab) => tab.name === this.sheetTab()) ?? tabs[0] ?? null;
  });
  /** Колонки рисуются по ширине листа, даже если строк нет. */
  readonly sheetColumns = computed(() => Array.from({ length: this.sheetActive()?.width ?? 0 }));
  readonly sheetLoadedLabel = computed(() => {
    const loadedAt = this.sheetDoc()?.loadedAt;
    return loadedAt ? this.sheetFormat.format(new Date(loadedAt)) : '';
  });

  excelColumn(index: number): string {
    let number = index + 1;
    let letters = '';
    while (number > 0) {
      const rest = (number - 1) % 26;
      letters = String.fromCharCode(65 + rest) + letters;
      number = Math.floor((number - 1) / 26);
    }
    return letters;
  }

  /** Значения из Google приходят строками — числа выравниваем по правому краю. */
  isNumber(value: string): boolean {
    return /^-?\d+([.,]\d+)?$/.test(value.trim());
  }

  /** Локальный id фасовки для строки листа; null — позиция не сопоставлена. */
  sheetLink(rowIndex: number): number | null {
    return this.sheetActive()?.links?.[rowIndex] ?? null;
  }

  /** Название продукции (техкарта + фасовка) для строки листа; null — позиция не сопоставлена. */
  sheetLocalName(rowIndex: number): string | null {
    return this.sheetActive()?.names?.[rowIndex] ?? null;
  }

  /** Минимальный заказ связанной фасовки; null — позиция не сопоставлена. */
  sheetMinOrder(rowIndex: number): number | null {
    const id = this.sheetLink(rowIndex);
    if (id === null) return null;
    for (const card of this.cards()) {
      const found = (card.packagings ?? []).find((pk) => pk.id === id);
      if (found) return found.minOrder;
    }
    return null;
  }

  /** Позиция листа без продукции — в её ячейке вместо пустого поля показываем выбор. */
  sheetMiss(rowIndex: number): boolean {
    return this.sheetActive()?.misses?.includes(rowIndex) ?? false;
  }

  // ---- ручное сопоставление строки листа с фасовкой ----
  readonly linkTarget = signal<{
    tab: string;
    row: number;
    rowName: string;
    packagingId: number | null;
    x: number;
    y: number;
  } | null>(null);
  readonly linkSaving = signal(false);
  readonly cards = signal<TechCard[]>([]);
  private cardsRequested = false;

  readonly linkOptions = computed<PickOption[]>(() =>
    this.cards()
      .flatMap((card) => (card.packagings ?? []).map((pk) => ({
        id: pk.id,
        label: packagingLabel(card.name, fmtQty(pk.qtyBase, card.portionUnitCode)),
        unit: fmtQty(pk.qtyBase, card.portionUnitCode),
        group: card.catalogName ?? undefined,
      })))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  );

  /** Список продукции грузим один раз — только когда он реально понадобился. */
  private ensureCards(): void {
    if (this.cardsRequested) return;
    this.cardsRequested = true;
    this.api.cards$().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cards) => this.cards.set(cards),
      error: (e) => {
        this.cardsRequested = false;
        this.sheetErr.set(`Не удалось загрузить продукцию: ${httpErr(e)}`);
      },
    });
  }

  openLinkPicker(event: Event, rowIndex: number): void {
    const sheet = this.sheetActive();
    if (!sheet) return;
    const rowName = (sheet.rows[rowIndex]?.[1] ?? '').trim();
    if (!rowName) return;
    this.ensureCards();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.linkTarget.set({
      tab: sheet.name,
      row: rowIndex,
      rowName,
      packagingId: sheet.links?.[rowIndex] ?? null,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 308)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 340)),
    });
  }

  closeLinkPicker(): void {
    this.linkTarget.set(null);
  }

  pickLink(option: PickOption): void {
    const target = this.linkTarget();
    if (!target || this.linkSaving()) return;
    this.linkSaving.set(true);
    this.api.linkGoogleSheetRow$(target.tab, target.row, option.id).pipe(
      finalize(() => this.linkSaving.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => {
        this.updateLink(target.tab, target.row, option.id, option.label);
        this.closeLinkPicker();
      },
      error: (e) => this.sheetErr.set(`Не удалось сохранить сопоставление: ${httpErr(e)}`),
    });
  }

  clearLink(): void {
    const target = this.linkTarget();
    if (!target || this.linkSaving()) return;
    this.linkSaving.set(true);
    this.api.linkGoogleSheetRow$(target.tab, target.row, null).pipe(
      finalize(() => this.linkSaving.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => {
        this.updateLink(target.tab, target.row, null, null);
        this.closeLinkPicker();
      },
      error: (e) => this.sheetErr.set(`Не удалось снять сопоставление: ${httpErr(e)}`),
    });
  }

  /** Локально повторяем ответ сервера: ID, название и счётчик непознанного во вкладке. */
  private updateLink(tabName: string, rowIndex: number, id: number | null, name: string | null): void {
    this.sheetDoc.update((doc) => doc ? {
      ...doc,
      tabs: doc.tabs.map((tab) => {
        if (tab.name !== tabName) return tab;
        const links = tab.links.map((value, index) => (index === rowIndex ? id : value));
        const names = tab.names.map((value, index) => (index === rowIndex ? name : value));
        const misses = id === null
          ? (tab.misses.includes(rowIndex) ? tab.misses : [...tab.misses, rowIndex].sort((a, b) => a - b))
          : tab.misses.filter((index) => index !== rowIndex);
        return { ...tab, links, names, misses };
      }),
    } : doc);
  }

  /** Сохранённая таблица из отдельной базы: открытие вкладки показывает её без запроса к Google. */
  loadSheet(): void {
    if (this.sheetBusy()) return;
    this.ensureCards();
    this.sheetBusy.set(true);
    this.sheetErr.set('');
    this.sheetMsg.set('');
    this.api.googleSheet$().pipe(
      finalize(() => this.sheetBusy.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (doc) => {
        this.sheetDoc.set(doc);
        const current = this.sheetTab();
        this.sheetTab.set(doc?.tabs.some((tab) => tab.name === current) ? current : doc?.tabs[0]?.name ?? '');
      },
      error: (e) => this.sheetErr.set(`Не удалось загрузить сохранённую таблицу: ${httpErr(e)}`),
    });
  }

  /** Переключение листа: общая прокрутка сетки сбрасывается к началу. */
  openSheet(name: string, event: Event): void {
    this.sheetTab.set(name);
    const wrap = (event.currentTarget as HTMLElement).closest('.excel-doc')?.querySelector('.excel-grid-wrap');
    if (wrap) {
      wrap.scrollTop = 0;
      wrap.scrollLeft = 0;
    }
  }

  /** «Синхронизировать»: скачать таблицу заново и заменить сохранённые листы в отдельной базе. */
  syncSheet(): void {
    if (this.sheetBusy()) return;
    this.sheetBusy.set(true);
    this.sheetErr.set('');
    this.sheetMsg.set('');
    this.api.syncGoogleSheet$().pipe(
      finalize(() => this.sheetBusy.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (doc) => {
        this.sheetDoc.set(doc);
        const current = this.sheetTab();
        this.sheetTab.set(doc.tabs.some((tab) => tab.name === current) ? current : doc.tabs[0]?.name ?? '');
        const matched = new Set<string>();
        for (const tab of doc.tabs) {
          tab.rows.forEach((row, index) => {
            if (tab.links?.[index] != null) matched.add((row[1] ?? '').trim());
          });
        }
        this.sheetMsg.set(`Таблица обновлена: листов ${doc.tabs.length} · сопоставлено ${matched.size} из ${matched.size + doc.unmatched.length}`);
      },
      error: (e) => this.sheetErr.set(`Не удалось синхронизировать: ${httpErr(e)}`),
    });
  }

  readonly calendarToday = signal(calendarDate(this.calendarAnchor));
  readonly calendarWeekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  calendarOffset = signal(0);
  calendarLoading = signal(false);
  calendarReady = signal(false);
  calendarSaving = signal(new Set<string>());
  calendarErr = signal('');
  calendarMsg = signal('');
  deliveryDates = signal(new Set<string>());
  calendarMonths = computed(() => Array.from({ length: 3 }, (_, index) => {
    const first = new Date(this.calendarAnchor.getFullYear(), this.calendarAnchor.getMonth() + this.calendarOffset() + index, 1, 12);
    const year = first.getFullYear();
    const month = first.getMonth();
    const offset = (first.getDay() + 6) % 7;
    const last = new Date(year, month + 1, 0, 12);
    const days: (DeliveryDay | null)[] = Array.from({ length: 42 }, (_, cell) => {
      const number = cell - offset + 1;
      if (number < 1 || number > last.getDate()) return null;
      const date = new Date(year, month, number, 12);
      return { date: calendarDate(date), number, label: this.dayFormat.format(date), weekend: cell % 7 >= 5 };
    });
    return { key: calendarDate(first).slice(0, 7), label: this.monthFormat.format(first), first: calendarDate(first), last: calendarDate(last), days };
  }));

  // ---- правило повторяющихся доставок: живёт в отдельных настройках БД ----
  readonly ruleWeekdayNames = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  readonly ruleMonthDayOptions = Array.from({ length: 31 }, (_, index) => index + 1);
  deliveryTab = signal<'calendar' | 'week' | 'month'>('calendar');
  ruleWeekdays = signal<number[]>([]);
  ruleMonthDays = signal<number[]>([]);
  ruleSaving = signal(false);
  ruleErr = signal('');
  ruleMsg = signal('');
  /** Даты окна из правила и чем они добавлены: цвет и запрет на отмену в календаре. */
  readonly ruleDays = computed(() => {
    const kinds = new Map<string, RuleKind>();
    const today = this.calendarToday();
    if (!today) return kinds;
    const months = this.calendarMonths();
    for (const match of ruleMatches(months[0].first, months[2].last, this.ruleWeekdays(), this.ruleMonthDays(), today)) {
      kinds.set(match.date, match.kind);
    }
    return kinds;
  });

  /** Все дни доставки для отрисовки: все ручные даты плюс совпадения правила в окне. */
  readonly deliveryDays = computed(() => {
    const days = new Set(this.deliveryDates());
    for (const date of this.ruleDays().keys()) days.add(date);
    return days;
  });

  /** Сколько доставок в показанном окне: ручные даты и правило вместе. */
  readonly deliveriesInWindow = computed(() => {
    const from = this.calendarMonths()[0].first;
    const to = this.calendarMonths()[2].last;
    let total = 0;
    for (const date of this.deliveryDays()) if (date >= from && date <= to) total++;
    return total;
  });

  ruleKind(date: string): RuleKind | null {
    return this.ruleDays().get(date) ?? null;
  }

  /** Подсказка дня календаря: сколько источников у дня и что сделает клик. */
  ruleHint(date: string): string | null {
    if (date <= this.calendarToday()) return 'Сегодняшнюю и прошедшие даты нельзя изменять';
    const kind = this.ruleKind(date);
    if (!kind) return null;
    return this.deliveryDates().has(date)
      ? `Ручная отметка совпадает с ${this.ruleByPhrase(kind)}: клик снимет только её`
      : `День добавлен по ${this.ruleByPhrase(kind)}: клик поставит ещё и ручную отметку`;
  }

  /** Что за правило держит дату — для подсказки и сообщения об отказе. */
  private ruleSectionLabel(kind: RuleKind): string {
    return kind === 'both' ? '«Каждую неделю» и «Каждый месяц»'
        : kind === 'week' ? '«Каждую неделю»' : '«Каждый месяц»';
  }

  private ruleByPhrase(kind: RuleKind): string {
    return kind === 'both' ? 'правилам «Каждую неделю» и «Каждый месяц»'
        : `правилу ${this.ruleSectionLabel(kind)}`;
  }

  readonly ruleActive = computed(() => this.ruleWeekdays().length > 0 || this.ruleMonthDays().length > 0);

  readonly ruleSummaryLabel = computed(() => {
    const parts: string[] = [];
    if (this.ruleWeekdays().length) parts.push(`${this.ruleWeekdays().length} дн. недели`);
    if (this.ruleMonthDays().length) parts.push(`${this.ruleMonthDays().length} чисел месяца`);
    return parts.length ? parts.join(' + ') : 'выключено';
  });

  /** Первые несколько будущих дат правила — чтобы выбор был виден до похода в календарь. */
  readonly ruleUpcoming = computed(() => {
    const today = this.calendarToday();
    return ruleMatches(
      shiftCalendarDate(today, 1), shiftCalendarDate(today, 60),
      this.ruleWeekdays(), this.ruleMonthDays(), today,
    ).slice(0, 8).map((match) => ({
      ...match,
      label: this.shortDayFormat.format(new Date(`${match.date}T00:00:00Z`)),
    }));
  });

  /** Ближайшая дата правила от сегодняшнего дня: календарное окно на неё не влияет. */
  readonly nextRuleDate = computed(() => {
    const today = this.calendarToday();
    for (let shift = 0; shift <= 366; shift++) {
      const date = shiftCalendarDate(today, shift);
      if (ruleDayKind(date, this.ruleWeekdays(), this.ruleMonthDays())) return date;
    }
    return null;
  });

  /** Ближайшая доставка от сегодня: ручные даты и правило вместе, без привязки к окну. */
  readonly nextDelivery = computed(() => {
    const today = this.calendarToday();
    const manual = [...this.deliveryDates()].filter((date) => date >= today).sort()[0] ?? null;
    const rule = this.nextRuleDate();
    if (!manual) return rule;
    if (!rule) return manual;
    return manual < rule ? manual : rule;
  });

  readonly nextDeliveryLabel = computed(() => {
    const next = this.nextDelivery();
    if (!next) return '—';
    return next === this.calendarToday()
        ? 'сегодня'
        : this.shortDayFormat.format(new Date(`${next}T00:00:00Z`));
  });

  st = signal<AppSettings | null>(null);
  pwdOpen = signal(false);
  err = signal('');
  msg = signal('');
  busy = signal(false);
  testing = signal(false);
  test = signal<GptTestResult | null>(null);
  viaProxy = false;
  proxyUrl = '';

  // ---- категории номенклатуры ----
  cats = signal<RawCategory[]>([]);
  catsErr = signal('');
  catsMsg = signal('');
  newCatName = signal('');
  newCatIcon = signal('');
  newCatColor = signal('#eef2f7');
  editingCat = signal<number | null>(null);
  editCatName = signal('');
  editCatIcon = signal('');
  editCatColor = signal('#eef2f7');

  // ---- каталог продукции ----
  productCatalogs = signal<ProductCatalog[]>([]);
  pcErr = signal('');
  pcMsg = signal('');
  newPcName = signal('');
  newPcIcon = signal('');
  newPcColor = signal('#eef2f7');
  editingPc = signal<number | null>(null);
  editPcName = signal('');
  editPcIcon = signal('');
  editPcColor = signal('#eef2f7');

  /** Набор иконок каталога: одна иконка не может быть у двух каталогов. */
  readonly catalogIcons = [
    '🥗', '🥙', '🌯', '🌮', '🍕', '🍔', '🍟', '🍲', '🍜', '🥘', '🍛', '🍣',
    '🍱', '🥟', '🍤', '🥩', '🍗', '🐟', '🥦', '🥕', '🍅', '🥔', '🍞', '🥐',
    '🍰', '🍦', '🧁', '🍪', '🥤', '☕', '🌶️', '🧂', '🧊', '⭐',
    '🥫', '🥛', '🥚', '🫒', '🍎',
  ];

  /** Имя каталога, уже занявшего иконку ('' — свободна). */
  iconOwner(icon: string, selfId: number | null): string {
    return this.productCatalogs().find((c) => c.icon === icon && c.id !== selfId)?.name ?? '';
  }

  /** Имя категории номенклатуры, уже занявшей иконку ('' — свободна). */
  catIconOwner(icon: string, selfId: number | null): string {
    return this.cats().find((c) => c.icon === icon && c.id !== selfId)?.name ?? '';
  }

  ngOnInit(): void {
    this.loadCalendar();
    this.loadRule();
    this.load();
    this.loadCats();
    this.loadPcs();
  }

  deliveriesInMonth(month: string): number {
    return [...this.deliveryDays()].filter(date => date.startsWith(month + '-')).length;
  }

  /** Сервер отдаёт всё расписание разом, поэтому перелистывание окна — только сдвиг на клиенте. */
  moveCalendar(months: number): void {
    if (this.calendarLoading() || this.calendarSaving().size || this.ruleSaving()) return;
    this.calendarOffset.update(offset => offset + months);
  }

  loadCalendar(): void {
    if (this.calendarSaving().size) return;
    this.calendarRequest?.unsubscribe();
    this.calendarLoading.set(true);
    this.calendarReady.set(false);
    this.calendarErr.set('');
    this.calendarMsg.set('');
    this.deliveryDates.set(new Set());
    this.calendarRequest = this.api.deliveryCalendar$().pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.calendarLoading.set(false)),
    ).subscribe({
      next: ({ today, dates }) => {
        this.calendarToday.set(today);
        this.deliveryDates.set(new Set(dates));
        this.calendarReady.set(true);
      },
      error: (e: unknown) => this.calendarErr.set(`Не удалось загрузить расписание: ${httpErr(e)}`),
    });
  }

  toggleDelivery(day: DeliveryDay): void {
    if (!this.calendarReady() || this.ruleSaving() || day.date <= this.calendarToday() || this.calendarSaving().has(day.date)) return;
    const covered = this.ruleKind(day.date);
    const enabled = !this.deliveryDates().has(day.date);
    this.calendarSaving.update((dates) => new Set(dates).add(day.date));
    this.calendarErr.set('');
    this.calendarMsg.set('');
    this.api.setDeliveryDate$(day.date, enabled).pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.calendarSaving.update((dates) => {
          const next = new Set(dates);
          next.delete(day.date);
          return next;
        })),
    ).subscribe({
      next: (saved) => {
        this.deliveryDates.update((dates) => {
          const next = new Set(dates);
          if (saved.enabled) next.add(saved.date);
          else next.delete(saved.date);
          return next;
        });
        this.calendarMsg.set(saved.enabled
            ? `Сохранено: ${day.label} — ручная отметка${covered ? `, день уже идёт по ${this.ruleByPhrase(covered)}` : ''}.`
            : covered
              ? `Сохранено: ${day.label} — ручная отметка снята, доставка осталась по ${this.ruleByPhrase(covered)}.`
              : `Сохранено: ${day.label} — без доставки.`);
      },
      error: (e: unknown) => this.calendarErr.set(`Не удалось сохранить дату. Нажмите на неё ещё раз: ${httpErr(e)}`),
    });
  }

  goDeliveryTab(tab: 'calendar' | 'week' | 'month'): void {
    this.deliveryTab.set(tab);
    this.ruleErr.set('');
    this.ruleMsg.set('');
  }

  loadRule(): void {
    this.api.deliveryRule$().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rule) => {
        this.ruleWeekdays.set(rule.weekdays);
        this.ruleMonthDays.set(rule.monthDays);
      },
      error: (e: unknown) => this.ruleErr.set(`Не удалось загрузить правило доставок: ${httpErr(e)}`),
    });
  }

  toggleRuleDay(kind: 'week' | 'month', value: number): void {
    if (this.ruleSaving()) return;
    const current = kind === 'week' ? this.ruleWeekdays() : this.ruleMonthDays();
    const next = current.includes(value)
        ? current.filter((day) => day !== value)
        : [...current, value].sort((a, b) => a - b);
    this.saveRule(kind === 'week'
        ? { weekdays: next, monthDays: this.ruleMonthDays() }
        : { weekdays: this.ruleWeekdays(), monthDays: next });
  }

  clearCurrentRule(): void {
    if (this.ruleSaving()) return;
    this.saveRule(this.deliveryTab() === 'week'
        ? { weekdays: [], monthDays: this.ruleMonthDays() }
        : { weekdays: this.ruleWeekdays(), monthDays: [] });
  }

  /** Чипы загораются сразу; при сбое откатываемся к правилу, которое лежит в БД. */
  private saveRule(next: DeliveryRule): void {
    const previous: DeliveryRule = { weekdays: this.ruleWeekdays(), monthDays: this.ruleMonthDays() };
    this.ruleWeekdays.set(next.weekdays);
    this.ruleMonthDays.set(next.monthDays);
    this.ruleSaving.set(true);
    this.ruleErr.set('');
    this.ruleMsg.set('');
    this.api.saveDeliveryRule$(next).pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.ruleSaving.set(false)),
    ).subscribe({
      next: () => {
        this.ruleMsg.set(this.ruleActive()
            ? `Сохранено: ${this.ruleSummaryLabel()} — такие дни календарь отмечает сразу.`
            : 'Правило выключено: даты добавляются только вручную.');
      },
      error: (e: unknown) => {
        this.ruleWeekdays.set(previous.weekdays);
        this.ruleMonthDays.set(previous.monthDays);
        this.ruleErr.set(`Не удалось сохранить правило: ${httpErr(e)}`);
      },
    });
  }

  load(quiet = false): void {
    if (!quiet) { this.err.set(''); this.msg.set(''); }
    this.api.settings$().subscribe({
      next: (s) => {
        this.st.set(s);
        this.viaProxy = s.gpt.viaProxy;
        this.proxyUrl = s.gpt.proxyUrl;
        this.test.set(null);
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  save(): void {
    this.busy.set(true);
    this.err.set('');
    this.msg.set('');
    this.api.saveGptSettings$({ viaProxy: this.viaProxy, proxyUrl: this.proxyUrl.trim() }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.viaProxy = r.gpt.viaProxy;
        this.proxyUrl = r.gpt.proxyUrl;
        this.msg.set(r.gpt.viaProxy ? `Сохранено: GPT через ${r.gpt.proxyUrl}` : 'Сохранено: GPT напрямую');
        this.load(true);
      },
      error: (e: unknown) => { this.busy.set(false); this.err.set(httpErr(e)); },
    });
  }

  runTest(): void {
    this.testing.set(true);
    this.err.set('');
    this.api.testGpt$().subscribe({
      next: (r) => { this.testing.set(false); this.test.set(r); },
      error: (e: unknown) => { this.testing.set(false); this.err.set(httpErr(e)); },
    });
  }

  // ---- категории номенклатуры ----
  loadCats(): void {
    this.api.rawCategories$().subscribe({
      next: (c) => this.cats.set(c),
      error: (e: unknown) => this.catsErr.set(httpErr(e)),
    });
  }

  createCat(): void {
    const name = this.newCatName().trim();
    if (!name) return;
    this.catsErr.set('');
    this.catsMsg.set('');
    this.api.createRawCategory$(name, this.newCatIcon(), this.newCatColor()).subscribe({
      next: () => {
        this.newCatName.set('');
        this.newCatIcon.set('');
        this.newCatColor.set('#eef2f7');
        this.catsMsg.set(`Категория «${name.toLowerCase()}» добавлена ✓`);
        this.loadCats();
      },
      error: (e: unknown) => this.catsErr.set(httpErr(e)),
    });
  }

  startRename(c: RawCategory): void {
    this.editingCat.set(c.id);
    this.editCatName.set(c.name);
    this.editCatIcon.set(c.icon ?? '');
    this.editCatColor.set(c.color || '#eef2f7');
  }

  saveRename(): void {
    const id = this.editingCat();
    const name = this.editCatName().trim();
    if (!id || !name) { this.editingCat.set(null); return; }
    this.catsErr.set('');
    this.catsMsg.set('');
    this.api.updateRawCategory$(id, { name, icon: this.editCatIcon(), color: this.editCatColor() }).subscribe({
      next: () => {
        this.editingCat.set(null);
        this.catsMsg.set('Категория изменена ✓');
        this.loadCats();
      },
      error: (e: unknown) => this.catsErr.set(httpErr(e)),
    });
  }

  deleteCat(c: RawCategory): void {
    if (!confirm(`Удалить категорию «${c.name}»? Её позиции перейдут в «прочее».`)) return;
    this.catsErr.set('');
    this.catsMsg.set('');
    this.api.deleteRawCategory$(c.id).subscribe({
      next: () => {
        this.catsMsg.set(`Категория «${c.name}» удалена`);
        this.loadCats();
      },
      error: (e: unknown) => this.catsErr.set(httpErr(e)),
    });
  }

  // ---- каталог продукции ----
  loadPcs(): void {
    this.api.productCatalogList$().subscribe({
      next: (c) => this.productCatalogs.set(c),
      error: (e: unknown) => this.pcErr.set(httpErr(e)),
    });
  }

  createPc(): void {
    const name = this.newPcName().trim();
    if (!name) return;
    this.pcErr.set('');
    this.pcMsg.set('');
    this.api.createProductCatalog$(name, this.newPcIcon().trim(), this.newPcColor()).subscribe({
      next: () => {
        this.newPcName.set('');
        this.newPcIcon.set('');
        this.pcMsg.set(`Каталог «${name.toLowerCase()}» добавлен ✓`);
        this.loadPcs();
      },
      error: (e: unknown) => this.pcErr.set(httpErr(e)),
    });
  }

  startPcRename(c: ProductCatalog): void {
    this.editingPc.set(c.id);
    this.editPcName.set(c.name);
    this.editPcIcon.set(c.icon ?? '');
    this.editPcColor.set(c.color || '#eef2f7');
  }

  savePcRename(): void {
    const id = this.editingPc();
    const name = this.editPcName().trim();
    if (!id || !name) { this.editingPc.set(null); return; }
    this.pcErr.set('');
    this.pcMsg.set('');
    this.api.updateProductCatalog$(id, {
      name,
      icon: this.editPcIcon().trim(),
      color: this.editPcColor(),
    }).subscribe({
      next: () => {
        this.editingPc.set(null);
        this.pcMsg.set('Каталог переименован ✓');
        this.loadPcs();
      },
      error: (e: unknown) => this.pcErr.set(httpErr(e)),
    });
  }

  deletePc(c: ProductCatalog): void {
    if (!confirm(`Удалить каталог «${c.name}»? Техкарты останутся, но без каталога.`)) return;
    this.pcErr.set('');
    this.pcMsg.set('');
    this.api.deleteProductCatalog$(c.id).subscribe({
      next: () => {
        this.pcMsg.set(`Каталог «${c.name}» удалён`);
        this.loadPcs();
      },
      error: (e: unknown) => this.pcErr.set(httpErr(e)),
    });
  }
}
