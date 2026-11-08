import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { LangService, AppLang } from '../core/lang.service';
import { ApiService } from '../core/api.service';
import { AppSettings, CardCategory, CardRef, GptTestResult, DeliverySettings } from '../core/models';
import { httpErr } from '../core/format';

/**
 * Раздел «Настройки» (только администратор): транспорт GPT + категории товаров.
 *
 * Категории: список, создание, переименование, удаление, привязка/отвязка tech_cards.
 * Товар = tech_card. Одна категория у товара (category_id на tech_cards).
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    /* дерево категорий: узел = категория, потомки = товары */
    .tree { display: flex; flex-direction: column; gap: 2px; }
    .node-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; user-select: none; }
    .node-row:hover { background: #f4f7fb; }
    .twist { font-size: 10px; color: var(--muted); width: 12px; flex: none; transition: transform .12s; }
    .twist.open { transform: rotate(90deg); }
    .cat-name { font-weight: 600; text-transform: capitalize; }
    .cat-input { max-width: 220px; }
    .cnt { font-size: 12px; color: var(--muted); background: #eef1f5; border-radius: 10px; padding: 1px 8px; }
    .actions { display: flex; gap: 4px; align-items: center; margin-left: auto; flex: none; }
    .children { margin: 2px 0 8px 20px; padding-left: 16px; border-left: 2px solid var(--border); }
    .child { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 4px; }
    .child:hover { background: #f4f7fb; }
    .child .dot { color: var(--muted); flex: none; }
    .child-name { font-size: 13px; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .child .sub { color: var(--muted); font-size: 11px; margin-left: 4px; flex: none; }
    /* крестик — сразу за названием, всегда виден: до него тянуться не нужно */
    .child .x { flex: none; background: none; border: none; cursor: pointer; font-size: 15px; line-height: 1;
      color: #b6bec9; padding: 2px 5px; border-radius: 4px; }
    .child .x:hover { color: var(--red); background: #fdeaec; }
    .add-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
    .leaf-add { color: var(--muted); font-size: 13px; padding: 2px 0 0 3px; }
    /* плашка нераспределённых товаров */
    .unass { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; background: #fcfcfd; }
    .unass-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .unass-head b { font-size: 13px; }
    .unass-warn { color: #b06a00; font-size: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 12px;
      background: #eef1f5; font-size: 12px; color: #3c4450; }
    .chip .sub { color: var(--muted); font-size: 11px; }
    .chip-none { font-size: 13px; color: var(--green); }
    .chip .x { flex: none; background: none; border: none; cursor: pointer; font-size: 15px; line-height: 1;
      color: #b6bec9; padding: 0 3px; border-radius: 4px; }
    .chip .x:hover { color: var(--red); background: #fdeaec; }
    /* календарь дат доставок */
    .cal-day {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 0;
      cursor: pointer;
      font-size: 13px;
      color: #3c4450;
      transition: background .1s, border-color .1s;
    }
    .cal-day:hover { background: #f4f7fb; border-color: var(--accent); }
    .cal-day.other-month { opacity: 0.35; }
    .cal-day.today { border-color: var(--accent); font-weight: bold; }
    .cal-day.selected { background: #e8f0fe; border-color: #1a73e8; color: #1a73e8; font-weight: 600; }
  `],
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">⚙️ Настройки</h1>
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()" [disabled]="busy()">⟳</button>
    </div>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <!-- GPT -->
    <div class="panel">
      <h3>GPT (OpenAI)</h3>
      @if (st(); as s) {
        <div class="row" style="gap:24px; align-items:flex-start">
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

    <!-- Дни и закрытие доставок -->
    <div class="panel">
      <h3>Дни и закрытие доставок</h3>
      <div class="muted" style="font-size:12px; margin-bottom:12px">
        Выберите даты доставок в календаре (на ближайшие 3 месяца) и укажите время автоматического
        закрытия заказов и списания со склада. В назначенный момент лист закрывается от правок.
        Время — по Москве.
      </div>

      <label style="display:flex; gap:10px; align-items:center; cursor:pointer; font-weight:600; margin-bottom:14px">
        <input type="checkbox" [ngModel]="dvEnabled()" (ngModelChange)="dvEnabled.set($event)"
          [disabled]="dvBusy()" style="width:18px; height:18px" />
        <span>Включить автоматическое закрытие и списание в дни доставок</span>
      </label>

      <div style="margin-bottom:16px">
        <div class="muted" style="font-size:12px; margin-bottom:6px">Время закрытия заказов и списания (устанавливается 1 раз)</div>
        <div style="display:flex; align-items:center; gap:10px;">
          <input type="time" [ngModel]="dvTime()" (ngModelChange)="dvTime.set($event)" [disabled]="dvBusy()" style="width:140px" />
          <span class="muted" style="font-size:12px">В выделенные дни скрипт запустится в этом времени (по Москве).</span>
        </div>
      </div>

      <div style="font-weight:600; font-size:13px; margin-bottom:8px">Календарь дат доставок</div>
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px">
        <button type="button" class="btn sm" (click)="prevMonth()">◀ На месяц назад</button>
        <button type="button" class="btn sm" (click)="nextMonth()">На месяц вперёд ▶</button>
      </div>

      <div class="cal-3months" style="display:flex; gap:20px; flex-wrap:wrap; align-items:flex-start">
        @for (cal of calMonths(); track cal.monthName) {
          <div style="flex:0 0 280px; background:#fafbfc; border:1px solid var(--border); border-radius:10px; padding:12px">
            <div style="font-weight:600; font-size:14px; margin-bottom:8px; text-align:center">{{ cal.monthName }}</div>
            <div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:3px; text-align:center; font-size:13px">
              @for (wd of ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']; track wd) {
                <div style="color:var(--muted); font-size:11px; font-weight:600; padding:3px 0">{{ wd }}</div>
              }
              @for (d of cal.days; track d.dateIso) {
                <button type="button"
                        class="cal-day"
                        [class.other-month]="!d.inMonth"
                        [class.selected]="d.isSelected"
                        [class.today]="d.isToday"
                        (click)="toggleDvDate(d.dateIso)">
                  {{ d.dayNum }}
                </button>
              }
            </div>
          </div>
        }
      </div>

      <div class="muted" style="font-size:12px; margin-top:14px">
        @if (dvUpcoming().length) {
          Ближайшие доставки: @for (dt of dvUpcoming(); track dt) { <span class="chip" style="margin:0 4px">{{ dt }}</span> }
        } @else {
          Даты не выбраны — ближайшая доставка не определена.
        }
      </div>

      <div class="muted" style="font-size:12px; margin-top:6px">
        @if (dvEnabled() && dvNext(); as nx) {
          Ближайшее срабатывание: {{ nx.dateIso }} в {{ nx.time }}
        } @else if (dvEnabled()) {
          Расписание неполное — выберите даты и время.
        } @else {
          Автоматическое закрытие выключено.
        }
      </div>

      <hr class="hr" />
      <div class="row">
        <button class="btn primary" (click)="saveDelivery()" [disabled]="dvBusy()">{{ dvBusy() ? 'Сохраняем…' : 'Сохранить' }}</button>
        <button class="btn" (click)="runWriteoffNow()" [disabled]="woRunning() || dvBusy()">{{ woRunning() ? 'Списываем…' : 'Запустить списание сейчас' }}</button>
      </div>
      @if (dvMsg()) { <div class="ok-msg" style="margin-top:10px">{{ dvMsg() }}</div> }
    </div>

    <!-- Реквизиты производства -->
    <div class="panel">
      <h3>Реквизиты производства (Dobavljač для отпремниц)</h3>
      <div class="muted" style="font-size:12px; margin-bottom:12px">
        Укажите реквизиты компании-производителя, которые автоматически подставляются в шапку отпремниц (.doc).
      </div>
      <div style="display:flex; flex-direction:column; gap:12px; max-width:500px">
        <label class="f">Название компании <input [(ngModel)]="prodName" [disabled]="prodBusy()" placeholder="MIX Markt Production DOO" /></label>
        <label class="f">Адрес <input [(ngModel)]="prodAddress" [disabled]="prodBusy()" placeholder="Industrijska bb, Beograd" /></label>
        <div class="cols" style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
          <label class="f">PIB <input [(ngModel)]="prodPib" [disabled]="prodBusy()" placeholder="109876543" /></label>
          <label class="f">MBR <input [(ngModel)]="prodMbr" [disabled]="prodBusy()" placeholder="21543210" /></label>
        </div>
        <label class="f">Tekući račun (Broj računa) <input [(ngModel)]="prodAccountNo" [disabled]="prodBusy()" placeholder="160-0000000000000-00" /></label>
        <div>
          <button class="btn primary" (click)="saveProduction()" [disabled]="prodBusy()">{{ prodBusy() ? 'Сохраняем…' : 'Сохранить реквизиты' }}</button>
        </div>
      </div>
    </div>

    <!-- Категории товаров: раскрывающееся дерево -->
    <div class="panel">
      <h3>Категории товаров</h3>

      <div class="unass">
        <div class="unass-head">
          <b>Ни в одной категории</b>
          <span class="cnt">{{ unassigned().length }}</span>
          @if (unassigned().length) {
            <span class="unass-warn">— их не видно в фильтре доски, распределите</span>
          }
        </div>
        <div class="chips">
          @for (c of unassigned(); track c.id) {
            <span class="chip">{{ c.name }}@if (c.plu) { <span class="sub">{{ c.plu }}</span> }</span>
          } @empty {
            <span class="chip-none">Отлично — все товары распределены</span>
          }
        </div>
      </div>

      <div class="tree">
        @for (cat of cats(); track cat.id) {
          <div class="node">
            <div class="node-row" (click)="toggleExpand(cat.id)">
              <span class="twist" [class.open]="expandedIds().has(cat.id)">▶</span>
              @if (editingCat() === cat.id) {
                <input class="cat-input" [ngModel]="editCatName()" (ngModelChange)="editCatName.set($event)"
                  (click)="$event.stopPropagation()" (keyup.enter)="saveRename()" (keyup.escape)="editingCat.set(null)" />
                <span class="actions">
                  <button class="btn sm primary" (click)="$event.stopPropagation(); saveRename()">✓</button>
                  <button class="btn sm" (click)="$event.stopPropagation(); editingCat.set(null)">✕</button>
                </span>
              } @else {
                <span class="cat-name">{{ cat.name }}</span>
                <span class="cnt">{{ cat.cardCount }}</span>
                <span class="actions">
                  <button class="btn sm" (click)="$event.stopPropagation(); startRename(cat)" title="Переименовать">✎</button>
                  <button class="btn sm danger" (click)="$event.stopPropagation(); deleteCat(cat.id)" title="Удалить">🗑</button>
                </span>
              }
            </div>
            @if (expandedIds().has(cat.id)) {
              <div class="children">
                @for (c of cardsOf(cat.id); track c.id) {
                  <div class="child">
                    <span class="dot">└</span>
                    <span class="child-name" [title]="c.name">{{ c.name }}</span>
                    @if (c.plu) { <span class="sub">{{ c.plu }}</span> }
                    <button class="x" (click)="removeCard(cat.id, c.id)" title="Убрать из категории">×</button>
                  </div>
                }
                <div class="leaf-add">@if (!cardsOf(cat.id).length) { В категории пока нет товаров }</div>
                <div class="add-row">
                  <select class="minw0" [ngModel]="pickOf(cat.id)" (ngModelChange)="setPick(cat.id, $event)">
                    <option [ngValue]="null">+ выбрать из нераспределённых</option>
                    @for (a of unassigned(); track a.id) {
                      <option [ngValue]="a.id">{{ a.name }}</option>
                    }
                  </select>
                  <button class="btn sm" [disabled]="!pickOf(cat.id)" (click)="addCard(cat.id)">Добавить</button>
                </div>
              </div>
            }
          </div>
        } @empty {
          <div class="muted" style="padding:8px">Категории не созданы</div>
        }
      </div>
      <div class="row mt">
        <input class="cat-input" placeholder="Новая категория" [ngModel]="newCatName()" (ngModelChange)="newCatName.set($event)" (keyup.enter)="createCat()" />
        <button class="btn sm primary" [disabled]="!newCatName().trim()" (click)="createCat()">+ Добавить</button>
      </div>
    </div>
  `,
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);
  protected langSvc = inject(LangService);

  // === GPT ===
  st = signal<AppSettings | null>(null);
  err = signal('');
  msg = signal('');
  busy = signal(false);
  testing = signal(false);
  test = signal<GptTestResult | null>(null);
  viaProxy = false;
  proxyUrl = '';

  // === Дни и закрытие доставок ===
  dvEnabled = signal(false);
  dvDates = signal<Set<string>>(new Set());
  dvTime = signal('18:00');
  dvNext = signal<{ dateIso: string; time: string } | null>(null);
  calYear = signal<number>(new Date().getFullYear());
  calMonth = signal<number>(new Date().getMonth());
  calMonthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  dvUpcoming = signal<string[]>([]);
  dvBusy = signal(false);
  woRunning = signal(false);
  dvMsg = signal('');

  prevMonth(): void {
    let m = this.calMonth() - 1;
    let y = this.calYear();
    if (m < 0) { m = 11; y--; }
    this.calMonth.set(m);
    this.calYear.set(y);
  }

  nextMonth(): void {
    let m = this.calMonth() + 1;
    let y = this.calYear();
    if (m > 11) { m = 0; y++; }
    this.calMonth.set(m);
    this.calYear.set(y);
  }

  calMonths = computed(() => {
    const baseYear = this.calYear();
    const baseMonth = this.calMonth();
    const todayIso = new Date().toISOString().slice(0, 10);
    const selected = this.dvDates();

    const result = [];
    for (let offset = 0; offset < 3; offset++) {
      let y = baseYear;
      let m = baseMonth + offset;
      while (m > 11) { m -= 12; y++; }
      while (m < 0) { m += 12; y--; }

      const monthName = `${this.calMonthNames[m]} ${y}`;
      const firstDay = new Date(y, m, 1);
      let startDayOfWeek = firstDay.getDay() - 1;
      if (startDayOfWeek < 0) startDayOfWeek = 6;

      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const daysInPrevMonth = new Date(y, m, 0).getDate();

      const days: { dateIso: string; dayNum: number; inMonth: boolean; isSelected: boolean; isToday: boolean }[] = [];

      for (let i = startDayOfWeek - 1; i >= 0; i--) {
        const dayNum = daysInPrevMonth - i;
        const prevDate = new Date(y, m - 1, dayNum);
        const dateIso = prevDate.toISOString().slice(0, 10);
        days.push({
          dateIso,
          dayNum,
          inMonth: false,
          isSelected: selected.has(dateIso),
          isToday: dateIso === todayIso,
        });
      }

      for (let d = 1; d <= daysInMonth; d++) {
        const currDate = new Date(y, m, d);
        const dateIso = currDate.toISOString().slice(0, 10);
        days.push({
          dateIso,
          dayNum: d,
          inMonth: true,
          isSelected: selected.has(dateIso),
          isToday: dateIso === todayIso,
        });
      }

      const totalCells = days.length <= 28 ? 28 : days.length <= 35 ? 35 : 42;
      const remaining = totalCells - days.length;
      for (let d = 1; d <= remaining; d++) {
        const nextDate = new Date(y, m + 1, d);
        const dateIso = nextDate.toISOString().slice(0, 10);
        days.push({
          dateIso,
          dayNum: d,
          inMonth: false,
          isSelected: selected.has(dateIso),
          isToday: dateIso === todayIso,
        });
      }

      result.push({ year: y, month: m, monthName, days });
    }
    return result;
  });

  // === Категории товаров ===
  cats = signal<CardCategory[]>([]);
  allCards = signal<CardRef[]>([]);
  expandedIds = signal<Set<number>>(new Set());
  cardsByCat = signal<Map<number, CardRef[]>>(new Map());
  pickByCat = signal<Map<number, number | null>>(new Map());
  newCatName = signal('');
  editingCat = signal<number | null>(null);
  editCatName = signal('');

  // === Реквизиты производства ===
  prodName = signal('');
  prodAddress = signal('');
  prodPib = signal('');
  prodMbr = signal('');
  prodAccountNo = signal('');
  prodBusy = signal(false);

  ngOnInit(): void {
    this.load();
    this.loadCats();
  }

  // ---- GPT ----
  load(quiet = false): void {
    if (!quiet) { this.err.set(''); this.msg.set(''); }
    this.api.settings$().subscribe({
      next: (s) => {
        this.st.set(s);
        this.viaProxy = s.gpt.viaProxy;
        this.proxyUrl = s.gpt.proxyUrl;
        this.test.set(null);
        this.dvEnabled.set(s.delivery.enabled);
        this.dvDates.set(new Set(s.delivery.dates));
        this.dvTime.set(s.delivery.time ?? '18:00');
        this.dvUpcoming.set(s.deliveryUpcoming ?? []);
        this.dvNext.set(s.deliveryNext ?? null);
        if (s.production) {
          this.prodName.set(s.production.name ?? '');
          this.prodAddress.set(s.production.address ?? '');
          this.prodPib.set(s.production.pib ?? '');
          this.prodMbr.set(s.production.mbr ?? '');
          this.prodAccountNo.set(s.production.accountNo ?? '');
        }
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

  saveProduction(): void {
    this.prodBusy.set(true);
    this.err.set('');
    this.msg.set('');
    this.api.saveProductionSettings$({
      name: this.prodName().trim(),
      address: this.prodAddress().trim(),
      pib: this.prodPib().trim(),
      mbr: this.prodMbr().trim(),
      accountNo: this.prodAccountNo().trim(),
    }).subscribe({
      next: (r) => {
        this.prodBusy.set(false);
        this.msg.set('Реквизиты производства сохранены');
        if (r.production) {
          this.prodName.set(r.production.name);
          this.prodAddress.set(r.production.address);
          this.prodPib.set(r.production.pib);
          this.prodMbr.set(r.production.mbr);
          this.prodAccountNo.set(r.production.accountNo);
        }
      },
      error: (e: unknown) => {
        this.prodBusy.set(false);
        this.err.set(httpErr(e));
      },
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

  // ---- Дни и закрытие доставок ----
  toggleDvDate(dateIso: string): void {
    const next = new Set(this.dvDates());
    if (next.has(dateIso)) next.delete(dateIso);
    else next.add(dateIso);
    this.dvDates.set(next);
  }

  saveDelivery(): void {
    this.dvBusy.set(true);
    this.dvMsg.set('');
    const body: DeliverySettings = {
      enabled: this.dvEnabled(),
      dates: [...this.dvDates()].sort(),
      time: this.dvTime().trim() || '18:00',
      tz: 'Europe/Moscow',
    };
    this.api.saveDelivery$(body).subscribe({
      next: (r) => {
        this.dvBusy.set(false);
        this.dvEnabled.set(r.delivery.enabled);
        this.dvDates.set(new Set(r.delivery.dates));
        this.dvTime.set(r.delivery.time);
        this.dvUpcoming.set(r.deliveryUpcoming ?? []);
        this.dvNext.set(r.deliveryNext ?? null);
        this.dvMsg.set('Дни и закрытие доставок сохранены');
      },
      error: (e: unknown) => { this.dvBusy.set(false); this.dvMsg.set(httpErr(e)); },
    });
  }

  runWriteoffNow(): void {
    if (!confirm('Списать со склада все линии доски за сегодняшнюю дату доставки?')) return;
    this.woRunning.set(true);
    this.dvMsg.set('');
    this.api.runWriteoffNow$().subscribe({
      next: (r: { skipped: boolean; deliveryDate: string; linesWritten: number; batches: number; error?: string }) => {
        this.woRunning.set(false);
        this.dvMsg.set(
          r.skipped
            ? `Слот за ${r.deliveryDate} уже был закрыт`
            : `Готово (${r.deliveryDate}): списано строк ${r.linesWritten}, партий ${r.batches}` + (r.error ? ` · ${r.error}` : '')
        );
        this.load(true);
      },
      error: (e: unknown) => { this.woRunning.set(false); this.dvMsg.set(httpErr(e)); },
    });
  }

  // ---- Категории ----
  private loadCats(): void {
    this.api.cardCategories$().subscribe((r) => this.cats.set(r));
    this.api.allCards$().subscribe((r) => this.allCards.set(r));
  }

  createCat(): void {
    const name = this.newCatName().trim();
    if (!name) return;
    this.api.createCategory$(name).subscribe({
      next: () => { this.newCatName.set(''); this.loadCats(); },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  startRename(cat: CardCategory): void {
    this.editingCat.set(cat.id);
    this.editCatName.set(cat.name);
  }

  saveRename(): void {
    const id = this.editingCat();
    const name = this.editCatName().trim();
    if (!id || !name) { this.editingCat.set(null); return; }
    this.api.renameCategory$(id, name).subscribe({
      next: () => { this.editingCat.set(null); this.loadCats(); },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  deleteCat(id: number): void {
    if (!confirm('Удалить категорию? Товары будут отвязаны.')) return;
    this.api.deleteCategory$(id).subscribe({
      next: () => {
        const next = new Set(this.expandedIds());
        next.delete(id);
        this.expandedIds.set(next);
        const cache = new Map(this.cardsByCat());
        cache.delete(id);
        this.cardsByCat.set(cache);
        this.loadCats();
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  toggleExpand(id: number): void {
    const next = new Set(this.expandedIds());
    if (next.has(id)) {
      next.delete(id);
      this.expandedIds.set(next);
      return;
    }
    next.add(id);
    this.expandedIds.set(next);
    if (!this.cardsByCat().has(id)) {
      this.api.categoryCards$(id).subscribe((cards) => {
        this.cardsByCat.set(new Map(this.cardsByCat()).set(id, cards));
      });
    }
  }

  /** Товары без категории — плашка сверху и единственный источник для пикера. */
  unassigned = computed(() => this.allCards().filter((c) => c.categoryId === null || c.categoryId === undefined));

  /** Товары раскрытой категории (пусто, если ещё не дошли). */
  cardsOf(catId: number): CardRef[] {
    return this.cardsByCat().get(catId) ?? [];
  }

  pickOf(catId: number): number | null {
    return this.pickByCat().get(catId) ?? null;
  }

  setPick(catId: number, cardId: number | null): void {
    this.pickByCat.set(new Map(this.pickByCat()).set(catId, cardId));
  }

  addCard(catId: number): void {
    const cardId = this.pickOf(catId);
    if (!cardId) return;
    const card = this.allCards().find((c) => c.id === cardId);
    if (!card) return;
    const updated = [...this.cardsOf(catId), card];
    this.cardsByCat.set(new Map(this.cardsByCat()).set(catId, updated));
    this.setPick(catId, null);
    this.persistAssign(catId, updated);
  }

  removeCard(catId: number, cardId: number): void {
    const updated = this.cardsOf(catId).filter((c) => c.id !== cardId);
    this.cardsByCat.set(new Map(this.cardsByCat()).set(catId, updated));
    this.persistAssign(catId, updated);
  }

  private persistAssign(catId: number, cards: CardRef[]): void {
    this.api.assignCards$(catId, cards.map((c) => c.id)).subscribe({
      next: () => this.loadCats(),
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }
}
