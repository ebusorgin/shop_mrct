import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService } from '../core/api.service';
import { AppSettings, GptTestResult, ProductCatalog, RawCategory } from '../core/models';
import { httpErr } from '../core/format';
import { PasswordFormComponent } from '../shared/password-form.component';

/**
 * Раздел «Настройки» (только администратор): транспорт GPT (напрямую или через прокси).
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe, PasswordFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cat-badge { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:8px; margin-right:8px; font-size:15px; line-height:1; vertical-align:middle; }
    .pc-icon { width:150px; }
    .pc-color { width:46px; height:34px; padding:2px; }
  `],
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">⚙️ Настройки</h1>
      <span class="spacer"></span>
      <button class="btn sm" (click)="pwdOpen.set(true)">{{ 'common.password' | translate }}</button>
      <button class="btn sm" (click)="load()" [disabled]="busy()">⟳</button>
    </div>
    @if (pwdOpen()) {
      <app-password-form (closed)="pwdOpen.set(false)" />
    }
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

    <!-- КАТЕГОРИИ НОМЕНКЛАТУРЫ -->
    <div class="panel">
      <h3>Категории номенклатуры</h3>
      <div class="muted" style="font-size:12px; margin-bottom:10px">
        Список предлагается при выборе категории у позиции склада. При удалении категории её позиции переходят в «прочее».
      </div>
      @if (catsErr()) { <div class="err">{{ catsErr() }}</div> }
      @if (catsMsg()) { <div class="ok-msg">{{ catsMsg() }}</div> }
      <table class="tbl">
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
    <div class="panel">
      <h3>Каталог продукции</h3>
      <div class="muted" style="font-size:12px; margin-bottom:10px">
        Список предлагается при создании продукта. При удалении каталога продукты остаются, но без каталога.
      </div>
      @if (pcErr()) { <div class="err">{{ pcErr() }}</div> }
      @if (pcMsg()) { <div class="ok-msg">{{ pcMsg() }}</div> }
      <table class="tbl">
        <tr><th>Каталог</th><th class="num">Продуктов</th><th></th></tr>
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

  `,
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);

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
    this.load();
    this.loadCats();
    this.loadPcs();
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
    if (!confirm(`Удалить каталог «${c.name}»? Продукты останутся, но без каталога.`)) return;
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
