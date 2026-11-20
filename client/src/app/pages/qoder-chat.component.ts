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
import { Observable, Subscription, of, switchMap, take } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '../core/api.service';
import {
  QoderApproval,
  QoderApprovalDecision,
  QoderDialog,
  QoderJob,
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
    .qchat { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: 16px; min-height: 520px; }
    .qlist { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); overflow: hidden; }
    .qlist-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .qlist ul { list-style: none; margin: 0; padding: 6px; overflow-y: auto; max-height: 560px; }
    .qlist li { position: relative; }
    .qitem { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 9px 30px 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .qitem:hover { background: var(--panel); }
    .qitem.on { background: var(--panel); border-color: var(--border); box-shadow: 0 1px 3px rgba(15,23,42,.06); }
    .qitem:disabled { cursor: default; opacity: .7; }
    .qtitle { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qmeta { color: var(--muted); font-size: 11px; }
    .qprev { color: var(--muted); font-size: 11px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .qdel { position: absolute; top: 7px; right: 6px; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 13px; line-height: 1; cursor: pointer; opacity: 0; }
    .qlist li:hover .qdel, .qdel:focus-visible { opacity: 1; }
    .qdel:hover { background: var(--red-soft); color: var(--red); }
    .qpad { padding: 10px 12px; }
    .qmain { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); overflow: hidden; }
    .qmain-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg); }
    .qmain-head b { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qmain-head .qspacer { flex: 1 1 auto; }
    .qmessages { flex: 1 1 auto; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 12px; max-height: 560px; }
    .qempty { margin: auto; max-width: 420px; color: var(--muted); font-size: 13px; line-height: 1.5; text-align: center; }
    .qmsg { max-width: 82%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); }
    .qmsg.user { align-self: flex-end; background: var(--accent-soft); border-color: color-mix(in srgb, var(--brand-blue-dark) 25%, transparent); }
    .qwho { margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .qtext { font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .qtime { margin-top: 5px; color: var(--muted); font-size: 10px; text-align: right; }
    .qtyping { color: var(--muted); font-style: italic; }
    .qerr { margin: 0 14px 8px; }
    .qcomposer { display: flex; align-items: flex-end; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--border); background: var(--bg); }
    .qcomposer textarea { flex: 1 1 auto; min-height: 60px; max-height: 160px; resize: vertical; }
    .qcomposer .btn { flex: 0 0 auto; min-height: 38px; }
    .small { font-size: 12px; }
    .qactivity { border: 1px solid var(--border); border-radius: 10px; background: var(--bg); overflow: hidden; }
    .qact-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--panel); font-size: 12px; }
    .qact-head b { font-size: 12px; }
    .qact-head .qspacer { flex: 1 1 auto; }
    .qact-body { max-height: 260px; overflow-y: auto; padding: 6px 10px; }
    .qev { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px dashed color-mix(in srgb, var(--border) 70%, transparent); font-size: 12px; }
    .qev:last-child { border-bottom: 0; }
    .qev-time { flex: 0 0 auto; width: 54px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .qev-kind { flex: 0 0 auto; min-width: 46px; color: var(--muted); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding-top: 2px; }
    .qev-body { min-width: 0; flex: 1 1 auto; }
    .qev-title { overflow-wrap: anywhere; }
    .qev.tool .qev-title { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .qev.error .qev-title, .qev.tool_result.error .qev-title { color: var(--red); }
    .qev.text .qev-body { font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .qev.thinking .qev-kind { color: var(--muted); font-style: italic; text-transform: none; }
    .qev pre { margin: 4px 0 0; padding: 6px 8px; max-height: 140px; overflow: auto; border-radius: 6px; background: var(--panel); color: var(--text); font-size: 11px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
    .qev pre.qthink { border: 0; background: transparent; color: var(--muted); padding: 2px 0; font-style: italic; }
    .qapproval { margin: 4px 10px 10px; border: 1px solid color-mix(in srgb, var(--red) 45%, var(--border)); border-radius: 10px; background: var(--bg); padding: 10px; }
    .qapproval-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
    .qapproval-head b { font-size: 13px; }
    .qapproval-title { margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .qapproval-desc { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .qapproval pre { margin: 8px 0; padding: 8px; max-height: 180px; overflow: auto; border-radius: 6px; background: var(--panel); font-size: 11px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
    .qapproval-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    @media (max-width: 760px) {
      .qchat { grid-template-columns: 1fr; }
      .qlist ul { max-height: 210px; }
      .qmessages { max-height: 50vh; }
      .qdel { opacity: 1; }
      .qev-time { display: none; }
    }
  `],
  template: `
    <div class="qchat">
      <aside class="qlist">
        <div class="qlist-head">
          <b>Диалоги</b>
          <button type="button" class="btn sm" (click)="newDialog()" [disabled]="busy()">+ Новый</button>
        </div>
        @if (listErr()) { <div class="err qpad">{{ listErr() }}</div> }
        @if (loadingList()) {
          <div class="muted qpad">Загружаем…</div>
        } @else if (!dialogs().length) {
          <div class="muted qpad small">Диалогов пока нет. Начните новый — Qoder выполнит задачу в проекте.</div>
        } @else {
          <ul>
            @for (d of dialogs(); track d.id) {
              <li>
                <button type="button" class="qitem" [class.on]="selectedId() === d.id" (click)="select(d)" [disabled]="busy()">
                  <span class="qtitle">{{ d.title }}</span>
                  <span class="qmeta">{{ d.updatedAt }}@if (d.messageCount) { · {{ d.messageCount }} сообщ. }</span>
                  @if (d.preview) { <span class="qprev">{{ d.preview }}</span> }
                </button>
                <button type="button" class="qdel" title="Удалить диалог" aria-label="Удалить диалог" (click)="remove(d, $event)" [disabled]="busy()">✕</button>
              </li>
            }
          </ul>
        }
      </aside>

      <section class="qmain">
        <div class="qmain-head">
          <b>{{ selectedTitle() || 'Новый диалог' }}</b>
          <span class="qspacer"></span>
          @if (job()?.status === 'running') {
            <span class="muted small">{{ pendingApproval() ? 'ждёт подтверждения' : 'работает в проекте…' }}</span>
            <button type="button" class="btn sm" (click)="stop()" [disabled]="stopping()">Остановить</button>
          }
        </div>
        <div class="qmessages" #scroller>
          @if (!messages().length && !job()) {
            <div class="qempty">
              Qoder работает прямо в проекте: читает и меняет файлы, ищет код, запускает команды и тесты.
              Опасные действия он запросит подтвердить здесь. История диалогов сохраняется у вашей учётной записи.
            </div>
          }
          @for (m of messages(); track m.id) {
            <div class="qmsg" [class.user]="m.role === 'user'">
              <div class="qwho">{{ m.role === 'user' ? 'Вы' : 'Qoder' }}</div>
              <div class="qtext">{{ m.content }}</div>
              <div class="qtime">{{ m.createdAt }}</div>
            </div>
          }
          @if (job(); as j) {
            <div class="qactivity">
              <div class="qact-head">
                <b>Ход работы</b>
                <span class="qspacer"></span>
                <span class="muted">
                  {{ j.status === 'running' ? 'выполняется' : j.status === 'done' ? 'готово' : j.status === 'error' ? 'ошибка' : 'остановлено' }}
                </span>
              </div>
              @if (j.events.length) {
                <div class="qact-body" #actbody>
                  @for (e of j.events; track e.seq) {
                    <div class="qev" [class.error]="e.kind === 'error' || e.status === 'error'" [class.tool]="e.kind === 'tool'" [class.tool_result]="e.kind === 'tool_result'" [class.text]="e.kind === 'text'" [class.thinking]="e.kind === 'thinking'">
                      <span class="qev-time">{{ e.at | date:'HH:mm:ss' }}</span>
                      <span class="qev-kind">{{ eventKind(e.kind) }}</span>
                      <span class="qev-body">
                        @switch (e.kind) {
                          @case ('text') {
                            @if (e.detail) { <span>{{ e.detail }}</span> }
                          }
                          @case ('thinking') {
                            @if (e.detail) { <pre class="qthink">{{ e.detail }}</pre> }
                          }
                          @default {
                            <span class="qev-title">{{ e.title }}</span>
                            @if (e.detail) { <pre>{{ e.detail }}</pre> }
                          }
                        }
                      </span>
                    </div>
                  }
                </div>
              }
              @if (pendingApproval(); as a) {
                <div class="qapproval">
                  <div class="qapproval-head"><b>Нужно подтверждение</b><span class="muted">{{ a.tool }}</span></div>
                  <div class="qapproval-title">{{ a.title }}</div>
                  @if (a.description && a.description !== a.title) { <div class="qapproval-desc">{{ a.description }}</div> }
                  @if (a.preview && a.preview !== a.title) { <pre>{{ a.preview }}</pre> }
                  <div class="qapproval-actions">
                    <button type="button" class="btn primary sm" (click)="decide(a, 'once')" [disabled]="!!deciding()">Разрешить</button>
                    @if (a.canAlways) {
                      <button type="button" class="btn sm" (click)="decide(a, 'always')" [disabled]="!!deciding()">Разрешить и запомнить</button>
                    }
                    <button type="button" class="btn sm" (click)="decide(a, 'deny')" [disabled]="!!deciding()">Отклонить</button>
                  </div>
                </div>
              } @else if (j.status === 'running') {
                <div class="qact-body muted small">Qoder думает…</div>
              }
            </div>
          }
        </div>
        @if (err()) { <div class="err qerr" role="alert">{{ err() }}</div> }
        <div class="qcomposer">
          <textarea
            [ngModel]="draft()"
            (ngModelChange)="draft.set($event)"
            [disabled]="busy()"
            maxlength="4000"
            rows="3"
            placeholder="Напишите Qoder… Enter — отправить, Shift+Enter — новая строка"
            aria-label="Сообщение для Qoder"
            (keydown.enter)="onEnter($event)"
          ></textarea>
          <button type="button" class="btn primary" (click)="send()" [disabled]="busy() || !draft().trim()">Отправить</button>
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
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastEventSeq = 0;

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
  readonly err = signal('');
  readonly listErr = signal('');

  ngOnInit(): void {
    this.loadList(true);
  }

  ngOnDestroy(): void {
    this.stopPoll();
  }

  busy(): boolean {
    return this.starting() || this.job()?.status === 'running';
  }

  pendingApproval(): QoderApproval | null {
    return this.job()?.approvals.find((a) => !a.resolved) ?? null;
  }

  eventKind(kind: QoderJob['events'][number]['kind']): string {
    if (kind === 'tool') return 'вызов';
    if (kind === 'tool_result') return 'ответ';
    if (kind === 'error') return 'ошибка';
    if (kind === 'text') return 'пишет';
    if (kind === 'thinking') return 'мысль';
    return 'статус';
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
    this.stopPoll();
    this.job.set(null);
    this.selectedId.set(null);
    this.selectedTitle.set('');
    this.messages.set([]);
    this.err.set('');
    this.draft.set('');
  }

  select(d: QoderDialog): void {
    if (this.busy()) return;
    this.stopPoll();
    this.job.set(null);
    this.err.set('');
    this.selectedId.set(d.id);
    this.selectedTitle.set(d.title);
    this.api
      .qoderDialog$(d.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (full) => {
          this.selectedTitle.set(full.title);
          this.messages.set(full.messages);
          this.scrollBottom();
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
            this.lastEventSeq = this.lastSeq(r.job);
            this.startPolling(r.job.id);
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
    this.stopPoll();
    this.job.set(null);
    this.starting.set(true);
    const pending: QoderMessage = { id: -Date.now(), role: 'user', content: text, createdAt: 'сейчас' };
    this.messages.update((list) => [...list, pending]);
    this.draft.set('');
    this.scrollBottom();

    let createdId: number | null = null;
    const id$: Observable<number> = this.selectedId()
      ? of(this.selectedId()!)
      : this.api.createQoderDialog$().pipe(
          map((created) => {
            createdId = created.id;
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
          this.lastEventSeq = 0;
          this.startPolling(r.jobId);
          this.loadList(false);
          this.scrollBottom();
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

  private startPolling(jobId: string): void {
    this.stopPoll();
    const tick = (): void => {
      this.api
        .qoderJob$(jobId)
        .pipe(take(1), takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (job) => this.applyJob(job),
          error: (e) => {
            this.stopPoll();
            this.err.set(httpErr(e));
          },
        });
    };
    tick();
    this.pollTimer = setInterval(tick, 900);
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private applyJob(job: QoderJob): void {
    if (this.job()?.id && this.job()!.id !== job.id) return;
    this.job.set(job);
    if (job.status === 'running') {
      this.scrollActivity();
      const seq = this.lastSeq(job);
      if (seq !== this.lastEventSeq) {
        this.lastEventSeq = seq;
        this.scrollBottom();
      }
      return;
    }

    this.stopPoll();
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

  private lastSeq(job: QoderJob): number {
    return job.events.length ? job.events[job.events.length - 1].seq : 0;
  }

  private scrollBottom(): void {
    setTimeout(() => {
      const el = this.scroller()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }

  /** Лента «хода работы» тоже растёт на глазах — держим её внизу. */
  private scrollActivity(): void {
    setTimeout(() => {
      const el = this.actBody()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }
}
