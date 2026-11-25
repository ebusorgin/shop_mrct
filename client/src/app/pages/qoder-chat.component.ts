import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, of, switchMap, take } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '../core/api.service';
import {
  QoderApproval,
  QoderApprovalDecision,
  QoderDialog,
  QoderJob,
  QoderJobEvent,
  QoderJobStatus,
  QoderMessage,
} from '../core/models';
import { httpErr } from '../core/format';

/**
 * Чат с Qoder: слева диалоги пользователя, справа переписка и ход работы агента.
 * Вопрос запускает фоновую задачу в папке проекта; команды и правки, требующие
 * разрешения, подтверждаются здесь же. История хранится в БД у пользователя.
 * Компонент живёт только на вкладке «Чат с Qoder» в настройках (админ).
 */
@Component({
  selector: 'app-qoder-chat',
  standalone: true,
  imports: [FormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }

    /* Тёмные тона: чат — «консоль» внутри светлых настроек. Все цвета ниже — через токены .qchat. */
    .qchat {
      --q-bg: #0b131e;
      --q-panel: #111c2a;
      --q-panel-2: #162334;
      --q-panel-3: #1b2b3f;
      --q-border: #263a51;
      --q-border-soft: #1d2d41;
      --q-text: #e6eef8;
      --q-muted: #8ba0b6;
      --q-blue: #3aa7ee;
      --q-blue-ink: #7cc4f5;
      --q-blue-soft: rgba(58, 167, 238, .14);
      --q-green: #4fd18b;
      --q-green-soft: rgba(52, 199, 120, .14);
      --q-red: #ff7b81;
      --q-red-soft: rgba(255, 99, 105, .13);
      --q-amber: #f0b429;
      --q-amber-soft: rgba(240, 180, 41, .12);
      --q-code: #0a111b;
      --q-hover: rgba(255, 255, 255, .07);
      display: grid; grid-template-columns: 276px minmax(0, 1fr); gap: 14px;
      height: clamp(560px, calc(100vh - 280px), 820px); color: var(--q-text);
    }
    .qchat ::selection { background: rgba(58, 167, 238, .35); color: #fff; }
    .qchat .muted { color: var(--q-muted); }

    /* ---------- левая колонка: диалоги ---------- */
    .qside {
      display: flex; flex-direction: column; min-width: 0; min-height: 0;
      border: 1px solid var(--q-border); border-radius: 14px;
      background: linear-gradient(180deg, var(--q-panel), var(--q-bg));
      box-shadow: 0 10px 24px rgba(4, 10, 18, .22); overflow: hidden;
    }
    .qside-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; }
    .qside-title { flex: 1 1 auto; color: var(--q-muted); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .qnew {
      flex: 0 0 auto; height: 28px; padding: 0 10px; border: 1px solid var(--q-border); border-radius: 8px;
      background: var(--q-panel-3); color: var(--q-blue-ink); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
    }
    .qnew:hover:not(:disabled) { background: #22374e; border-color: var(--q-blue); }
    .qnew:disabled { opacity: .5; cursor: not-allowed; }
    .qitems {
      flex: 1 1 auto; list-style: none; margin: 0; padding: 4px 8px 10px;
      overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
      scrollbar-color: #2c4258 transparent; scrollbar-width: thin;
    }
    .qitems li { position: relative; }
    .qitem {
      display: flex; flex-direction: column; gap: 3px; width: 100%;
      padding: 9px 30px 9px 10px; border: 1px solid transparent; border-left: 3px solid transparent;
      border-radius: 9px; background: transparent; color: var(--q-text); font: inherit; text-align: left; cursor: pointer;
    }
    .qitem:hover:not(:disabled) { background: var(--q-panel-2); }
    .qitem.on {
      background: #12324a; border-color: rgba(58, 167, 238, .3);
      border-left-color: var(--q-blue);
    }
    .qitem:disabled { cursor: default; opacity: .65; }
    .qtitle { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qmeta { display: flex; align-items: center; gap: 6px; color: var(--q-muted); font-size: 10.5px; }
    .qcount {
      padding: 0 6px; border-radius: 999px; background: rgba(255, 255, 255, .08);
      font-size: 9.5px; font-weight: 700; line-height: 15px; font-variant-numeric: tabular-nums;
    }
    .qitem.on .qcount { background: rgba(58, 167, 238, .22); color: #a8d9fb; }
    .qprev {
      color: var(--q-muted); font-size: 11px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .qdel {
      position: absolute; top: 7px; right: 5px; width: 24px; height: 24px; padding: 0;
      border: 0; border-radius: 6px; background: transparent; color: var(--q-muted);
      font-size: 12px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .12s ease;
    }
    .qitems li:hover .qdel, .qdel:focus-visible { opacity: 1; }
    .qdel:hover { background: var(--q-red-soft); color: #ff8a8f; }
    .qpad { padding: 10px 12px; }
    .qempty-list { margin: auto; padding: 22px 18px; color: var(--q-muted); font-size: 12px; line-height: 1.55; text-align: center; }
    .qempty-list .qel-ic {
      display: grid; place-items: center; width: 36px; height: 36px; margin: 0 auto 8px;
      border-radius: 11px; background: var(--q-blue-soft); color: var(--q-blue-ink); font-size: 17px;
    }

    /* ---------- правая колонка: чат ---------- */
    .qmain {
      display: flex; flex-direction: column; min-width: 0; min-height: 0;
      border: 1px solid var(--q-border); border-radius: 14px;
      background: var(--q-panel); box-shadow: 0 10px 24px rgba(4, 10, 18, .22); overflow: hidden;
    }
    .qhead {
      display: flex; align-items: center; gap: 10px; padding: 10px 14px;
      border-bottom: 1px solid var(--q-border); background: linear-gradient(180deg, var(--q-panel-2), var(--q-panel));
    }
    .qavatar {
      flex: 0 0 auto; display: grid; place-items: center; width: 34px; height: 34px;
      border-radius: 11px; background: linear-gradient(135deg, #2aa2e6, var(--brand-blue-dark));
      color: #fff; font-size: 16px; font-weight: 800; letter-spacing: -.02em;
      box-shadow: 0 3px 10px rgba(0, 102, 153, .45);
    }
    .qhead-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
    .qhead-title { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qstatus { display: inline-flex; align-items: center; gap: 6px; color: var(--q-muted); font-size: 11px; }
    .qstatus .qdot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--q-muted); }
    .qstatus.running .qdot { background: var(--q-blue); animation: qpulse 1.1s ease-in-out infinite; }
    .qstatus.await .qdot { background: var(--q-amber); animation: qpulse 1.1s ease-in-out infinite; }
    .qstatus.offline .qdot { background: var(--q-amber); }
    .qstatus.bad .qdot { background: #ff6b70; }
    .qstop { flex: 0 0 auto; }

    .qmessages {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
      scrollbar-color: #2c4258 transparent; scrollbar-width: thin;
      display: flex; flex-direction: column; gap: 14px; padding: 18px 16px;
      background:
        radial-gradient(circle at 100% 0, rgba(31, 145, 217, .1), transparent 46%),
        linear-gradient(180deg, #0d1724, var(--q-bg));
    }

    .qwelcome { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 460px; padding: 20px; text-align: center; }
    .qwelcome .qavatar { width: 46px; height: 46px; border-radius: 14px; font-size: 22px; }
    .qwelcome h4 { margin: 2px 0 0; font-size: 16px; }
    .qwelcome p { margin: 0; color: var(--q-muted); font-size: 12.5px; line-height: 1.55; }
    .qexamples { display: flex; flex-wrap: wrap; justify-content: center; gap: 7px; margin-top: 4px; }
    .qexample {
      padding: 6px 12px; border: 1px solid var(--q-border); border-radius: 999px;
      background: var(--q-panel-2); color: var(--q-blue-ink); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
    }
    .qexample:hover { background: var(--q-panel-3); border-color: color-mix(in srgb, var(--q-blue) 45%, var(--q-border)); }

    .qrow { display: flex; align-items: flex-start; gap: 9px; max-width: 86%; animation: qin .18s ease; }
    .qrow.user { margin-left: auto; }
    .qrow .qavatar { width: 30px; height: 30px; border-radius: 9px; font-size: 14px; box-shadow: none; }
    .qcol { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .qrow.user .qcol { align-items: flex-end; }
    .qwho { display: flex; align-items: baseline; gap: 7px; color: var(--q-muted); font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .qtime { font-size: 10px; font-weight: 400; letter-spacing: 0; text-transform: none; opacity: .8; }
    .qbubble {
      padding: 10px 13px; border: 1px solid var(--q-border); border-radius: 14px; border-top-left-radius: 4px;
      background: var(--q-panel-2); box-shadow: 0 2px 6px rgba(0, 0, 0, .22);
      font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .qrow.user .qbubble {
      border-color: transparent; border-radius: 14px; border-top-right-radius: 4px;
      background: linear-gradient(135deg, #0e83c9, var(--brand-blue-dark)); color: #fff;
      box-shadow: 0 3px 10px rgba(0, 60, 100, .4);
    }

    /* ---------- ход работы ---------- */
    .qtrace {
      align-self: stretch; max-width: 100%; border: 1px solid var(--q-border); border-radius: 12px;
      background: var(--q-panel-2);
      box-shadow: 0 2px 8px rgba(0, 0, 0, .25); overflow: hidden;
    }
    .qtrace-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--q-border); background: var(--q-panel-3); font-size: 12px; }
    .qtrace.collapsed .qtrace-head { border-bottom: 0; }
    .qtrace-head b { font-size: 12px; }
    .qtrace-head .qspacer { flex: 1 1 auto; }
    .qtrace-badge { padding: 1px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 700; }
    .qtrace-badge.running { background: var(--q-blue-soft); color: var(--q-blue-ink); }
    .qtrace-badge.done { background: var(--q-green-soft); color: var(--q-green); }
    .qtrace-badge.error { background: var(--q-red-soft); color: var(--q-red); }
    .qtrace-badge.cancelled { background: var(--q-hover); color: var(--q-muted); }
    .qtrace-count { color: var(--q-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .qghost {
      flex: 0 0 auto; display: grid; place-items: center; width: 26px; height: 26px; padding: 0;
      border: 0; border-radius: 7px; background: transparent; color: var(--q-muted); font-size: 12px; line-height: 1; cursor: pointer;
    }
    .qghost:hover { background: var(--q-hover); color: var(--q-text); }
    .qghost:focus-visible { outline: 2px solid var(--q-blue); outline-offset: 1px; }
    .qtrace-body { max-height: 240px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 4px 8px 6px; scrollbar-color: #2c4258 transparent; scrollbar-width: thin; }
    .qev {
      display: flex; gap: 9px; padding: 7px 2px; font-size: 12px;
      border-bottom: 1px dashed var(--q-border-soft);
    }
    .qev:last-child { border-bottom: 0; }
    .qev-ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 22px; height: 22px; margin-top: 1px;
      border-radius: 7px; background: var(--q-hover); color: var(--q-muted); font-size: 11px; font-weight: 800;
    }
    .qev-ic.tool { background: var(--q-blue-soft); color: var(--q-blue-ink); }
    .qev-ic.ok { background: var(--q-green-soft); color: var(--q-green); }
    .qev-ic.bad { background: var(--q-red-soft); color: var(--q-red); }
    .qev-ic.think { font-style: italic; }
    .qev-main { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
    .qev-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .qev-kind { flex: 0 0 auto; color: var(--q-muted); font-size: 9.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    .qev-title { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
    .qev.tool .qev-title { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
    .qev.error .qev-title { color: var(--q-red); }
    .qev-time { flex: 0 0 auto; color: var(--q-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
    .qev-text { font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .qev pre {
      margin: 3px 0 0; padding: 7px 9px; max-height: 160px; overflow: auto; border: 1px solid var(--q-border-soft);
      border-radius: 7px; background: var(--q-code); color: var(--q-text);
      font-size: 11px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .qev pre.qthink { padding: 0; border: 0; background: transparent; color: var(--q-muted); font-style: italic; max-height: none; }
    .qbusy { display: flex; align-items: center; gap: 8px; padding: 8px 12px 9px; border-top: 1px solid var(--q-border-soft); color: var(--q-muted); font-size: 11.5px; }
    .qbusy .qdots { display: inline-flex; gap: 3px; }
    .qbusy .qdots i { width: 5px; height: 5px; border-radius: 50%; background: var(--q-blue); animation: qblink 1.1s infinite; }
    .qbusy .qdots i:nth-child(2) { animation-delay: .15s; }
    .qbusy .qdots i:nth-child(3) { animation-delay: .3s; }

    /* ---------- подтверждение ---------- */
    .qapproval {
      margin: 0 14px 10px; padding: 11px 13px;
      border: 1px solid color-mix(in srgb, var(--q-amber) 40%, var(--q-border)); border-left: 4px solid var(--q-amber);
      border-radius: 12px; background: linear-gradient(180deg, rgba(240, 180, 41, .12), rgba(240, 180, 41, .04));
      box-shadow: 0 6px 20px rgba(0, 0, 0, .3); animation: qslide .2s ease;
    }
    .qapproval-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .qapproval-head b { font-size: 12.5px; }
    .qapproval-ic {
      display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--q-amber) 35%, transparent); background: rgba(0, 0, 0, .28);
      color: var(--q-amber); font-size: 11px; font-weight: 900;
    }
    .qapproval-tool {
      margin-left: auto; padding: 1px 7px; border: 1px solid color-mix(in srgb, var(--q-amber) 30%, var(--q-border));
      border-radius: 6px; background: rgba(0, 0, 0, .28); color: var(--q-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px;
    }
    .qapproval-title { margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .qapproval-desc { margin-top: 4px; color: var(--q-muted); font-size: 11.5px; line-height: 1.45; }
    .qapproval pre {
      margin: 8px 0; padding: 8px; max-height: 160px; overflow: auto;
      border: 1px solid color-mix(in srgb, var(--q-amber) 20%, var(--q-border)); border-radius: 8px; background: var(--q-code);
      font-size: 11px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .qapproval-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }

    /* ---------- поле ввода ---------- */
    .qerr { margin: 0 14px 8px; }
    .qcomposer { padding: 10px 14px 8px; border-top: 1px solid var(--q-border); background: var(--q-panel); }
    .qcomposer-box {
      display: flex; align-items: flex-end; gap: 8px; padding: 5px 5px 5px 12px;
      border: 1px solid var(--q-border); border-radius: 14px; background: var(--q-panel-2);
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .qcomposer-box:focus-within { border-color: var(--q-blue); box-shadow: 0 0 0 3px var(--q-blue-soft); }
    .qcomposer textarea {
      flex: 1 1 auto; min-height: 38px; max-height: 150px; padding: 8px 0; resize: none;
      border: 0; border-radius: 0; background: transparent; color: inherit; font-size: 13px; line-height: 1.5;
      field-sizing: content;
    }
    .qcomposer textarea::placeholder { color: var(--q-muted); }
    .qcomposer textarea:focus { border-color: transparent; box-shadow: none; }
    .qsend {
      flex: 0 0 auto; display: grid; place-items: center; width: 36px; height: 36px;
      border: 0; border-radius: 10px; color: #fff; font-size: 17px; font-weight: 700; cursor: pointer;
      background: linear-gradient(135deg, var(--brand-blue), var(--brand-blue-dark));
      box-shadow: 0 3px 8px color-mix(in srgb, var(--brand-blue-dark) 28%, transparent);
    }
    .qsend:hover:not(:disabled) { filter: brightness(1.06); }
    .qsend:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
    .qfull {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; height: 36px;
      margin: 0 2px 0 0; padding: 0 8px; border: 1px solid transparent; border-radius: 10px;
      color: var(--q-muted); font-size: 11px; font-weight: 700; cursor: pointer; user-select: none;
      transition: background .15s ease, color .15s ease, border-color .15s ease;
    }
    .qfull input { width: 14px; height: 14px; margin: 0; accent-color: var(--q-blue); cursor: pointer; }
    .qfull:hover { background: var(--q-hover); color: var(--q-text); }
    .qfull.on {
      color: var(--q-blue-ink); background: var(--q-blue-soft);
      border-color: color-mix(in srgb, var(--q-blue) 32%, transparent);
    }
    .qhint { margin-top: 6px; padding-left: 2px; color: var(--q-muted); font-size: 10.5px; }

    /* тёмный вариант общих кнопок внутри чата: светлые кнопки на тёмной панели выглядят чужеродно */
    .qchat .btn { border-color: var(--q-border); background: var(--q-panel-2); color: var(--q-text); }
    .qchat .btn:hover:not(:disabled) { background: var(--q-panel-3); border-color: #33506e; }
    .qchat .btn:active:not(:disabled) { background: var(--q-panel-3); }
    .qchat .btn.primary { border-color: var(--brand-blue); background: var(--brand-blue); color: #fff; }
    .qchat .btn.primary:hover:not(:disabled) { border-color: var(--brand-blue-dark); background: var(--brand-blue-dark); }
    .qchat .btn.danger { border-color: rgba(255, 123, 129, .5); background: var(--q-red-soft); color: var(--q-red); }
    .qchat .btn.danger:hover:not(:disabled) { border-color: var(--q-red); background: rgba(255, 99, 105, .22); }
    .qchat .err { background: var(--q-red-soft); color: var(--q-red); }

    @keyframes qpulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }
    @keyframes qblink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
    @keyframes qin { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @keyframes qslide { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    @media (max-width: 900px) {
      .qchat { grid-template-columns: 1fr; height: auto; gap: 10px; }
      .qside { max-height: 240px; }
      .qitems { max-height: 176px; }
      .qmain { height: min(72vh, 640px); height: min(72dvh, 640px); }
      .qrow { max-width: 94%; }
      .qdel { opacity: 1; }
      .qev-time { display: none; }
      /* вложенный скролл на телефоне не должен запирать жест: у края он обязан уходить странице,
         иначе из низа чата не добраться до вкладок и меню */
      .qitems, .qmessages, .qtrace-body { overscroll-behavior: auto; }
      /* iOS/Android иначе приближают страницу при фокусе на поле и оставляют её «застрявшей» */
      .qcomposer textarea { font-size: 16px; }
    }
    @media (max-width: 520px) {
      .qhead { padding: 9px 10px; }
      .qmessages { padding: 14px 10px; }
      .qcomposer { padding: 8px 10px 6px; }
      .qapproval { margin: 0 10px 8px; }
      .qexamples { flex-direction: column; align-items: stretch; }
      .qhint { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .qrow, .qapproval { animation: none; }
      .qstatus .qdot, .qbusy .qdots i { animation: none; }
    }
  `],
  template: `
    <div class="qchat">
      <aside class="qside">
        <div class="qside-head">
          <span class="qside-title">Диалоги</span>
          <button type="button" class="qnew" (click)="newDialog()" [disabled]="busy()">+ Новый</button>
        </div>
        @if (listErr()) { <div class="err qpad">{{ listErr() }}</div> }
        @if (loadingList()) {
          <div class="muted qpad">Загружаем…</div>
        } @else if (!dialogs().length) {
          <div class="qempty-list">
            <div class="qel-ic" aria-hidden="true">💬</div>
            Диалогов пока нет.<br>Начните новый — Qoder выполнит задачу в проекте.
          </div>
        } @else {
          <ul class="qitems">
            @for (d of dialogs(); track d.id) {
              <li>
                <button type="button" class="qitem" [class.on]="selectedId() === d.id" (click)="select(d)" [disabled]="busy()">
                  <span class="qtitle">{{ d.title }}</span>
                  <span class="qmeta">
                    <span>{{ d.updatedAt }}</span>
                    @if (d.messageCount) { <span class="qcount">{{ d.messageCount }}</span> }
                  </span>
                  @if (d.preview) { <span class="qprev">{{ d.preview }}</span> }
                </button>
                <button type="button" class="qdel" title="Удалить диалог" aria-label="Удалить диалог" (click)="remove(d, $event)" [disabled]="busy()">✕</button>
              </li>
            }
          </ul>
        }
      </aside>

      <section class="qmain">
        <div class="qhead">
          <div class="qavatar" aria-hidden="true">Q</div>
          <div class="qhead-text">
            <div class="qhead-title">{{ selectedTitle() || 'Новый диалог' }}</div>
            @if (job(); as j) {
              @if (j.status === 'running') {
                <span class="qstatus" [class.await]="!!pendingApproval()" [class.offline]="!live() && !pendingApproval()">
                  <i class="qdot"></i>
                  {{ pendingApproval() ? 'ждёт вашего подтверждения' : live() ? 'работает в проекте' : 'переподключение…' }}
                </span>
              } @else {
                <span class="qstatus" [class.bad]="j.status === 'error'">
                  <i class="qdot"></i>
                  {{ j.status === 'error' ? 'задача завершилась ошибкой' : 'задача остановлена' }}
                </span>
              }
            } @else {
              <span class="qstatus"><i class="qdot"></i>Qoder CLI в проекте</span>
            }
          </div>
          @if (job()?.status === 'running') {
            <button type="button" class="btn sm qstop" (click)="stop()" [disabled]="stopping()">Остановить</button>
          }
        </div>

        <div class="qmessages" #scroller (scroll)="onMessagesScroll()">
          @if (!messages().length && !job()) {
            <div class="qwelcome">
              <div class="qavatar" aria-hidden="true">Q</div>
              <h4>Чем помочь в проекте?</h4>
              <p>
                Qoder читает и меняет файлы, ищет код, запускает команды и тесты. Опасные действия
                он попросит подтвердить прямо здесь, а история диалогов сохранится у вашей учётной записи.
              </p>
              <div class="qexamples">
                @for (p of examples; track p) {
                  <button type="button" class="qexample" (click)="useExample(p)">{{ p }}</button>
                }
              </div>
            </div>
          }
          @for (m of messages(); track m.id) {
            <div class="qrow" [class.user]="m.role === 'user'">
              @if (m.role !== 'user') { <div class="qavatar" aria-hidden="true">Q</div> }
              <div class="qcol">
                <div class="qwho">
                  {{ m.role === 'user' ? 'Вы' : 'Qoder' }}
                  <span class="qtime">{{ m.createdAt }}</span>
                </div>
                <div class="qbubble">{{ m.content }}</div>
              </div>
            </div>
          }
          @if (job(); as j) {
            <section class="qtrace" [class.collapsed]="traceCollapsed()">
              <div class="qtrace-head">
                <b>Ход работы</b>
                <span class="qtrace-badge" [class.running]="j.status === 'running'" [class.done]="j.status === 'done'" [class.error]="j.status === 'error'" [class.cancelled]="j.status === 'cancelled'">{{ jobStatus(j.status) }}</span>
                <span class="qspacer"></span>
                @if (j.events.length) { <span class="qtrace-count">{{ stepsLabel(j.events.length) }}</span> }
                <button type="button" class="qghost" (click)="toggleTrace()" [attr.aria-expanded]="!traceCollapsed()" [title]="traceCollapsed() ? 'Развернуть ход работы' : 'Свернуть ход работы'">{{ traceCollapsed() ? '▾' : '▴' }}</button>
              </div>
              @if (!traceCollapsed()) {
                @if (j.events.length) {
                  <div class="qtrace-body" #actbody (scroll)="onActivityScroll()">
                    @for (e of j.events; track e.seq) {
                      <div class="qev" [class.tool]="e.kind === 'tool'" [class.error]="e.kind === 'error' || e.status === 'error'">
                        <span class="qev-ic" [class.tool]="e.kind === 'tool'" [class.ok]="e.kind === 'tool_result' && e.status !== 'error'" [class.bad]="e.kind === 'error' || e.status === 'error'" [class.think]="e.kind === 'thinking'">{{ eventIcon(e) }}</span>
                        <div class="qev-main">
                          <div class="qev-top">
                            <span class="qev-kind">{{ eventKind(e.kind) }}</span>
                            @if (e.kind !== 'text') { <span class="qev-title">{{ e.title }}</span> }
                            <span class="qev-time">{{ e.at | date:'HH:mm:ss' }}</span>
                          </div>
                          @switch (e.kind) {
                            @case ('text') {
                              @if (e.detail) { <div class="qev-text">{{ e.detail }}</div> }
                            }
                            @case ('thinking') {
                              @if (e.detail) { <pre class="qthink">{{ e.detail }}</pre> }
                            }
                            @default {
                              @if (e.detail) { <pre>{{ e.detail }}</pre> }
                            }
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
                @if (!pendingApproval() && j.status === 'running') {
                  <div class="qbusy"><span class="qdots"><i></i><i></i><i></i></span> Qoder думает…</div>
                }
              }
            </section>
          }
        </div>

        @if (pendingApproval(); as a) {
          <div class="qapproval" role="alert">
            <div class="qapproval-head">
              <span class="qapproval-ic" aria-hidden="true">!</span>
              <b>Нужно подтверждение</b>
              <span class="qapproval-tool">{{ a.tool }}</span>
            </div>
            <div class="qapproval-title">{{ a.title }}</div>
            @if (a.description && a.description !== a.title) { <div class="qapproval-desc">{{ a.description }}</div> }
            @if (a.preview && a.preview !== a.title) { <pre>{{ a.preview }}</pre> }
            <div class="qapproval-actions">
              <button type="button" class="btn primary sm" (click)="decide(a, 'once')" [disabled]="!!deciding()">Разрешить</button>
              @if (a.canAlways) {
                <button type="button" class="btn sm" (click)="decide(a, 'always')" [disabled]="!!deciding()">Разрешить и запомнить</button>
              }
              <button type="button" class="btn danger sm" (click)="decide(a, 'deny')" [disabled]="!!deciding()">Отклонить</button>
            </div>
          </div>
        }
        @if (err()) { <div class="err qerr" role="alert">{{ err() }}</div> }
        <div class="qcomposer">
          <div class="qcomposer-box">
            <textarea
              [ngModel]="draft()"
              (ngModelChange)="draft.set($event)"
              [disabled]="busy()"
              maxlength="4000"
              rows="1"
              placeholder="Спросите Qoder…"
              aria-label="Сообщение для Qoder"
              (keydown.enter)="onEnter($event)"
            ></textarea>
            <label
              class="qfull"
              [class.on]="autoApprove()"
              title="full — не спрашивать подтверждений в этом диалоге: опасные действия выполняются сразу"
            >
              <input
                type="checkbox"
                [checked]="autoApprove()"
                (change)="onAutoToggle($event)"
                aria-label="Не спрашивать подтверждений в этом диалоге"
              />
              <span>full</span>
            </label>
            <button type="button" class="qsend" (click)="send()" [disabled]="busy() || !draft().trim()" title="Отправить (Enter)" aria-label="Отправить">↑</button>
          </div>
          <div class="qhint">Enter — отправить · Shift + Enter — новая строка</div>
        </div>
      </section>
    </div>
  `,
})
export class QoderChatComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private actBody = viewChild<ElementRef<HTMLElement>>('actbody');

  readonly dialogs = signal<QoderDialog[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly selectedTitle = signal('');
  readonly messages = signal<QoderMessage[]>([]);
  readonly draft = signal('');
  readonly loadingList = signal(true);
  readonly starting = signal(false);
  readonly stopping = signal(false);
  readonly deciding = signal<string | null>(null);
  readonly job = signal<QoderJob | null>(null);
  readonly live = signal(false);
  readonly err = signal('');
  readonly listErr = signal('');
  readonly traceCollapsed = signal(false);
  /** «full»: в этом диалоге подтверждения выдаются автоматически; настройка хранится по диалогу. */
  readonly autoApprove = signal(false);

  /** Подсказки для пустой ленты: подставляются в поле ввода, отправляет пользователь. */
  readonly examples = [
    'Проверь, что проект собирается',
    'Где считается остаток товара?',
    'Найди ошибку в последней накладной',
  ];

  /** WebSocket задачи: снимки приходят с сервера, опроса по HTTP нет. */
  private ws: WebSocket | null = null;
  private wsTimer?: ReturnType<typeof setTimeout>;
  private wsAttempts = 0;
  private watchJobId: string | null = null;
  private destroyed = false;
  private lastEventSeq = 0;
  /** Лента и «ход работы» держатся за низ, только пока пользователь сам находится внизу. */
  private stickBottom = true;
  private stickActivity = true;
  /** Запросы, по которым «full» уже отправил решение: защита от дублей на повторных снимках сокета. */
  private autoDecided = new Set<string>();
  private static readonly AUTO_KEY = 'qoder.fullDialogs';

  ngOnInit(): void {
    this.loadList(true);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopWatch();
  }

  busy(): boolean {
    return this.starting() || this.job()?.status === 'running';
  }

  pendingApproval(): QoderApproval | null {
    return this.job()?.approvals.find((a) => !a.resolved) ?? null;
  }

  eventKind(kind: QoderJobEvent['kind']): string {
    if (kind === 'tool') return 'инструмент';
    if (kind === 'tool_result') return 'результат';
    if (kind === 'error') return 'ошибка';
    if (kind === 'text') return 'текст';
    if (kind === 'thinking') return 'мысль';
    return 'статус';
  }

  eventIcon(e: QoderJobEvent): string {
    if (e.kind === 'tool') return '⚙';
    if (e.kind === 'tool_result') return e.status === 'error' ? '✕' : '✓';
    if (e.kind === 'thinking') return '✻';
    if (e.kind === 'text') return '¶';
    if (e.kind === 'error') return '!';
    return '•';
  }

  jobStatus(status: QoderJobStatus): string {
    if (status === 'running') return 'выполняется';
    if (status === 'done') return 'готово';
    if (status === 'error') return 'ошибка';
    return 'остановлено';
  }

  stepsLabel(n: number): string {
    const last = n % 10;
    const teen = n % 100;
    if (last === 1 && teen !== 11) return `${n} шаг`;
    if (last >= 2 && last <= 4 && (teen < 12 || teen > 14)) return `${n} шага`;
    return `${n} шагов`;
  }

  toggleTrace(): void {
    this.traceCollapsed.update((v) => !v);
  }

  useExample(text: string): void {
    if (this.busy()) return;
    this.draft.set(text);
  }

  onAutoToggle(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.autoApprove.set(on);
    this.persistAuto(this.selectedId(), on);
    if (on) this.autoDecide();
  }

  /** «full» помнится за диалогом в браузере: вернувшись к нему, подтверждения снова не спрашиваются. */
  private savedAuto(dialogId: number | null): boolean {
    if (dialogId == null) return false;
    try {
      const raw = window.localStorage.getItem(QoderChatComponent.AUTO_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      return map[String(dialogId)] === true;
    } catch {
      return false;
    }
  }

  private persistAuto(dialogId: number | null, on: boolean): void {
    if (dialogId == null) return;
    try {
      const raw = window.localStorage.getItem(QoderChatComponent.AUTO_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      if (on) map[String(dialogId)] = true;
      else delete map[String(dialogId)];
      window.localStorage.setItem(QoderChatComponent.AUTO_KEY, JSON.stringify(map));
    } catch {
      /* приватный режим: настройка останется только в памяти */
    }
  }

  /**
   * «full»: текущий запрос на подтверждение разрешается без вопроса — «запомнить»,
   * если CLI умеет, иначе однократно. Дальше каждый новый запрос диалога тоже гасится здесь.
   */
  private autoDecide(): void {
    const current = this.job();
    if (!this.autoApprove() || !current || current.status !== 'running' || this.deciding()) return;
    const pending = current.approvals.find((a) => !a.resolved);
    if (!pending || this.autoDecided.has(pending.id)) return;
    this.autoDecided.add(pending.id);
    this.decide(pending, pending.canAlways ? 'always' : 'once');
  }

  private loadList(selectFirst: boolean): void {
    this.loadingList.set(true);
    this.listErr.set('');
    this.api
      .qoderDialogs$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.dialogs.set(list);
          this.loadingList.set(false);
          if (selectFirst && !this.selectedId() && list.length) this.select(list[0]);
        },
        error: (e) => {
          this.loadingList.set(false);
          this.listErr.set(httpErr(e));
        },
      });
  }

  newDialog(): void {
    if (this.busy()) return;
    this.stopWatch();
    this.stickBottom = true;
    this.stickActivity = true;
    this.job.set(null);
    this.selectedId.set(null);
    this.selectedTitle.set('');
    this.messages.set([]);
    this.err.set('');
    this.draft.set('');
    this.autoApprove.set(false);
  }

  select(d: QoderDialog): void {
    if (this.busy()) return;
    this.stopWatch();
    this.stickBottom = true;
    this.stickActivity = true;
    this.job.set(null);
    this.err.set('');
    this.autoApprove.set(this.savedAuto(d.id));
    this.selectedId.set(d.id);
    this.selectedTitle.set(d.title);
    this.api
      .qoderDialog$(d.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (full) => {
          this.selectedTitle.set(full.title);
          this.messages.set(full.messages);
          this.scrollBottom(true);
          this.resumeJob(d.id);
        },
        error: (e) => this.err.set(httpErr(e)),
      });
  }

  /** После перезагрузки страницы возвращаемся к ещё выполняющейся задаче диалога. */
  private resumeJob(dialogId: number): void {
    this.api
      .qoderDialogJob$(dialogId)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (r.job && r.job.status === 'running') {
            this.job.set(r.job);
            this.startWatch(r.job.id);
            this.autoDecide();
          }
        },
        error: () => undefined,
      });
  }

  remove(d: QoderDialog, event: Event): void {
    event.stopPropagation();
    if (this.busy() || !confirm(`Удалить диалог «${d.title}»?`)) return;
    this.api
      .deleteQoderDialog$(d.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          const rest = this.dialogs().filter((x) => x.id !== d.id);
          this.dialogs.set(rest);
          if (this.selectedId() === d.id) {
            if (rest.length) this.select(rest[0]);
            else this.newDialog();
          }
        },
        error: (e) => this.listErr.set(httpErr(e)),
      });
  }

  onEnter(event: Event): void {
    const ke = event as KeyboardEvent;
    if (ke.shiftKey) return;
    ke.preventDefault();
    this.send();
  }

  send(): void {
    const text = this.draft().trim();
    if (!text || this.busy()) return;
    this.err.set('');
    this.stopWatch();
    this.job.set(null);
    this.traceCollapsed.set(false);
    this.starting.set(true);
    const pending: QoderMessage = { id: -Date.now(), role: 'user', content: text, createdAt: 'сейчас' };
    this.messages.update((list) => [...list, pending]);
    this.draft.set('');
    this.scrollBottom(true);

    let createdId: number | null = null;
    const id$: Observable<number> = this.selectedId()
      ? of(this.selectedId()!)
      : this.api.createQoderDialog$().pipe(
          map((created) => {
            createdId = created.id;
            this.persistAuto(created.id, this.autoApprove());
            this.selectedId.set(created.id);
            this.selectedTitle.set(created.title);
            return created.id;
          })
        );

    id$
      .pipe(
        switchMap((id) => this.api.sendQoderMessage$(id, text)),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (r) => {
          this.starting.set(false);
          this.messages.update((list) => [...list.filter((m) => m.id !== pending.id), r.userMessage]);
          this.selectedTitle.set(r.title);
          this.job.set({ id: r.jobId, status: 'running', events: [], approvals: [], title: r.title });
          this.startWatch(r.jobId);
          this.loadList(false);
          this.scrollBottom(true);
        },
        error: (e) => {
          this.starting.set(false);
          this.messages.update((list) => list.filter((m) => m.id !== pending.id));
          this.draft.set(text);
          this.err.set(httpErr(e));
          // Диалог создан именно этим сообщением и остался пустым — не оставляем мусор в списке.
          if (createdId != null) {
            const id = createdId;
            this.api
              .deleteQoderDialog$(id)
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe({ next: () => this.loadList(false), error: () => this.loadList(false) });
            this.selectedId.set(null);
            this.selectedTitle.set('');
          }
        },
      });
  }

  decide(approval: QoderApproval, decision: QoderApprovalDecision): void {
    const current = this.job();
    if (!current || current.status !== 'running' || this.deciding()) return;
    this.err.set('');
    this.deciding.set(approval.id);
    this.api
      .approveQoder$(current.id, approval.id, decision)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          this.deciding.set(null);
          this.applyJob(job);
        },
        error: (e) => {
          this.deciding.set(null);
          // «full» повторит решение на следующем снимке задачи.
          this.autoDecided.delete(approval.id);
          this.err.set(httpErr(e));
        },
      });
  }

  stop(): void {
    const current = this.job();
    if (!current || current.status !== 'running' || this.stopping()) return;
    this.stopping.set(true);
    this.api
      .cancelQoderJob$(current.id)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          this.stopping.set(false);
          this.applyJob(job);
        },
        error: (e) => {
          this.stopping.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  /** Подписаться на задачу по сокету: снимок и все изменения придут кадром «job». */
  private startWatch(jobId: string): void {
    this.stopWatch();
    this.watchJobId = jobId;
    this.openSocket();
  }

  private stopWatch(): void {
    this.watchJobId = null;
    this.lastEventSeq = 0;
    this.autoDecided.clear();
    this.live.set(false);
    if (this.wsTimer) {
      clearTimeout(this.wsTimer);
      this.wsTimer = undefined;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
    }
  }

  private openSocket(): void {
    if (typeof window === 'undefined') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.subscribeJob();
      return;
    }
    if (this.wsTimer) {
      clearTimeout(this.wsTimer);
      this.wsTimer = undefined;
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/ws/qoder`);
    this.ws = ws;
    ws.onopen = () => {
      this.wsAttempts = 0;
      this.live.set(true);
      this.subscribeJob();
    };
    ws.onmessage = (ev) => this.onSocket(ev.data);
    ws.onclose = () => {
      this.live.set(false);
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
    };
  }

  /** После переподключения повторяем подписку — сервер сразу пришлёт полный снимок. */
  private subscribeJob(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.watchJobId) return;
    try {
      ws.send(JSON.stringify({ type: 'subscribe', jobId: this.watchJobId }));
    } catch {
      /* закроется — переподключимся */
    }
  }

  private scheduleReconnect(): void {
    if (this.wsTimer || !this.watchJobId || this.destroyed) return;
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(this.wsAttempts++, 4));
    this.wsTimer = setTimeout(() => {
      this.wsTimer = undefined;
      if (!this.watchJobId || this.destroyed) return;
      this.openSocket();
    }, delay);
  }

  private onSocket(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg['type'] === 'hello') {
      this.live.set(true);
      return;
    }
    if (msg['type'] === 'job') {
      const job = msg['job'] as QoderJob | undefined;
      if (!job || !this.watchJobId || job.id !== this.watchJobId) return;
      this.applyJob(job);
      return;
    }
    if (msg['type'] === 'gone') {
      if (msg['jobId'] !== this.watchJobId) return;
      this.stopWatch();
      this.reloadDialog();
      return;
    }
    if (msg['type'] === 'error') {
      this.err.set(String(msg['message'] ?? 'Ошибка канала Qoder'));
    }
  }

  /** Задача истекла, пока вкладка была закрыта: подтягиваем сохранённую историю. */
  private reloadDialog(): void {
    const id = this.selectedId();
    if (!id) return;
    this.api
      .qoderDialog$(id)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (full) => {
          this.messages.set(full.messages);
          this.selectedTitle.set(full.title);
          this.scrollBottom(true);
        },
        error: () => undefined,
      });
  }

  private applyJob(job: QoderJob): void {
    if (this.job()?.id && this.job()!.id !== job.id) return;
    this.job.set(job);
    if (job.status === 'running') {
      const seq = job.events.length ? job.events[job.events.length - 1].seq : 0;
      if (seq !== this.lastEventSeq) {
        this.lastEventSeq = seq;
        this.scrollBottom();
      }
      this.scrollActivity();
      this.autoDecide();
      return;
    }

    this.stopWatch();
    if (job.status === 'done') {
      const answer: QoderMessage =
        job.assistantMessage ??
        { id: -Date.now(), role: 'assistant', content: job.answer ?? '', createdAt: 'сейчас' };
      this.messages.update((list) => [...list, answer]);
      if (job.title) this.selectedTitle.set(job.title);
      this.job.set(null);
      this.loadList(false);
      this.scrollBottom();
      return;
    }

    this.err.set(job.error || (job.status === 'cancelled' ? 'Задача остановлена' : 'Qoder завершил задачу с ошибкой'));
    this.loadList(false);
  }

  onMessagesScroll(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    this.stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 96;
  }

  onActivityScroll(): void {
    const el = this.actBody()?.nativeElement;
    if (!el) return;
    this.stickActivity = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  }

  /** force — когда низ обязателен (отправка, смена диалога), иначе не отбираем прокрутку у читающего. */
  private scrollBottom(force = false): void {
    if (force) this.stickBottom = true;
    requestAnimationFrame(() => {
      if (!this.stickBottom) return;
      const el = this.scroller()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  /** Лента «хода работы» тоже растёт на глазах — держим её внизу, пока её не прокрутили вручную. */
  private scrollActivity(): void {
    requestAnimationFrame(() => {
      if (!this.stickActivity) return;
      const el = this.actBody()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}
