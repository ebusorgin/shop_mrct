import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Product, Unit, Waybill, WaybillShort, ImportParseResult, ImportItem, ImportDiscount } from '../core/models';
import { cents, fmtCost, fmtMoney, fmtQty, httpErr, today, trim } from '../core/format';

interface DraftItem {
  productId: number | null;
  qty: number | null;
  unitId: number | null;
  price: number | null;
}

/** Решение по одной распознанной строке: привязать к позиции или создать новую. */
interface ImpDraft {
  rawName: string;
  qty: number | null;         // уже в базовых единицах (г/мл/шт)
  unitId: number | null;      // базовая единица склада
  docUnitPrinted: string | null; // как напечатано в документе («kg») — для сверки
  docQtyPrinted: number | null;  // напечатанное количество (50)
  docPricePrinted: number | null; // напечатанная цена за напечатанную единицу — редактируется
  qtyForecast: boolean;      // qty пересчитан по решению GPT (упаковки -> г/мл)
  doubt: string | null;      // вопрос GPT по строке — подсветить человеку
  price: number | null;       // цена за базовую единицу — производная, только чтение
  vatRate: number | null;     // ставка PDV, % (5/10/20) или null
  vatSuspect: boolean;        // ставка прочитана неуверенно — проверить по фото
  vatInferred: boolean;       // ставку не напечатали — вывели по итогам документа
  lineSum: number | null;     // деньги строки — якорь всех пересчётов, редактируются
  lineSumPrinted: boolean;    // сумма напечатана в документе (иначе это Кол × Цена)
  edited: boolean;            // человек сам ввёл деньги строки — печатная сверка больше не указатель
  mode: 'match' | 'create';
  productId: number | null;
  via: string | null;         // name | alias | llm
  candidates: { productId: number; name: string }[];
  newName: string;
  newCategory: string;
  newUnitId: number | null;   // базовая складская единица для новой позиции
}

@Component({
  selector: 'app-waybills',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `.vat-note{color:#b45309;font-weight:600}
    /* ===== умный приход: выбор файла ===== */
    .drop{position:relative;display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px dashed var(--border);border-radius:10px;padding:12px 14px;background:#fbfcfe;cursor:pointer}
    .drop:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
    .drop input[type='file']{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:0}
    .drop-btn{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:9px 16px;font-weight:600}
    .drop-hint{font-size:12px;color:var(--muted);min-height:16px}
    .drop.busy .drop-btn{animation:pulse 1.2s ease-in-out infinite}
    @keyframes pulse{50%{opacity:.55}}

    /* ===== умный приход: просмотр фото документа ===== */
    .imp-file{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}
    .thumb{width:44px;height:44px;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:zoom-in;display:block}
    .pdf-link{font-size:12px;color:var(--accent);cursor:pointer;text-decoration:underline}
    /* печатная транскрипция GPT: показывает, что именно модель увидела на фото */
    .transcript{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.45;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px 12px;max-height:280px;overflow:auto;margin:8px 0 0}
    /* пакет фото одного листа: миниатюры с удалением и добавкой */
    .imp-files{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
    .pend{position:relative}
    .pend .thumb{width:56px;height:56px}
    .pm{position:absolute;top:-6px;right:-6px;width:20px;height:20px;line-height:1;border:0;border-radius:50%;background:#dc2626;color:#fff;font-size:12px;font-weight:700;cursor:pointer;padding:0}
    .add-more{position:relative;display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border:1px dashed var(--border);border-radius:8px;background:#fbfcfe;color:var(--muted);font-size:18px;cursor:pointer}
    .add-more input{position:absolute;inset:0;opacity:0;font-size:0;cursor:pointer}
    .files-hint{font-size:12px}
    .badge.clickable{cursor:pointer}
    .lightbox{position:fixed;inset:0;z-index:100;background:rgba(15,23,42,.88);display:flex;align-items:center;justify-content:center;padding:16px}
    .lightbox img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .lb-close{position:absolute;top:10px;right:14px;z-index:2;border:0;background:rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
    .lb-cap{position:absolute;bottom:10px;left:0;right:0;text-align:center;color:#e2e8f0;font-size:12px}
    .lb-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;border:0;background:rgba(255,255,255,.12);color:#fff;border-radius:10px;width:44px;height:64px;font-size:26px;cursor:pointer}
    .lb-nav.prev{left:10px}.lb-nav.next{right:10px}.lb-nav:disabled{opacity:.25}

    /* ===== умный приход: сетка разбора ===== */
    .meta-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,160px) minmax(0,2fr);gap:10px;align-items:end;margin-bottom:6px}
    .imp-msg ul{margin:6px 0 0;padding-left:18px}
    .imp-msg li{margin:2px 0}
    .imp-note{background:var(--accent-soft);color:#1e4a8a;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px}
    .imp-head,.imp-card{grid-template-columns:minmax(180px,1.25fr) 150px 104px 96px 132px minmax(220px,1.5fr) 34px;gap:10px;align-items:center}
    .imp-head{display:grid;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);padding:10px 10px 6px;border-bottom:2px solid var(--border)}
    .imp-head .r{text-align:right}
    .imp-card{display:grid;padding:10px;border:1px solid var(--border);border-radius:10px;background:#fff;margin-top:8px;box-shadow:var(--shadow)}
    .imp-card:hover{background:#fbfcfe}
    .imp-card.warn-card{border-color:#e3c56b;background:#fffdf4}
    .c-name{display:flex;flex-direction:column;gap:4px;min-width:0}
    .c-name .badge{align-self:flex-start}
    /* название из документа правится прямо в карточке: по нему сервер запоминает псевдоним */
    .doc-name{font-weight:700;width:100%;min-width:0}
    .doc-sum{font-size:12px;color:var(--muted)}
    .doc-sum.bad{color:var(--amber);font-weight:600}
    /* подписи полей: на десктопе их заменяет шапка .imp-head, на узких экранах — видны в карточке */
    .fl{display:none;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
    .c-qty{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,66px);gap:6px;min-width:0}
    .c-qty .fl{grid-column:1/-1;margin-bottom:2px}
    .c-qty input{width:100%;min-width:0}
    .c-qty select{width:100%;min-width:0}
    .qty-doc{grid-column:1/-1;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
    .c-price{min-width:0}.c-price .fl{margin-bottom:2px}.c-price input{width:100%;min-width:0}
    .c-price .qty-doc{display:block;margin-top:3px}
    /* мини-поля: это цифры из накладной, их правят прямо в карточке — поэтому плотнее обычных */
    .mini{width:74px;min-width:0;padding:3px 6px}
    .c-vat{display:flex;flex-direction:column;gap:3px;min-width:0}.c-vat .fl{margin-bottom:1px}
    .vat-in{display:flex;align-items:center;gap:4px}
    .vat-in input{width:64px;min-width:0}
    .vat-pct{font-size:12px;color:var(--muted)}
    .c-sum{display:flex;flex-direction:column;align-items:flex-end;line-height:1.35;font-variant-numeric:tabular-nums}
    .c-sum .gross-out{color:var(--muted);font-size:12px}
    .c-prod{display:flex;flex-direction:column;gap:6px;min-width:0}
    .c-prod .fl{margin-bottom:1px}
    .prod-sel{width:100%;max-width:360px}
    /* auto-fit: в узкой колонке «позиция склада» поля сами переносятся, на широком экране — в одну строку */
    .create-box{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
    .create-box input,.create-box select{width:100%;min-width:0}
    .create-box .cb-name{grid-column:1/-1}
    .alias-hint{font-size:12px;color:var(--muted)}
    .seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;width:fit-content;max-width:100%}
    .seg button{border:0;background:#fff;padding:5px 10px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer}
    .seg button.on{background:var(--accent);color:#fff}
    .imp-foot{display:flex;align-items:flex-end;gap:14px;margin-top:14px;flex-wrap:wrap}
    /* не-товарные строки (скидки/служебные) — считаются отдельно и на склад не приходруются */
    .imp-svc{margin-top:12px;border:1px dashed var(--border);border-radius:10px;padding:8px 12px;background:#fbfcfe;font-size:13px}
    .imp-svc .svc-hint{color:var(--muted);font-size:12px;display:block;margin-bottom:4px}
    .svc-row{display:flex;justify-content:space-between;gap:12px;max-width:460px}
    .svc-row .svc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .svc-amt{font-variant-numeric:tabular-nums;color:#b4232a;white-space:nowrap}
    .svc-row.svc-sum{border-top:1px solid var(--border);margin-top:4px;padding-top:4px;font-weight:600}
    .svc-row .svc-meta{display:block;color:var(--muted);font-size:11px;white-space:normal}
    .svc-row .svc-doubt{display:block;color:#b4232a;font-size:11px;font-weight:500;white-space:normal}
    .svc-row.svc-unk .svc-amt{opacity:.55}
    .svc-row.svc-incl .svc-name,.svc-row.svc-incl .svc-amt{opacity:.7}
    .svc-apply{margin:4px 0 2px;align-self:flex-start}
    .confirm-wrap{display:grid;gap:4px;justify-items:end}
    .confirm-hint{font-size:12px;color:#b4232a;text-align:right;max-width:320px}
    .imp-totals{display:grid;gap:4px;font-size:13px;background:#fbfcfe;border:1px solid var(--border);border-radius:10px;padding:10px 14px}
    .tt{display:grid;grid-template-columns:130px 120px minmax(0,210px);gap:10px;align-items:baseline}
    .tt b{text-align:right;font-variant-numeric:tabular-nums}
    .tt i{font-style:normal;color:var(--muted);font-size:12px;white-space:nowrap}
    .tt i .mini{width:88px}
    .tt i.diff{color:var(--red);font-weight:600}
    .tt.grossline{border-top:1px solid var(--border);padding-top:5px}

    /* ===== ручной приход: строка позиции ===== */
    .man-row{display:grid;grid-template-columns:minmax(0,2fr) 90px 70px 100px 34px;gap:8px;align-items:center;margin-bottom:8px}
    .man-row select,.man-row input{width:100%;min-width:0}
    .c-del{justify-self:end}
    .m-del{justify-self:end}
    .del-name{display:none}

    /* ===== журнал и просмотр накладной ===== */
    .wb-row{cursor:pointer}
    .wb-row.reversed td{opacity:.5}
    .wb-head{align-items:center}
    .wb-head h3{margin:0}
    .wb-head .pib{font-size:12px}
    .wb-sums{display:flex;flex-wrap:wrap;gap:4px 16px;justify-content:flex-end;align-items:baseline;font-size:13px;margin-top:6px}
    .wb-sums .doc-line{font-size:12px}

    /* правая панель всегда уже экрана (двухколоночный каркас), поэтому смотрим на ширину
       самой панели, а не на ширину окна: на 1440px колонка ~370px и поля в ней задыхаются */
    .panel{container-type:inline-size}
    @container (max-width:560px){
      .meta-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
      .meta-grid .f-full{grid-column:1/-1}
      .man-row{grid-template-columns:90px 70px minmax(0,100px) 34px;grid-template-areas:"prod prod prod prod" "qty unit price del";row-gap:6px}
      .m-prod{grid-area:prod}.m-qty{grid-area:qty}.m-unit{grid-area:unit}.m-price{grid-area:price}
      .m-del{grid-area:del;justify-self:end}
    }
    @media (max-width:1240px){
      .imp-head{display:none}
      .fl{display:block}
      .imp-card{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 34px;grid-template-areas:"name name x" "qty price x" "vat sum x" "prod prod prod";align-items:start}
      .c-name{grid-area:name}.c-qty{grid-area:qty}.c-price{grid-area:price}.c-vat{grid-area:vat}.c-sum{grid-area:sum}.c-prod{grid-area:prod}.c-del{grid-area:x;justify-self:end;align-self:start}
      .c-sum{align-items:flex-start}
      .prod-sel{max-width:none}
    }
    @media (max-width:640px){
      .wb-head h3{flex:1 1 100%;font-size:15px}
      .wb-head .spacer{display:none}
      .imp-card{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"name name" "qty price" "vat sum" "prod prod" "x x";gap:12px 10px;padding:12px}
      .c-del{justify-self:stretch;min-height:44px}
      .del-name{display:inline}
      .imp-foot .spacer{display:none}
      /* поля «номер/дата/поставщик» уже двухколоночные в @container (max-width:560px) — на телефоне они и так узкие */
      /* на телефоне поля новой позиции друг под другом: в две колонки они превращались в узкие щели */
      .create-box{grid-template-columns:minmax(0,1fr)}
      .create-box .cb-name,.create-box .cb-unit{grid-column:1/-1}
      .seg{width:100%}.seg button{flex:1;padding:11px 8px;font-size:13px}
      .vat-in{width:100%}.vat-in input{flex:1;width:auto}
      /* итоги + кнопка всегда на виду: прилипают к низу экрана */
      .imp-foot{position:sticky;bottom:0;z-index:5;flex-direction:column;align-items:stretch;gap:10px;
        margin:12px -16px -16px;padding:10px 12px;background:var(--panel);border-top:1px solid var(--border)}
      .imp-totals{width:100%;padding:8px 10px;font-size:12px}
      .tt{grid-template-columns:minmax(0,1fr) auto auto}
      .tt i{font-size:11px;text-align:right}
      /* на телефоне мини-поля такие же крупные, как остальные инпуты (зона касания, без зума iOS) */
      .mini{padding:10px 12px}
      .imp-foot .btn.primary{width:100%;justify-content:center}
      .man-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"prod prod" "qty unit" "price del"}
      .m-prod{grid-area:prod}.m-qty{grid-area:qty}.m-unit{grid-area:unit}.m-price{grid-area:price}
      .m-del{grid-area:del;justify-self:stretch;min-height:44px}
      .wb-sums{display:grid;grid-template-columns:auto auto;gap:4px 14px;justify-content:end}
      .wb-sums .doc-line{grid-column:1/-1;text-align:right}
      .drop{padding:12px}
      .drop-btn{width:100%;justify-content:center}
    }`,
  ],
  template: `
    <h1 class="page-title">📥 Входящие накладные</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid2 wl">
      <!-- ===== список ===== -->
      <div class="panel">
        <h3>Журнал накладных</h3>
        <table class="tbl stack">
          <tr class="th-row"><th>№</th><th>Дата</th><th>Поставщик</th><th class="num">Поз.</th><th class="num">Сумма</th><th></th></tr>
          @for (w of list(); track w.id) {
            <tr class="wb-row" [class.reversed]="w.status === 'reversed'" (click)="open(w.id)">
              <td><b>{{ w.number }}</b> @if (w.status === 'reversed') { <span class="badge">отменена</span> }</td>
              <td class="nw" data-l="дата">{{ w.docDate }}</td>
              <td class="wide" data-l="поставщик">{{ w.supplier }}</td>
              <td class="num" data-l="позиций">{{ w.itemsCount }}</td>
              <td class="num" data-l="сумма">{{ fmtMoney(w.total) }}</td>
              <td class="no-l">
                @if (w.hasFile) {
                  <span class="badge" title="Открыть файл накладной" (click)="openFile(w.id, $event)">📎 {{ wSheets(w) }}</span>
                }
                <span class="badge blue">открыть</span>
              </td>
            </tr>
          } @empty {
            <tr class="empty"><td colspan="6">Накладных пока нет</td></tr>
          }
        </table>

        @if (detail(); as d) {
          <hr class="hr" />
          <div class="row wb-head">
            <h3>Накладная №{{ d.number }} · {{ d.docDate }}</h3>
            @if (d.supplierPib) { <span class="muted pib">PIB {{ d.supplierPib }}</span> }
            <span class="badge">{{ d.currency ?? 'RSD' }}</span>
            @if (d.status === 'reversed') { <span class="badge amber">отменена — склад сторнирован</span> }
            <div class="spacer"></div>
            @if (d.hasFile) {
              <button class="btn sm" (click)="openFile(d.id, $event)">📎 {{ dSheets(d) }}</button>
              @for (e of d.extraFiles ?? []; track $index) {
                <button class="btn sm" title="Открыть отдельным окном" (click)="openFile(d.id, $event, $index)">📎 лист {{ $index + 2 }}</button>
              }
            }
            @if (d.status !== 'reversed') {
              <button class="btn sm danger" [disabled]="reversing()" (click)="reverseWaybill(d.id)">
                {{ reversing() ? 'Отменяем…' : '✕ Отменить приход' }}
              </button>
            }
          </div>
          <table class="tbl stack">
            <tr class="th-row"><th>Продукт</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Сумма</th><th class="num">PDV</th><th class="num">с PDV</th></tr>
            @for (i of d.items ?? []; track i.id) {
              <tr>
                <td>{{ i.productName }}</td>
                <td class="num nw" data-l="кол-во">{{ fmtQty(i.qty, i.unitCode ?? '') }}</td>
                <td class="num" data-l="цена">{{ fmtCost(i.price, i.unitCode ?? '') }}</td>
                <td class="num" data-l="сумма">{{ fmtMoney(i.qty * i.price) }}</td>
                <td class="num" data-l="pdv">@if (i.vatRate) { {{ trim(i.vatRate) }} % } @else { — }</td>
                <td class="num" data-l="с pdv">@if (i.vatRate) { {{ fmtMoney(i.qty * i.price * (1 + i.vatRate / 100)) }} } @else { {{ fmtMoney(i.qty * i.price) }} }</td>
              </tr>
            }
          </table>
          <div class="wb-sums">
            <span class="muted">нетто (без PDV):</span><b>{{ fmtMoney(detailNet(d)) }}</b>
            @if (detailVat(d) > 0) {
              <span class="muted">PDV:</span><b class="vat-note">{{ fmtMoney(detailVat(d)) }}</b>
              <span class="muted">к оплате:</span><b>{{ fmtMoney(detailNet(d) + detailVat(d)) }}</b>
            }
            @if (d.docTotalGross != null) {
              <span class="muted doc-line" title="как напечатано в документе">в доке: {{ trim(d.docTotalNet ?? 0) }} + {{ trim(d.docTotalVat ?? 0) }} → {{ trim(d.docTotalGross) }}</span>
            }
          </div>
        }
      </div>

      <!-- ===== создание ===== -->
      <div class="panel">
        <h3>Новая накладная (приход на склад)</h3>
        <div class="meta-grid">
          <label class="f">Номер<input [(ngModel)]="number" placeholder="напр. 1042" /></label>
          <label class="f">Дата<input type="date" [(ngModel)]="docDate" /></label>
          <label class="f f-full">Поставщик<input [(ngModel)]="supplier" /></label>
        </div>
        <hr class="hr" />

        @for (it of items(); track $index) {
          <div class="man-row">
            <select class="m-prod" [(ngModel)]="it.productId" aria-label="Продукт">
              <option [ngValue]="null">— продукт —</option>
              @for (p of products(); track p.id) {
                <option [ngValue]="p.id">{{ p.category }} · {{ p.name }}</option>
              }
            </select>
            <input class="m-qty" type="number" [(ngModel)]="it.qty" placeholder="Кол-во" aria-label="Количество" />
            <select class="m-unit" [(ngModel)]="it.unitId" aria-label="Единица">
              @for (u of units(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
            </select>
            <input class="m-price" type="number" [(ngModel)]="it.price" placeholder="Цена ₽" aria-label="Цена" />
            <button class="btn sm danger m-del" (click)="removeItem($index)">✕</button>
          </div>
        }
        <button class="btn sm" (click)="addItem()">+ позиция</button>
        <hr class="hr" />
        <div class="row">
          <div class="spacer"></div>
          <b>Итого: {{ fmtMoney(total()) }}</b>
          <button class="btn primary" [disabled]="saving() || !canSave()" (click)="save()">
            Приходовать на склад
          </button>
        </div>
        <p class="muted" style="font-size:12px">
          Все количества и цены — в БАЗОВЫХ единицах склада (г/мл/шт); перевод кг/л только для чтения.
          После проведения позиции сразу ложатся на склад и попадают в журнал движений.
        </p>
      </div>
    </div>

    <!-- ===== умный импорт из файла ===== -->
    <div class="panel" style="margin-top:16px">
      <h3>🤖 Умный приход: файл накладной → GPT → склад</h3>
      <label class="drop" [class.busy]="impBusy()">
        <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" (change)="onImpFile($event)" />
        <span class="drop-btn">{{ impBusy() ? 'Читаем документ…' : '📷 Фото или PDF накладной — можно несколько' }}</span>
        <span class="drop-hint">{{ busyHint() }}</span>
      </label>
      @if (impErr()) { <div class="err">{{ impErr() }}</div> }

      @if (!parsed() && pendFiles().length) {
        <div class="imp-files">
          @for (f of pendFiles(); track f.uid) {
            <span class="pend">
              <img class="thumb" [src]="f.dataUrl" [alt]="f.name" title="Кликните, чтобы открыть во весь экран" (click)="openGallery($index)" />
              <button class="pm" type="button" title="Убрать фото" (click)="removePend($index)">✕</button>
            </span>
          }
          <label class="add-more" title="Добавить ещё фото того же документа">
            ＋<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" (change)="addMoreFiles($event)" />
          </label>
          <button class="btn primary" [disabled]="impBusy()" (click)="parseFiles()">Разобрать как одну накладную</button>
          <span class="muted files-hint">GPT склеит листы в один документ и уберёт повторы дублей</span>
        </div>
      }

      @if (parsed(); as p) {
        <hr class="hr" />

        <div class="meta-grid">
          <label class="f">Номер<input [(ngModel)]="impNumber" /></label>
          <label class="f">Дата<input type="date" [(ngModel)]="impDate" /></label>
          <label class="f f-full">Поставщик<input [(ngModel)]="impSupplier" /></label>
        </div>
        @if (impGallery().length) {
          <div class="imp-file">
            @if (isPdf(curUrl())) {
              <a class="pdf-link" [href]="curUrl()" target="_blank" rel="noopener">📄 открыть PDF накладной</a>
            } @else {
              <img class="thumb" [src]="curUrl()" alt="Фото накладной" title="Кликните, чтобы открыть во весь экран" (click)="openGallery(curLb() ?? 0)" />
            }
            <span>
              📎 {{ p.fileName }}
              @if (p.extraFiles?.length) {
                · доп. {{ sheetsWord(p.extraFiles!.length) }}
              }
              · модель {{ p.model }}
            </span>
            <button
              type="button"
              class="btn sm"
              [disabled]="impBusy()"
              title="Перечитать фото заново и показать, что именно распознала модель — когда цифра в строке не сходится с документом"
              (click)="reparseWithTranscript()"
            >🔍 сверить с фото</button>
          </div>
          @if (p.transcript; as tr) {
            <pre class="transcript">{{ tr }}</pre>
          }
        }
        @if (impGallery().length > 1) {
          <div class="imp-files">
            @for (g of impGallery(); track $index) {
              @if (isPdf(g)) {
                <span class="badge clickable" (click)="openPdf(g)">📄 лист {{ $index + 1 }}</span>
              } @else {
                <img class="thumb" [src]="g" [attr.alt]="'Лист ' + ($index + 1)" title="Кликните, чтобы открыть во весь экран" (click)="openGallery($index)" />
              }
            }
          </div>
        }

        @if (impWarns().length) {
          <div class="err imp-msg">
            <b>⚠ Требует внимания:</b>
            <ul class="imp-msg-list">@for (w of impWarns(); track $index) { <li>{{ w }}</li> }</ul>
          </div>
        }
        @if (impFixes().length) {
          <div class="imp-note imp-msg">
            <b>🧐 Что распознавание уточнило само:</b>
            <ul class="imp-msg-list">@for (w of impFixes(); track $index) { <li>{{ w }}</li> }</ul>
          </div>
        }

        <div class="imp-head">
          <span>Позиция в документе</span><span>Кол-во · ед.</span>
          <span title="Цена ровно как напечатана в накладной — за ту единицу, что в документе (kg, kom, vez…). Её и правим, если OCR ошибся. Ниже показывается производная себестоимость за базовую единицу склада (₽/г, ₽/мл, ₽/шт), она идёт на склад">Цена из документа</span>
          <span>PDV</span>
          <span class="r">Нетто → к оплате</span><span>Позиция склада</span><span></span>
        </div>

        @for (it of impItems(); track $index) {
          <div class="imp-card" [class.warn-card]="it.vatSuspect || it.vatInferred || it.qtyForecast || it.doubt || lineMismatch(it)">
            <div class="c-name">
              <input class="doc-name" [(ngModel)]="it.rawName" title="Название товара, как напечатано в накладной — можно поправить, псевдоним запомнится по нему" aria-label="Название из документа" />
              @if (it.via; as v) {
                <span class="badge green">{{ viaLabel(v) }}</span>
              } @else {
                <span class="badge amber">нет в складе — решите ниже</span>
              }
              @if (it.qtyForecast) {
                <span class="badge amber" title="GPT решила, что позицию класть на склад содержимым (упаковки -> г/мл): количество и цена пересчитаны, сумма строки не изменилась">⚠ пересчёт по фасовке</span>
              }
              @if (it.doubt; as d) {
                <span class="badge amber" title="GPT не уверена в строке — сверьте с фото">⚠ вопрос GPT</span>
                <span class="qty-doc">{{ d }}</span>
              }
              <span class="doc-sum" [class.bad]="lineMismatch(it)" title="Сумма строки без PDV — деньги этой позиции. Правится вместе с ценой: меняете сумму — пересчитается цена, меняете цену — пересчитается сумма">
                {{ it.lineSumPrinted ? 'в доке:' : 'сумма строки:' }} <input class="mini" type="number" step="any" [(ngModel)]="it.lineSum" (ngModelChange)="onSumEdit(it)" aria-label="Сумма строки в документе" /> ₽
              </span>
            </div>

            <div class="c-qty">
              <span class="fl">Кол-во · баз. ед.</span>
              <input type="number" [(ngModel)]="it.qty" (ngModelChange)="recalcPrice(it)" title="Количество в базовых единицах (г/мл/шт)" aria-label="Количество" />
              <select [(ngModel)]="it.unitId" title="Базовая складская единица (г/мл/шт)" aria-label="Единица">
                <option [ngValue]="null">—</option>
                @for (u of units(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
              </select>
              @if (qtyHint(it)) { <span class="qty-doc">{{ qtyHint(it) }}</span> }
            </div>

            <div class="c-price">
              <span class="fl">Цена из документа</span>
              @if (it.docPricePrinted != null) {
                <input type="number" step="any" [(ngModel)]="it.docPricePrinted" (ngModelChange)="onDocPriceEdit(it)" [title]="priceTitle" aria-label="Цена как в документа" />
                <span class="qty-doc">за {{ it.docUnitPrinted || unitCodeOf(it.unitId) || 'ед.' }} из дока · на склад {{ baseCostReadout(it) }}</span>
              } @else {
                <input type="number" step="any" [(ngModel)]="it.price" (ngModelChange)="onPriceEdit(it)" [title]="priceTitle" placeholder="цена/баз." aria-label="Цена без PDV" />
                @if (priceHint(it)) { <span class="qty-doc">{{ priceHint(it) }}</span> }
              }
            </div>

            <div class="c-vat">
              <span class="fl">PDV</span>
              <div class="vat-in">
                <input type="number" min="0" max="100" step="0.5" [(ngModel)]="it.vatRate" (ngModelChange)="onVatChange(it)" placeholder="0" title="Ставка PDV из колонки «ПДВ», %; пусто или 0 — без НДС" aria-label="Ставка PDV" />
                <span class="vat-pct">%</span>
              </div>
              @if (it.vatSuspect) {
                <span class="badge amber" title="Итог PDV в документе дает одна из помеченных строк — сверьте ставку по фото">⚠ PDV?</span>
              }
              @if (it.vatInferred) {
                <span class="badge amber" title="Ставку PDV в документе не напечатали — её вывели по итогам документа, проверьте по фото">⚠ PDV выведен</span>
              }
            </div>

            <div class="c-sum">
              <span class="fl">Нетто → к оплате</span>
              <b>{{ trim(c((it.qty ?? 0) * (it.price ?? 0))) }} ₽</b>
              @if (it.vatRate) {
                <span class="vat-note">+{{ trim(c((it.qty ?? 0) * (it.price ?? 0) * it.vatRate / 100)) }}</span>
                <span class="gross-out">→ {{ trim(c((it.qty ?? 0) * (it.price ?? 0) * (1 + it.vatRate / 100))) }} ₽</span>
              }
            </div>

            <div class="c-prod">
              <span class="fl">Позиция склада</span>
              <div class="seg">
                <button [class.on]="it.mode==='match'" (click)="it.mode='match'">существующая</button>
                <button [class.on]="it.mode==='create'" (click)="it.mode='create'">создать новую</button>
              </div>
              @if (it.mode === 'match') {
                <select class="prod-sel" [(ngModel)]="it.productId">
                  <option [ngValue]="null">— выбрать позицию —</option>
                  @if (it.candidates.length) {
                    <optgroup label="похожие">
                      @for (cnd of it.candidates; track cnd.productId) {
                        <option [ngValue]="cnd.productId">{{ cnd.name }}</option>
                      }
                    </optgroup>
                  }
                  <optgroup label="все позиции">
                    @for (pr of products(); track pr.id) {
                      <option [ngValue]="pr.id">{{ pr.category }} · {{ pr.name }}</option>
                    }
                  </optgroup>
                </select>
                @if (it.productId && willAlias(it)) {
                  <span class="alias-hint">🔖 «{{ it.rawName }}» запомнится как псевдоним</span>
                }
              } @else {
                <div class="create-box">
                  <input class="cb-name" [(ngModel)]="it.newName" placeholder="Название на склад" aria-label="Название на склад" />
                  <input [(ngModel)]="it.newCategory" placeholder="Категория" aria-label="Категория" />
                  <select class="cb-unit" [(ngModel)]="it.newUnitId" aria-label="Складская единица">
                    @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">хранить в {{ u.code }}</option> }
                  </select>
                </div>
              }
            </div>

            <button class="btn sm danger c-del" title="Убрать строку" (click)="removeImp($index)">✕<span class="del-name"> Убрать строку</span></button>
          </div>
        }

        @if (hasSvcBlock()) {
          <div class="imp-svc">
            <span class="svc-hint">🏷 Не товары — учитываем отдельно и на склад не приходруем (скидки/служебные):</span>
            @for (d of discountsSeparate(); track $index) {
              <div class="svc-row" [class.svc-unk]="d.amount == null || d.includedInLineSum == null" [title]="d.doubt || d.name">
                <span class="svc-name">
                  {{ d.name }}
                  <small class="svc-meta">{{ kindLabel(d) }}@if (d.percent != null) { · {{ d.percent }}% }@if (d.productName) { · на «{{ d.productName }}» }</small>
                  @if (d.doubt) { <small class="svc-doubt">⚠ {{ d.doubt }}</small> }
                </span>
                <b class="svc-amt">{{ d.amount != null ? '−' + trim(c(d.amount)) : '—' }}</b>
              </div>
            }
            @if (hasDiscWithAmount()) {
              <div class="svc-row svc-sum">
                <span>Скидок всего</span>
                <b class="svc-amt">−{{ discSummaryShown() }}{{ discSummary() != null && discUncertain() ? ' ✱' : discSummary() == null ? ' ?' : '' }}</b>
              </div>
              @if (canApplyDisc()) {
                <button class="btn sm svc-apply" type="button"
                        title="Отдельная скидка уменьшает нетто: вычтем её из сумм строк тех товаров, к которым она привязана, — итоги совпадут с документом"
                        (click)="applyDiscountsToLines()">Вычесть скидки из строк</button>
              }
            }
            @for (d of discountsIncluded(); track $index) {
              <div class="svc-row svc-incl" [title]="d.doubt || 'уже учтена в суммах товарных строк — повторно не вычитается'">
                <span class="svc-name">
                  {{ d.name }}
                  <small class="svc-meta">{{ kindLabel(d) }}@if (d.percent != null) { · {{ d.percent }}% } · уже в строках</small>
                  @if (d.doubt) { <small class="svc-doubt">⚠ {{ d.doubt }}</small> }
                </span>
                <b class="svc-amt">{{ d.amount != null ? trim(c(d.amount)) : '—' }}</b>
              </div>
            }
            @for (s of servicesOnly(); track $index) {
              <div class="svc-row">
                <span class="svc-name" [title]="s.name">{{ s.name }}</span>
                <b class="svc-amt">{{ s.amount != null ? trim(c(s.amount)) : '—' }}</b>
              </div>
            }
          </div>
        }

        <div class="imp-foot">
          <div class="imp-totals">
            <div class="tt">
              <span class="muted">нетто (без PDV)</span><b>{{ fmtMoney(impTotal()) }}</b>
              <i [class.diff]="!totOk(impTotal(), docNet())" title="Нетто, как напечатано в документе — можно поправить">в доке: <input class="mini" type="number" step="any" [(ngModel)]="impDocNet" aria-label="Нетто в документе" /> ₽</i>
            </div>
            <div class="tt">
              <span class="muted">PDV</span><b class="vat-note">{{ fmtMoney(impVat()) }}</b>
              <i [class.diff]="!totOk(impVat(), docVat())" title="Итог PDV, как напечатано в документе — можно поправить">в доке: <input class="mini" type="number" step="any" [(ngModel)]="impDocVat" aria-label="PDV в документе" /> ₽</i>
            </div>
            <div class="tt grossline">
              <span><b>к оплате</b></span><b>{{ fmtMoney(impGross()) }}</b>
              <i [class.diff]="!totOk(impGross(), docGross())" title="Сумма к оплате, как напечатана в документе — можно поправить">в доке: <input class="mini" type="number" step="any" [(ngModel)]="impDocGross" aria-label="К оплате в документе" /> ₽</i>
            </div>
          </div>
          <div class="spacer"></div>
          <div class="confirm-wrap">
            <button class="btn primary" [disabled]="impSaving() || !canConfirm()" (click)="confirmImport()">
              Приходовать на склад
            </button>
            @if (!canConfirm() && confirmBlockers()) {
              <div class="confirm-hint">{{ confirmBlockers() }}</div>
            }
          </div>
        </div>
      }
    </div>

    <!-- просмотр фото пакета во весь экран: листы с телефона часто перекрываются — сравниваем по очереди.
         закрытие по клику вне фото или Esc, стрелки/A-D — между листами -->
    @if (lbPhoto(); as photo) {
      <div class="lightbox" (click)="closeLb()">
        <button class="lb-close" type="button">✕ Закрыть</button>
        @if (galleryCount() > 1) {
          <button class="lb-nav prev" type="button" [disabled]="curLb() === 0" (click)="stepLb(-1, $event)">‹</button>
          <button class="lb-nav next" type="button" [disabled]="curLb() == null || curLb()! >= galleryCount() - 1" (click)="stepLb(1, $event)">›</button>
        }
        <img [src]="photo" alt="Фото накладной" (click)="$event.stopPropagation()" />
        <div class="lb-cap">{{ lbCaption() }} — кликните вне фото, чтобы закрыть</div>
      </div>
    }
  `,
})
export class WaybillsComponent implements OnInit {
  private api = inject(ApiService);

  /** Esc закрывает увеличенное фото, стрелки листают пакет (как в нормальных просмотрщиках). */
  @HostListener('window:keydown.escape')
  onClosePhoto(): void {
    if (this.lbPhoto() != null) this.closeLb();
  }

  @HostListener('window:keydown', ['$event'])
  onLbKey(ev: KeyboardEvent): void {
    if (this.lbPhoto() == null) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // в полях «a/d» — просто буквы
    if (ev.key === 'ArrowRight' || ev.key.toLowerCase() === 'd') this.stepLb(1);
    else if (ev.key === 'ArrowLeft' || ev.key.toLowerCase() === 'a') this.stepLb(-1);
  }

  list = signal<WaybillShort[]>([]);
  detail = signal<Waybill | null>(null);
  products = signal<Product[]>([]);
  units = signal<Unit[]>([]);
  err = signal('');
  msg = signal('');
  saving = signal(false);

  number = '';
  supplier = '';
  docDate = today();
  items = signal<DraftItem[]>([{ productId: null, qty: null, unitId: null, price: null }]);

  fmtMoney = fmtMoney;
  fmtQty = fmtQty;
  fmtCost = fmtCost;
  trim = trim;
  c = cents; // округление денег до копеек в формулах шаблона

  /** Нетто/PDV карточки: считаем из строк (надёжно и для старых накладных без totals). */
  detailNet(d: Waybill): number {
    return d.totalNet ?? cents((d.items ?? []).reduce((s, i) => s + i.qty * i.price, 0));
  }
  detailVat(d: Waybill): number {
    return d.totalVat ?? cents((d.items ?? []).reduce((s, i) => s + cents((i.qty * i.price * (i.vatRate ?? 0)) / 100), 0));
  }

  total = computed(() =>
    this.items().reduce((s, i) => s + (i.qty ?? 0) * (i.price ?? 0), 0)
  );

  canSave = computed(() =>
    !!this.number.trim() &&
    this.items().some((i) => i.productId && (i.qty ?? 0) > 0 && i.unitId)
  );

  ngOnInit(): void {
    this.reload();
    this.api.products$().subscribe((p) => this.products.set(p));
    this.api.units$().subscribe((u) => this.units.set(u));
  }

  reload(): void {
    this.api.waybills$().subscribe({
      next: (v) => this.list.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  addItem(): void {
    this.items.update((arr) => [...arr, { productId: null, qty: null, unitId: null, price: null }]);
  }

  removeItem(i: number): void {
    this.items.update((arr) => arr.filter((_, idx) => idx !== i));
  }

  open(id: number): void {
    this.api.waybill$(id).subscribe({
      next: (d) => {
        this.detail.set(d);
        this.msg.set('');
        // чужой пакет фото не должен остаться в галерее, если разбор ещё не подтверждён
        this.extrasPreview.set([]);
        this.curLb.set(null);
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  save(): void {
    this.err.set('');
    this.saving.set(true);
    const body = {
      number: this.number.trim(),
      supplier: this.supplier,
      docDate: this.docDate,
      items: this.items()
        .filter((i): i is DraftItem & { productId: number; qty: number; unitId: number } =>
          !!i.productId && !!i.unitId && (i.qty ?? 0) > 0)
        .map((i) => ({ productId: i.productId, qty: i.qty, unitId: i.unitId, price: i.price ?? 0 })),
    };
    this.api.createWaybill(body).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.msg.set(`Накладная №${body.number} приходована на склад ✓`);
        this.detail.set(null);
        this.number = '';
        this.items.set([{ productId: null, qty: null, unitId: null, price: null }]);
        this.reload();
        void r;
      },
      error: (e) => {
        this.saving.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  // ==================== умный импорт из файла ====================

  parsed = signal<ImportParseResult | null>(null);
  impItems = signal<ImpDraft[]>([]);
  impBusy = signal(false);
  impSaving = signal(false);
  impErr = signal('');
  impNumber = '';
  impSupplier = '';
  impDate = today();
  /** Напечатанные итоги документа: взяты из накладной, значит тоже правятся руками — GPT могла ошибиться в цифре. */
  impDocNet: number | null = null;
  impDocVat: number | null = null;
  impDocGross: number | null = null;
  impFileName = signal('');
  /** Прочитанные в память фото до разбора (data URL держим тут — thumb, lightbox и base64 для API). */
  pendFiles = signal<{ uid: string; name: string; mime: string; dataUrl: string }[]>([]);
  /** Локальные превью доп. листов разобранного пакета (по порядку, без главного файла). */
  extrasPreview = signal<string[]>([]);
  /** Какой лист открыт во весь экран (null — lightbox закрыт). */
  curLb = signal<number | null>(null);
  /** Галерея листов: пока разбор не подтверждён — локальные превью, после — ссылка на сохранённый на сервере лист. */
  impGallery = computed<string[]>(() => {
    const p = this.parsed();
    if (!p) return this.pendFiles().map((f) => f.dataUrl);
    const first = this.pendFiles()[0]?.dataUrl;
    const extras =
      this.extrasPreview().length === p.extraFiles?.length
        ? this.extrasPreview()
        : (p.extraFiles ?? []).map((e) => `/api/import/file/${encodeURIComponent(e.stored)}`);
    return [first, ...extras].filter((x): x is string => !!x);
  });
  galleryCount = computed(() => this.impGallery().length);
  /** Текущий лист в шапке разбора (по умолчанию первый). */
  curUrl = computed(() => {
    const g = this.impGallery();
    const i = this.curLb() ?? 0;
    return g[i] ?? g[0] ?? '';
  });
  lbPhoto = computed(() => {
    const i = this.curLb();
    return i == null ? null : this.impGallery()[i] ?? null;
  });
  isPdf(url: string): boolean {
    return url.startsWith('data:application/pdf') || url.includes('mime=application/pdf');
  }
  openGallery(i: number | null): void {
    if (i == null) return;
    const url = this.impGallery()[i];
    if (!url) return;
    if (this.isPdf(url)) {
      window.open(url, '_blank');
      return;
    }
    this.curLb.set(i);
  }
  openPdf(url: string): void {
    window.open(url, '_blank');
  }
  closeLb(): void {
    this.curLb.set(null);
  }
  stepLb(d: number, ev?: Event): void {
    ev?.stopPropagation();
    const i = this.curLb();
    if (i == null) return;
    const next = i + d;
    if (next >= 0 && next < this.galleryCount()) this.curLb.set(next);
  }
  lbCaption(): string {
    const i = this.curLb();
    if (i == null) return '';
    const name = this.parsed() ? (i === 0 ? this.parsed()!.fileName : this.parsed()!.extraFiles?.[i - 1]?.name ?? '') : this.pendFiles()[i]?.name ?? '';
    const n = this.galleryCount();
    return `лист ${i + 1} из ${n}${name ? ' · ' + name : ''}`;
  }
  /** «файл» / «2 листа» в журнале и просмотре. */
  sheetsWord(n: number): string {
    const m10 = n % 10;
    const m100 = n % 100;
    const word = m10 === 1 && m100 !== 11 ? 'лист' : m10 >= 2 && m10 <= 4 && !(m100 >= 11 && m100 <= 14) ? 'листа' : 'листов';
    return `${n} ${word}`;
  }
  wSheets(w: WaybillShort): string {
    return w.extraCount ? this.sheetsWord(1 + w.extraCount) : 'файл';
  }
  dSheets(d: Waybill): string {
    const n = 1 + (d.extraFiles?.length ?? 0);
    return n > 1 ? `фото · ${this.sheetsWord(n)}` : 'фото накладной';
  }

  /** Подсказка под кнопкой выбора файла: что загружаем сейчас и какие файлы подходят. */
  busyHint(): string {
    if (this.impBusy()) return 'Распознавание занимает 10–60 сек — не закрывайте страницу';
    const n = this.pendFiles().length;
    if (!this.parsed() && n) return `листов в пакете: ${n} — можно добавить ещё или разбирать`;
    return (
      this.impFileName() ||
      'JPG / PNG / WEBP / GIF / PDF до 15 МБ каждое. Накладную можно сфотографировать кусками или несколько раз — система соберёт из фото одну накладную'
    );
  }

  baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));

  impTotal = computed(() => cents(this.impItems().reduce((s, i) => s + (i.qty ?? 0) * (i.price ?? 0), 0)));
  /** PDV как в печатных документах: НДС строки округляется до копейки, потом суммируется. */
  impVat = computed(() =>
    cents(this.impItems().reduce((s, i) => s + cents(((i.qty ?? 0) * (i.price ?? 0) * (i.vatRate ?? 0)) / 100), 0))
  );
  impGross = computed(() => cents(this.impTotal() + this.impVat()));

  /** Напечатанные в документе итоги (нетто / PDV / к оплате) — берутся из правок пользователя. */
  docNet(): number | null { const v = this.impDocNet; return v == null ? null : cents(v); }
  docVat(): number | null { const v = this.impDocVat; return v == null ? null : cents(v); }
  docGross(): number | null { const v = this.impDocGross; return v == null ? null : cents(v); }

  /** «Что исправилось само» + заметки ручных действий (учёт скидок) — один справочный список. */
  impFixes = computed(() => [...(this.parsed()?.corrections ?? []), ...this.discNotes()]);
  impWarns = computed(() => this.parsed()?.warnings ?? []);

  /** Скидки и служебные начисления — считаются отдельно и на склад не приходятся. */
  serviceLines = computed(() => this.parsed()?.serviceLines ?? []);
  /** Блок скидок из разбора (GPT выделяет их отдельной росписью). */
  discBlock = computed(() => this.parsed()?.discounts ?? null);
  /** Роспись скидок: блок разбора + запасной путь (скидки, собранные из строк на сервере). */
  discounts = computed<ImportDiscount[]>(() => {
    const blk = this.discBlock();
    if (blk?.items?.length) return blk.items;
    return this.serviceLines()
      .filter((s) => s.kind === 'discount')
      .map((s) => ({
        name: s.name,
        productName: null,
        discountKind: 'line' as const,
        amount: s.amount,
        percent: null,
        vatRate: null,
        includedInLineSum: null,
        doubt: null,
      }));
  });
  /** Скидки, ещё НЕ учтённые в суммах товарных строк — их вычитаем из итогов. */
  discountsSeparate = computed(() => this.discounts().filter((d) => d.includedInLineSum !== true));
  /** Скидки, уже сидящие в цене/сумме строк — показываем справочно, без вычитания. */
  discountsIncluded = computed(() => this.discounts().filter((d) => d.includedInLineSum === true));
  servicesOnly = computed(() => this.serviceLines().filter((s) => s.kind === 'service'));
  /** Σ скидок по модулю (на сколько документ дешевле товаров). */
  discountTotal = computed(() => this.discountsSeparate().reduce((s, x) => s + Math.abs(x.amount ?? 0), 0));
  /** Есть ли среди отдельных скидок хотя бы одна с прочитанной суммой — показывать строку «Скидок всего». */
  hasDiscWithAmount = computed(() => this.discountsSeparate().some((d) => d.amount != null));
  /** Кнопка «вычесть скидки из строк» имеет смысл, когда есть отдельная скидка с суммой. */
  canApplyDisc = computed(() => this.hasDiscWithAmount());
  /** Заметки от «учесть скидки в строках» — в тот же список «разбор уточнил сам». */
  discNotes = signal<string[]>([]);
  /** Подтверждённая документом сумма скидок; null — документ её не даёт. */
  discSummary = computed(() => this.discBlock()?.total ?? null);
  /** Сумма для строки «Скидок всего»: подтверждённая документом, иначе Σ известных отдельных. */
  discSummaryShown = computed(() => {
    const s = this.discSummary();
    return trim(cents(s != null ? s : this.discountTotal()));
  });
  /** Есть что показать в блоке скидок/служебных? */
  hasSvcBlock = computed(() => this.serviceLines().length > 0 || this.discounts().length > 0);
  /** Есть скидки с неопределённой суммой/учтённостью — показываем пометку «?». */
  discUncertain = computed(
    () => this.discounts().some((d) => d.doubt || d.amount == null || d.includedInLineSum == null)
  );
  kindLabel(d: ImportDiscount): string {
    return d.discountKind === 'percent' ? 'скидка %' : d.discountKind === 'promotion' ? 'акция/промо' : d.discountKind === 'line' ? 'скидка' : 'скидка?';
  }

  /** Деньги строки по напечатанным в документе Кол × Цена (если в доке печати цены нет — null). */
  docLineMoney(it: ImpDraft): number | null {
    if (it.docPricePrinted == null || it.docQtyPrinted == null) return null;
    return it.docQtyPrinted * it.docPricePrinted;
  }

  /**
   * Сам документ не сходится: напечатанная сумма строки ≠ напечатанные Кол × Цена.
   * После того как человек сам ввёл деньги строки, сверка с бумажными цифрами больше не о чём
   * предупреждает — правка не «уплывает», а является решением пользователя.
   */
  lineMismatch(it: ImpDraft): boolean {
    if (it.edited || it.lineSum == null) return false;
    const doc = this.docLineMoney(it);
    return doc != null && Math.abs(it.lineSum - doc) > Math.max(1, it.lineSum * 0.01);
  }

  /** Мой расчёт сходится с напечатанным в документе (±2%, но не меньше 1 din)? */
  totOk(mine: number, printed: number | null): boolean {
    if (printed == null) return true;
    return Math.abs(mine - printed) <= Math.max(1, printed * 0.02);
  }

  /**
   * Готовность к приходовке. МЕТОД, а не computed: карточки правятся по полям через ngModel
   * (edit объекта в массиве по ссылке), сигнал impItems() при этом не переиздаётся — computed
   * закэшировался бы и кнопка осталась серой даже после заполнения единицы/товара. Метод
   * читает текущие значения на каждом цикле change detection (его триггерит и сам select).
   */
  canConfirm(): boolean {
    const items = this.impItems();
    return (
      !!this.impNumber.trim() &&
      items.length > 0 &&
      items.every(
        (i) =>
          (i.qty ?? 0) > 0 &&
          i.unitId != null &&
          (i.mode === 'match' ? i.productId != null : !!i.newName.trim() && i.newUnitId != null)
      )
    );
  }

  /** Почему «Приходовать» ещё не кликабельна — строками, чтобы человек чинил, а не гадал. */
  confirmBlockers(): string {
    if (this.canConfirm()) return '';
    const out: string[] = [];
    if (!this.impNumber.trim()) out.push('не заполнен номер накладной');
    const bad: string[] = [];
    this.impItems().forEach((i, idx) => {
      const what =
        (i.qty ?? 0) <= 0 ? 'количество'
          : i.unitId == null ? 'единица склада'
          : i.mode === 'match' ? (i.productId == null ? 'товар не выбран' : null)
          : (!i.newName.trim() || i.newUnitId == null) ? 'название/единица нового товара'
          : null;
      if (what) bad.push(`строка ${idx + 1} «${i.rawName.slice(0, 30)}» — ${what}`);
    });
    if (bad.length) out.push(`не заполнено: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? `; … ещё ${bad.length - 3}` : ''}`);
    return out.join(' · ');
  }

  /** Выбор файлов: заменяем весь пакет (несколько фото/листов одной накладной). */
  onImpFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    this.parsed.set(null);
    this.impItems.set([]);
    this.extrasPreview.set([]);
    this.curLb.set(null);
    this.impErr.set('');
    this.msg.set('');
    this.impBusy.set(true);
    void this.readFiles(files).then((list) => {
      this.pendFiles.set(list);
      this.impBusy.set(false);
      if (!list.length) this.impErr.set('Не удалось прочитать файлы');
      else if (list.length === 1) this.parseFiles(); // один файл — разбор сразу, как раньше
      else this.impFileName.set('');
    });
  }

  /** Добавить ещё фото к уже выбранному пакету (второй лист, переснимка). */
  addMoreFiles(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    this.impErr.set('');
    this.impBusy.set(true);
    void this.readFiles(files).then((add) => {
      this.pendFiles.update((arr) => [...arr, ...add].slice(0, 8));
      this.impBusy.set(false);
    });
  }

  removePend(i: number): void {
    this.pendFiles.update((arr) => arr.filter((_, idx) => idx !== i));
  }

  /** FileReader по каждому файлу; pdf/gif без type от браузера — угадываем по расширению. */
  private readFiles(files: File[]): Promise<{ uid: string; name: string; mime: string; dataUrl: string }[]> {
    const MAX = 15 * 1024 * 1024;
    const guesses: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    return Promise.all(
      files.map(
        (f, i) =>
          new Promise<{ uid: string; name: string; mime: string; dataUrl: string } | null>((resolve) => {
            const ext = f.name.toLowerCase().split('.').pop() ?? '';
            const mime = f.type || guesses[ext] || '';
            if (!/^(image\/(png|jpeg|jpg|webp|gif)|application\/pdf)$/.test(mime)) {
              resolve(null);
              return;
            }
            if (f.size > MAX) {
              resolve(null);
              return;
            }
            const rd = new FileReader();
            const uid = `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`; // трек-ключ: два дубля одного фото — разные элементы
            rd.onload = () => resolve({ uid, name: f.name, mime, dataUrl: String(rd.result ?? '') });
            rd.onerror = () => resolve(null);
            rd.readAsDataURL(f);
          })
      )
    ).then((rs) => rs.filter((x): x is { uid: string; name: string; mime: string; dataUrl: string } => !!x && !!x.dataUrl));
  }

  /** Собрать из выбранных фото ОДну накладную: один вызов GPT на весь пакет. */
  parseFiles(): void {
    const list = this.pendFiles();
    if (!list.length || this.impBusy()) return;
    this.impErr.set('');
    this.parsed.set(null);
    this.impItems.set([]);
    this.curLb.set(null);
    this.impBusy.set(true);
    this.doParse(list);
  }

  private doParse(list: { uid: string; name: string; mime: string; dataUrl: string }[], debug = false): void {
    this.lastPackage = list;
    this.api
      .importParse$({
        files: list.map((f) => ({ fileName: f.name, mime: f.mime, base64: f.dataUrl.split(',')[1] ?? '' })),
        ...(debug ? { debug: true } : {}),
      })
      .subscribe({
        next: (r) => {
          this.impBusy.set(false);
          this.parsed.set(r);
          this.discNotes.set([]); // разбор новый — заметки про учёт скидок из прежнего больше не актуальны
          this.extrasPreview.set(list.slice(1).map((f) => f.dataUrl));
          this.curLb.set(0);
          this.impNumber = r.doc.number ?? '';
          this.impSupplier = r.doc.supplier ?? '';
          this.impDate = r.doc.date ?? today();
          this.impDocNet = r.doc.totalSum ?? null;
          this.impDocVat = r.doc.totalVat ?? null;
          this.impDocGross = r.doc.totalGross ?? null;
          this.impItems.set(r.items.map((it) => this.toDraft(it)));
        },
        error: (e) => {
          this.impBusy.set(false);
          this.impErr.set(httpErr(e));
        },
      });
  }

  /** Последний разобранный пакет фото — по нему можно перечитать документ с транскрипцией. */
  private lastPackage: { uid: string; name: string; mime: string; dataUrl: string }[] = [];

  /**
   * «Сверить с фото»: тот же пакет читается заново, но сервер отдаёт ещё и транскрипцию.
   * По ней видно, что именно модель увидела на листе, когда цифра в строке спорная.
   */
  reparseWithTranscript(): void {
    if (this.impBusy() || !this.lastPackage.length) return;
    this.impErr.set('');
    this.impBusy.set(true);
    this.doParse(this.lastPackage, true);
  }

  /** Строка разбора -> черновик решения: сервер уже пересчитал qty/price в базовые (г/мл/шт). */
  private toDraft(it: ImportItem): ImpDraft {
    const unitId = it.unitId ?? (it.match ? this.unitIdByCode(it.match.unitCode) : null);
    const doubt = it.doubt?.trim() ?? '';
    // сумма строки — якорь денег; в документах без колонки «Вред» собираем её из печатных Кол × Цена
    const printed = it.lineSum != null && it.lineSum > 0;
    const synthesized =
      !printed && it.docPricePrinted != null && it.docQtyPrinted != null
        ? Math.round(it.docQtyPrinted * it.docPricePrinted * 100) / 100
        : null;
    const lineSum = printed ? it.lineSum : synthesized;
    return {
      rawName: it.rawName,
      qty: it.qty,
      unitId,
      docUnitPrinted: it.docUnitPrinted ?? null,
      docQtyPrinted: it.docQtyPrinted ?? null,
      docPricePrinted: it.docPricePrinted ?? null,
      qtyForecast: !!it.qtyForecast,
      doubt: doubt || null,
      price: it.price,
      vatRate: it.vatRate,
      vatSuspect: !!it.vatSuspect,
      vatInferred: !!it.vatInferred,
      lineSum,
      lineSumPrinted: printed,
      edited: false,
      mode: it.match ? 'match' : 'create',
      productId: it.match?.productId ?? it.candidates[0]?.productId ?? null,
      via: it.match?.via ?? null,
      candidates: it.candidates,
      newName: it.newHint?.name ?? it.rawName,
      newCategory: it.newHint?.category ?? 'прочее',
      newUnitId: unitId ?? this.baseUnits()[0]?.id ?? null,
    };
  }

  unitCodeOf(unitId: number | null): string {
    return this.units().find((u) => u.id === unitId)?.code ?? '';
  }

  /** Подсказка под количеством: читаемое из базового + как напечатано в документе. */
  qtyHint(it: ImpDraft): string {
    if (it.qty == null) return '';
    const code = this.unitCodeOf(it.unitId);
    if (!code) return '';
    const human = fmtQty(it.qty, code);
    if (it.qtyForecast) {
      const printed = it.docQtyPrinted != null ? ` напечатано ${trim(it.docQtyPrinted)} ${it.docUnitPrinted ?? ''}` : ' колонка пустая';
      return `${human} · ${printed} — авто по фасовке в названии`;
    }
    const printed =
      it.docUnitPrinted && it.docQtyPrinted != null && it.docUnitPrinted !== code
        ? ` · в доке ${trim(it.docQtyPrinted)} ${it.docUnitPrinted}`
        : '';
    return `${human}${printed}`;
  }

  /** Подсказка под ценой: цена за базовую единицу показывается за удобную (₽/кг, ₽/л). */
  priceHint(it: ImpDraft): string {
    if (it.price == null) return '';
    const code = this.unitCodeOf(it.unitId);
    return code ? fmtCost(it.price, code) : '';
  }

  /** Деньги строки — единственный якорь: напечатанная сумма либо собранная из Кол × Цена при разборе. */
  private money(it: ImpDraft): number | null {
    return it.lineSum != null && it.lineSum > 0 ? it.lineSum : null;
  }

  /** Цену берут из документа и правят ею; ниже — производная себестоимость за базовую единицу склада. */
  readonly priceTitle = 'Цена как напечатана в накладной (за единицу документа). Поправьте, если OCR ошибся — деньги строки и себестоимость на склад пересчитаются';

  /** Себестоимость за базовую единицу склада (₽/г, ₽/мл, ₽/шт) — то, что реально приходуется. */
  baseCostReadout(it: ImpDraft): string {
    if (it.price == null) return '—';
    const code = this.unitCodeOf(it.unitId);
    return `${trim(it.price)} ₽/${code || 'ед.'}`;
  }

  /** Правка денег строки (и количества): цена за базовую = деньги ÷ количество, сумма не «уплывает». */
  recalcPrice(it: ImpDraft): void {
    const money = this.money(it);
    const q = it.qty ?? 0;
    if (money != null && q > 0) it.price = Math.round((money / q) * 1e10) / 1e10;
  }

  /** Человек ввёл сумму строки сам — печатная сверка больше не его вина. */
  onSumEdit(it: ImpDraft): void {
    it.edited = true;
    this.recalcPrice(it);
  }

  /** Правка цены за базовую единицу (когда в документе цены нет): деньги строки = количество × цена. */
  onPriceEdit(it: ImpDraft): void {
    it.edited = true;
    const q = it.qty ?? 0;
    if (q > 0 && it.price != null) it.lineSum = Math.round(q * it.price * 100) / 100;
  }

  /**
   * Правка цены как в накладной: деньги строки собираются из печатных Кол × Цена документа,
   * базовая себестоимость — следом из денег и базового количества. Так поле = цифре с бумаги.
   */
  onDocPriceEdit(it: ImpDraft): void {
    it.edited = true;
    if (it.docPricePrinted != null && it.docQtyPrinted != null && it.docQtyPrinted > 0) {
      it.lineSum = Math.round(it.docQtyPrinted * it.docPricePrinted * 100) / 100;
    } else if (it.docPricePrinted != null && (it.qty ?? 0) > 0) {
      // печатного количества нет — считаем цену за ту же единицу, что и базовая
      it.price = it.docPricePrinted;
      it.lineSum = Math.round((it.qty ?? 0) * it.price * 100) / 100;
    }
    this.recalcPrice(it);
  }

  /** Пользователь сам поставил ставку — снимаем пометки «прочитано неуверенно» / «выведено». */
  onVatChange(it: ImpDraft): void {
    it.vatSuspect = false;
    it.vatInferred = false;
  }

  private unitIdByCode(code: string | null): number | null {
    if (!code) return null;
    return this.units().find((u) => u.code === code)?.id ?? null;
  }

  viaLabel(via: string): string {
    return via === 'alias' ? '🔖 найдено по псевдониму' : via === 'name' ? 'найдено по названию' : via === 'llm' ? 'найдено GPT' : '';
  }

  /** Запомнит ли сервер псевдоним: написание в документе отличается от складского названия. */
  willAlias(it: ImpDraft): boolean {
    const p = this.products().find((x) => x.id === it.productId);
    if (!p) return false;
    const n = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ').trim();
    return n(p.name) !== n(it.rawName);
  }

  removeImp(i: number): void {
    this.impItems.update((arr) => arr.filter((_, idx) => idx !== i));
  }

  /** Ключ для сопоставления «скидка → товар»: без регистра/цифр/фасовки (350G, 1KG, 2200G) и пунктуации. */
  private normForDisc(s: string): string {
    return String(s ?? '')
      .toLowerCase()
      .replace(/đ/g, 'dj').replace(/š/g, 's').replace(/[ćč]/g, 'c').replace(/ž/g, 'z')
      .replace(/\d+\s*(kg|g|l|ml)\b/g, ' ')
      .replace(/\d+/g, ' ')
      .replace(/[^a-zа-я0-9]+/g, ' ')
      .trim();
  }

  /** Строка черновика, к которой относится скидка (по productName из блока); null — не найти. */
  private discTargetLine(d: ImportDiscount): ImpDraft | null {
    const key = this.normForDisc(d.productName ?? '');
    if (!key) return null;
    const lines = this.impItems();
    return (
      lines.find((l) => this.normForDisc(l.rawName) === key) ??
      lines.find((l) => {
        const rn = this.normForDisc(l.rawName);
        return rn.includes(key) || key.includes(rn);
      }) ??
      null
    );
  }

  /**
   * «Вычесть скидки из строк»: отдельная скидка законно уменьшает нетто (Σ строк − скидка = «в доке»).
   * Сумму каждой скидки снимаем со строки того товара, к которому она привязана (цена за единицу
   * пересчитывается из новых денег строки, количество не трогается); привязку не опознали —
   * распределяем пропорционально суммам строк. Скидки помечаются учтёнными и из росписи не исчезают.
   */
  applyDiscountsToLines(): void {
    const p = this.parsed();
    const seps = this.discountsSeparate().filter((d) => (d.amount ?? 0) > 0);
    if (!p || !seps.length) return;
    const lines = this.impItems().map((l) => ({ ...l }));
    const notes: string[] = [];
    for (const d of seps) {
      const amount = cents(d.amount ?? 0);
      const target = this.discTargetLine(d);
      if (target) {
        const base = target.lineSum ?? (target.qty ?? 0) * (target.price ?? 0);
        target.lineSum = Math.max(0, cents(base - amount));
        target.edited = true;
        if ((target.qty ?? 0) > 0) target.price = Math.round((target.lineSum / (target.qty as number)) * 1e10) / 1e10;
        notes.push(`«${d.name}» −${trim(amount)} вычтена из строки «${target.rawName}»`);
      } else {
        const sum = lines.reduce((s, l) => s + (l.lineSum ?? 0), 0);
        if (sum <= 0) continue;
        let left = amount;
        lines.forEach((l, i) => {
          const ls = l.lineSum ?? 0;
          const share = i === lines.length - 1 ? left : cents((amount * ls) / sum);
          left = cents(left - share);
          l.lineSum = Math.max(0, cents(ls - share));
          l.edited = true;
          if ((l.qty ?? 0) > 0) l.price = Math.round((l.lineSum / (l.qty as number)) * 1e10) / 1e10;
        });
        notes.push(`«${d.name}» −${trim(amount)} — товар в строках не опознан, распределена пропорционально суммам`);
      }
    }
    // проведённые скидки больше не «отдельные»: помечаем учтёнными, блок перерисуется в справочный
    const applied = new Set(seps.map((d) => d.name));
    const blk = p.discounts
      ? { ...p.discounts, items: p.discounts.items.map((d) => (applied.has(d.name) ? { ...d, includedInLineSum: true } : d)) }
      : null;
    this.parsed.set({ ...p, discounts: blk ?? p.discounts });
    this.impItems.set(lines);
    this.discNotes.update((arr) => [
      ...arr,
      ...notes,
      `Скидки вычтены из строк: нетто ${trim(this.impTotal())} — сверьте с «в доке»`,
    ]);
  }

  confirmImport(): void {
    const p = this.parsed();
    if (!p) return;
    this.impSaving.set(true);
    this.err.set('');
    const body = {
      number: this.impNumber.trim(),
      supplier: this.impSupplier,
      docDate: this.impDate,
      fileName: p.fileName,
      storedFile: p.storedFile,
      extraFiles: (p.extraFiles ?? []).map((e) => ({ stored: e.stored, name: e.name })),
      currency: p.doc.currency ?? 'RSD',
      supplierPib: p.doc.supplierPib ?? null,
      docTotalNet: this.impDocNet,
      docTotalVat: this.impDocVat,
      docTotalGross: this.impDocGross,
      items: this.impItems().map((i) => ({
        rawName: i.rawName,
        qty: i.qty,
        unitId: i.unitId,
        price: i.price ?? 0,
        vatRate: i.vatRate ?? null,
        productId: i.mode === 'match' ? i.productId : null,
        create:
          i.mode === 'create'
            ? { name: i.newName.trim(), category: i.newCategory.trim() || 'прочее', unitId: i.newUnitId }
            : null,
      })),
    };
    this.api.importConfirm$(body).subscribe({
      next: (r) => {
        this.impSaving.set(false);
        const created = r.created.length ? ` · создано: ${r.created.map((c) => `«${c.name}»`).join(', ')}` : '';
        const aliasNote = r.aliasesSaved ? ` · 🔖 запомнено ${r.aliasesSaved} псевдонимов` : '';
        this.msg.set(`Накладная №${body.number} приходована с файла ✓${created}${aliasNote}`);
        this.parsed.set(null);
        this.impItems.set([]);
        this.impFileName.set('');
        this.pendFiles.set([]);
        this.extrasPreview.set([]);
        this.lastPackage = [];
        this.curLb.set(null);
        this.detail.set(null);
        this.reload();
      },
      error: (e) => {
        this.impSaving.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  openFile(id: number, ev: Event, att?: number): void {
    ev.stopPropagation();
    window.open(`/api/waybills/${id}/file${att != null ? `?att=${att}` : ''}`, '_blank');
  }

  // ==================== откат (сторно) накладной ====================

  reversing = signal(false);

  reverseWaybill(id: number): void {
    if (
      !confirm(
        'Отменить накладную? Приход будет сторнирован со склада, а остатки и средняя себестоимость пересчитаны, как будто поставки не было.\n\nОтменить не получится, если часть товара уже списана в производство.'
      )
    ) {
      return;
    }
    this.err.set('');
    this.msg.set('');
    this.reversing.set(true);
    this.api.reverseWaybill$(id).subscribe({
      next: (r) => {
        this.reversing.set(false);
        this.msg.set(`Накладная отменена ✓ — пересчитано позиций: ${r.productsRecalculated}`);
        this.detail.set(null);
        this.reload();
      },
      error: (e) => {
        this.reversing.set(false);
        this.err.set(httpErr(e));
      },
    });
  }
}
