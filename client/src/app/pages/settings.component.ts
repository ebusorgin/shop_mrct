import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { AppSettings, GptTestResult } from '../core/models';
import { httpErr } from '../core/format';

/**
 * Раздел «Настройки» (только администратор): то, что раньше требовало правки server/.env.
 *
 * Сейчас здесь один блок — транспорт запросов к OpenAI. Из ряда стран
 * (в том числе из России) api.openai.com отвечает 403 unsupported_country_region_territory,
 * поэтому галочка «через Tor» заворачивает все запросы к GPT в SOCKS5-прокси —
 * по умолчанию локальный Tor на 127.0.0.1:9050. Кнопка «Проверить связь» делает
 * настоящий короткий запрос к модели выбранным транспортом.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">⚙️ Настройки</h1>
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()" [disabled]="busy()">⟳</button>
    </div>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="panel">
      <h3>GPT (OpenAI)</h3>
      @if (st(); as s) {
        <div class="row" style="gap:24px; align-items:flex-start">
          <div style="flex:1 1 380px; min-width:0">
            <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer; font-weight:600">
              <input
                type="checkbox"
                [(ngModel)]="viaProxy"
                [disabled]="busy()"
                style="width:18px; height:18px; margin:1px 0 0; flex:none"
              />
              <span>Работать через Tor (прокси)</span>
            </label>
            <div class="muted" style="font-size:12px; margin-top:6px">
              Включайте, если сервер в стране, где OpenAI недоступен: в России api.openai.com отвечает
              403 «unsupported_country_region_territory». Тогда все запросы к GPT (разбор накладных) идут
              через SOCKS5-прокси — по умолчанию локальный Tor.
            </div>
            <label class="f" style="margin-top:14px; max-width:430px">
              Адрес прокси
              <input [(ngModel)]="proxyUrl" [disabled]="busy() || !viaProxy" placeholder="socks5h://127.0.0.1:9050" />
            </label>
            <div class="muted" style="font-size:12px; margin-top:6px">
              socks5h://127.0.0.1:9050 — Tor на этом сервере. Можно указать и обычный прокси: http://host:port.
            </div>
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
              @if (s.openai.keyConfigured) {
                <span class="badge green">ключ задан</span>
              } @else {
                <span class="badge red">не задан в .env</span>
              }
              <span class="mono"> {{ s.openai.model }}</span>
            </div>
          </div>
        </div>

        <hr class="hr" />

        <div class="row">
          <button class="btn primary" (click)="save()" [disabled]="busy()">
            {{ busy() ? 'Сохраняем…' : 'Сохранить' }}
          </button>
          <button class="btn" (click)="runTest()" [disabled]="testing() || busy()">
            {{ testing() ? 'Проверяем…' : 'Проверить связь с GPT' }}
          </button>
          <span class="spacer"></span>
          @if (test(); as t) {
            <span class="muted" style="font-size:12px">
              последняя проверка: {{ t.transport }} · {{ (t.ms / 1000).toFixed(1) }} с
            </span>
          }
        </div>

        @if (test(); as t) {
          @if (t.ok) {
            <div class="ok-msg" style="margin:12px 0 0">
              GPT ответил через {{ t.transport }} за {{ (t.ms / 1000).toFixed(1) }} с: «{{ t.reply }}»
            </div>
          } @else {
            <div class="err" style="margin:12px 0 0">Не получилось через {{ t.transport }}: {{ t.error }}</div>
          }
        }
      } @else {
        <div class="muted" style="font-size:12px">Загружаем…</div>
      }
    </div>
  `,
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);

  st = signal<AppSettings | null>(null);
  err = signal('');
  msg = signal('');
  busy = signal(false);
  testing = signal(false);
  test = signal<GptTestResult | null>(null);

  /** Черновик формы: сохраняется кнопкой, чтобы галочка не срабатывала случайно. */
  viaProxy = false;
  proxyUrl = '';

  ngOnInit(): void {
    this.load();
  }

  /** quiet — тихое обновление после сохранения: сообщение «Сохранено» не должно пропасть. */
  load(quiet = false): void {
    if (!quiet) {
      this.err.set('');
      this.msg.set('');
    }
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
        this.msg.set(r.gpt.viaProxy ? `Сохранено: GPT работает через ${r.gpt.proxyUrl}` : 'Сохранено: GPT работает напрямую');
        this.load(true);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  /** Настоящий запрос к модели текущим (уже сохранённым) транспортом. */
  runTest(): void {
    this.testing.set(true);
    this.err.set('');
    this.api.testGpt$().subscribe({
      next: (r) => {
        this.testing.set(false);
        this.test.set(r);
      },
      error: (e: unknown) => {
        this.testing.set(false);
        this.err.set(httpErr(e));
      },
    });
  }
}
