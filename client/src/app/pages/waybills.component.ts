import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, Injector, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../core/api.service';
import { LogService } from '../core/log.service';
import { Product, Unit, Waybill, WaybillShort, ImportParseResult, ImportItem, ImportDiscount } from '../core/models';
import { cents, fmtCost, fmtDateTime, fmtMoney, fmtQty, httpErr, today, trim } from '../core/format';
import { currencySymbol } from '../core/currency';

interface DraftItem {
  productId: number | null;
  qty: number | null;
  unitId: number | null;
  price: number | null;
}

/** Категория номенклатуры из справочника: имя + оформление (иконка/цвет) для выбора. */
interface CategoryOption {
  id: number;
  name: string;
  icon?: string;
  color?: string;
}

/** Решение по одной распознанной строке: привязать к позиции или создать новую. */
interface ImpDraft {
  rawName: string;
  qty: number | null;         // уже в базовых единицах (г/мл/шт)
  unitId: number | null;      // базовая единица склада
  docUnitPrinted: string | null; // как напечатано в документе («kg») — для сверки
  docQtyPrinted: number | null;  // напечатанное количество (50)
  docPricePrinted: number | null; // напечатанная цена за напечатанную единицу — редактируется
  qtyForecast: boolean;      // qty пересчитан по решению ИИ (упаковки -> г/мл)
  doubt: string | null;      // вопрос ИИ по строке — подсветить человеку
  warnings: string[];        // замечания именно по этой строке — показываются в карточке
  price: number | null;       // цена за базовую единицу — производная, только чтение
  vatRate: number | null;     // ставка PDV, % (5/10/20) или null
  vatSuspect: boolean;        // ставка прочитана неуверенно — проверить по фото
  vatInferred: boolean;       // ставку не напечатали — вывели по итогам документа
  lineSum: number | null;     // деньги строки — якорь всех пересчётов, редактируются
  lineSumPrinted: boolean;    // сумма напечатана в документе (иначе это Кол × Цена)
  /** Скидка на товар из отдельной строки POPUST/акции — уже вычтена из lineSum и цены. */
  discount: { name: string; amount: number; amountGross: number | null; percent: number | null; vatRate: number | null; reason: string | null } | null;
  edited: boolean;            // человек сам ввёл деньги строки — печатная сверка больше не указатель
  mode: 'match' | 'create';
  productId: number | null;
  /** Выбранная в карточке категория для фильтра списка товаров ('' — все категории). */
  pickCat: string;
  via: string | null;         // name | alias | llm
  candidates: { productId: number; name: string; sim?: number }[];
  newName: string;
  newCategory: string;
  newUnitId: number | null;   // базовая складская единица для новой позиции
  /** Снимок сразу после разбора — кнопка «вернуть как было» в карточке. */
  orig: ImpOrig;
}

/** Значения строки на момент разбора: что вернуть, если правки завели не туда. */
interface ImpOrig {
  qty: number | null;
  unitId: number | null;
  docPricePrinted: number | null;
  price: number | null;
  vatRate: number | null;
  vatSuspect: boolean;
  vatInferred: boolean;
  lineSum: number | null;
  edited: boolean;
  mode: 'match' | 'create';
  productId: number | null;
  pickCat: string;
  newName: string;
  newCategory: string;
  newUnitId: number | null;
}

/** Состояние строки для статуса и фильтра: что мешает провести её на склад. */
type ImpLineState = 'fix' | 'check' | 'new' | 'ready';

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
    /* оформление блока умного прихода */
    .smart-tabs{display:inline-flex;gap:4px;margin:10px 0 12px;padding:3px;background:#eef2f7;border-radius:10px}
    .smart-tabs button{border:0;background:transparent;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer}
    .smart-tabs button.on{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(15,23,42,.14)}

    /* живой лог сервера: этапы распознавания */
    .ai-log{margin:10px 0 12px;border:1px solid #dbe3ee;border-radius:10px;background:#0f172a;overflow:hidden}
    .ai-log-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#16213a;color:#cbd5e1;font-size:12px}
    .ai-log-head b{color:#e2e8f0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
    .ai-log-head .btn{padding:2px 8px;font-size:11px}
    .ai-log-body{background:#f8fafc;border:1px solid var(--border);border-radius:10px;color:#334155;max-height:230px;overflow:auto;padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.45}
    .ai-line{white-space:pre-wrap;word-break:break-word;margin:2px 0}
    .ai-line .t{color:#64748b;margin-right:7px;font-variant-numeric:tabular-nums}
    .ai-line.k-thinking{color:#6d7be0;font-style:italic}
    .ai-line.k-tool{color:#0b7dbb}
    .ai-line.k-result{color:#17834f}
    .ai-line.k-error{color:#b4232a}
    .live-dot{width:8px;height:8px;border-radius:50%;background:#64748b;flex:0 0 auto}
    .live-dot.on{background:#22c55e;animation:live 1.4s ease-in-out infinite}
    @keyframes live{50%{opacity:.35}}


    /* ===== умный приход: просмотр фото документа ===== */
    .imp-file{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}
    .thumb{width:44px;height:44px;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:zoom-in;display:block}
    .pdf-link{font-size:12px;color:var(--accent);cursor:pointer;text-decoration:underline}
    /* печатная транскрипция ИИ: показывает, что именно модель увидела на фото */
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
    /* мини-поля: это цифры из накладной, их правят прямо в карточке — поэтому плотнее обычных */
    .mini{width:74px;min-width:0;padding:3px 6px}
    .prod-sel{width:100%;min-width:0}
    /* auto-fit: в узкой колонке «позиция склада» поля сами переносятся, на широком экране — в одну строку */
    .create-box{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
    .create-box input,.create-box select{width:100%;min-width:0}
    .create-box .cb-name{grid-column:1/-1}
    /* категория новой позиции: селект из справочника + метка с иконкой и цветом выбранной категории */
    .cb-cat-wrap{display:flex;align-items:center;gap:6px;min-width:0}
    .cb-cat-wrap select{flex:1 1 auto;width:auto;min-width:0}
    .cb-cat-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;border:1px solid rgba(15,23,42,.08);font-size:15px;line-height:1}

    /* ===== карточки распознанных строк: читаемая карточка вместо плотной сетки ===== */
    /* панель фильтров над списком */
    .rc-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 4px;padding:0 2px}
    .rc-bar-info{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
    .rc-bar-info b{font-size:14px}
    .rc-bar-info .muted{font-size:11.5px}
    .rc-filters{display:inline-flex;gap:4px;margin-left:auto;padding:3px;background:#eef2f7;border-radius:10px}
    .rc-filters button{border:0;background:transparent;border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap}
    .rc-filters button .n{display:inline-block;margin-left:3px;font-variant-numeric:tabular-nums;opacity:.85}
    .rc-filters button.on{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(15,23,42,.14)}
    .rc-filters button.on.hot{color:#8a5a00}
    .rc-empty-filter{margin-top:10px;border:1px dashed var(--border);border-radius:10px;padding:18px;text-align:center;color:var(--muted);font-size:13px;background:#fbfcfe}

    /* сама карточка: цветная полоса слева показывает состояние */
    .rc{margin-top:10px;border:1px solid var(--border);border-left:4px solid #c3d5e6;border-radius:12px;background:#fff;box-shadow:var(--shadow);overflow:hidden}
    .rc-fix,.rc-check{border-left-color:#e0a800}
    .rc-new{border-left-color:var(--accent)}
    .rc-ready{border-left-color:#22a35a}

    .rc-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:12px;align-items:start;padding:12px 14px 10px;background:linear-gradient(180deg,#fbfdff,#fff);border-bottom:1px solid #eef3f8}
    .rc-idx{width:26px;height:26px;border-radius:8px;background:#eef4fb;color:#3b5a78;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:2px}
    .rc-title{display:flex;flex-direction:column;gap:6px;min-width:0}
    .rc-name{width:100%;min-width:0;font-size:15px;font-weight:700;padding:2px 4px;border-color:transparent;background:transparent;border-radius:6px}
    .rc-name:hover{border-color:var(--border);background:#fff}
    .rc-name:focus{border-color:var(--accent);background:#fff;box-shadow:0 0 0 3px var(--accent-soft)}
    .rc-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .rc-state{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:700;white-space:nowrap}
    .rc-state i{width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 auto}
    .rc-state.st-ready{background:#e9f8ef;color:#17834f}
    .rc-state.st-fix,.rc-state.st-check{background:#fff4d6;color:#8a5a00}
    .rc-state.st-new{background:#e7f2fd;color:#0b6aa8}
    .rc-tag{display:inline-block;padding:1px 8px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:11px;font-weight:600;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
    .rc-tag.amber{background:var(--amber-soft);color:var(--amber)}
    .rc-tag.green{background:var(--green-soft);color:var(--green)}
    .rc-money{text-align:right;font-variant-numeric:tabular-nums;min-width:128px}
    .rc-money-l{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.35px;color:var(--muted)}
    .rc-money b{display:block;font-size:18px;line-height:1.2;margin-top:1px}
    .rc-money small{display:block;font-size:11px;color:var(--muted);margin-top:2px;white-space:nowrap}
    .rc-x{width:30px;height:30px;flex:0 0 auto;border:1px solid var(--border);border-radius:8px;background:#fff;color:#94a3b8;font:inherit;font-size:13px;cursor:pointer;padding:0}
    .rc-x:hover{border-color:var(--red);background:var(--red-soft);color:var(--red)}

    /* тело: слева цифры (2×2), справа привязка к складу */
    .rc-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr)}
    .rc-nums{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 12px;padding:12px 14px;border-right:1px solid #eef3f8;align-content:start}
    .rc-field{display:flex;flex-direction:column;gap:3px;min-width:0}
    .rc-label{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.35px;color:var(--muted)}
    .rc-label em{font-style:normal;font-size:11px;font-weight:500;text-transform:none;letter-spacing:0;color:#94a3b8}
    .rc-inline{display:flex;align-items:stretch;gap:6px;min-width:0}
    .rc-inline input{flex:1 1 auto;min-width:0;font-weight:600;font-variant-numeric:tabular-nums}
    .rc-inline select{flex:0 0 76px;min-width:0}
    .rc-cur{flex:0 0 auto;display:inline-flex;align-items:center;padding:0 4px;font-size:12px;color:var(--muted);white-space:nowrap}
    .rc-hint{font-size:11.5px;line-height:1.35;color:var(--muted)}
    .rc-hint.bad{color:var(--amber);font-weight:600}

    .rc-match{display:flex;flex-direction:column;gap:8px;padding:12px 14px;min-width:0}
    .rc-match-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
    /* категория и товар — два отдельных поля, а не склейка «категория · товар» */
    .rc-pick{display:grid;grid-template-columns:minmax(0,200px) minmax(0,1fr);gap:8px}
    .rc-pick-field{display:flex;flex-direction:column;gap:3px;min-width:0}
    .rc-pick-label{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;color:#94a3b8}
    .rc-pick select{width:100%;min-width:0}
    .rc-seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
    .rc-seg button{border:0;background:#fff;padding:5px 10px;font:inherit;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap}
    .rc-seg button + button{border-left:1px solid var(--border)}
    .rc-seg button.on{background:var(--accent);color:#fff}
    .rc-sugg{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .rc-sugg-l{font-size:11.5px;color:var(--muted)}
    .rc-sugg-btn{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px dashed #b9cde2;border-radius:999px;background:#f8fbff;color:#25465f;padding:4px 10px;font:inherit;font-size:12px;font-weight:600;text-align:left;cursor:pointer}
    .rc-sugg-btn:hover{border-color:var(--accent);background:var(--accent-soft)}
    .rc-sugg-btn.on{border-style:solid;border-color:#7cc79c;background:var(--green-soft);color:#146c43}
    .rc-sugg-btn small{font-weight:500;opacity:.7;flex:0 0 auto}

    /* замечания строки — отдельной зоной под полями, а не вперемешку с названием */
    .rc-notes{display:grid;gap:5px;padding:0 14px 10px}
    .rc-note{font-size:12px;line-height:1.45;color:#8a5a00;background:#fff8e6;border:1px solid #f0d9a6;border-radius:8px;padding:6px 10px}
    .rc-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 14px;background:#fafcff;border-top:1px solid #eef3f8}
    .rc-why{flex:1 1 240px;min-width:0;font-size:12px;color:var(--muted)}
    .rc-why.why-fix,.rc-why.why-check{color:#8a5a00;font-weight:600}
    .rc-why.why-ready{color:#146c43}
    .rc-reset{border:0;background:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;padding:4px 2px;text-decoration:underline;text-underline-offset:2px}
    .rc-reset:hover{color:var(--text)}
    .rc-reset:disabled{opacity:.4;cursor:default;text-decoration:none}
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
    .m-del{justify-self:end}

    /* ===== журнал и просмотр накладной ===== */
    .wb-row{cursor:pointer}
    .wb-row.reversed td{opacity:.5}
    .wb-head{align-items:center}
    .wb-head h3{margin:0}
    .wb-head .pib{font-size:12px}
    /* кто принял накладную / отменил приход */
    .wb-head .accepted{font-size:12px;display:inline-flex;gap:4px;align-items:baseline}
    .small{font-size:12px}
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
    @media (max-width:640px){
      .wb-head h3{flex:1 1 100%;font-size:15px}
      .wb-head .spacer{display:none}
      .imp-foot .spacer{display:none}
      /* поля «номер/дата/поставщик» уже двухколоночные в @container (max-width:560px) — на телефоне они и так узкие */
      /* на телефоне поля новой позиции друг под другом: в две колонки они превращались в узкие щели */
      .create-box{grid-template-columns:minmax(0,1fr)}
      .create-box .cb-name,.create-box .cb-unit{grid-column:1/-1}
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
    }
    /* ===== умный приход 2.0 ===== */
    .sm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
    .sm-title{display:flex;gap:12px;align-items:flex-start;min-width:0}
    .sm-ico{flex:0 0 auto;width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;background:linear-gradient(135deg,#e8f0ff,#f5ecff);border:1px solid #dbe6fb}
    .sm-head h3{margin:0;font-size:18px;line-height:1.25}
    .sm-head p{margin:3px 0 0;font-size:12px;color:var(--muted);line-height:1.45;max-width:640px}
    .sm-state{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700}
    .sm-state.on{background:#eef4ff;color:#1e4a8a}
    .sm-state.ok{background:#e9f8ef;color:#18794e}
    .sm-state.na{background:#f1f5f9;color:#475569}
    .sm-steps{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 8px}
    .sm-step{flex:1 1 150px;display:flex;gap:9px;align-items:center;border:1px solid var(--border);border-radius:10px;padding:8px 10px;background:#fbfcfe;min-width:0}
    .sm-step b{display:block;font-size:12.5px;line-height:1.2}
    .sm-step small{display:block;font-size:11px;color:var(--muted)}
    .sm-step-dot{flex:0 0 auto;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;background:#e2e8f0;color:#64748b}
    .sm-step.on{background:#eef4ff;border-color:#bcd3f7}
    .sm-step.on .sm-step-dot{background:var(--accent);color:#fff;animation:pulse 1.2s ease-in-out infinite}
    .sm-step.done .sm-step-dot{background:#22c55e;color:#fff}
    .sm-last{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:-2px 0 10px}
    .sm-shot{display:grid;grid-template-columns:1.2fr 1fr;gap:10px;margin:4px 0 8px}
    .sm-shot-main,.sm-shot-side{position:relative;display:flex;align-items:center;gap:12px;border-radius:12px;padding:14px 16px;cursor:pointer;min-width:0;transition:border-color .15s,box-shadow .15s}
    .sm-shot-main{border:1.5px dashed var(--accent);background:linear-gradient(135deg,#f2f7ff,#faf5ff)}
    .sm-shot-side{border:1.5px dashed var(--border);background:#fbfcfe}
    .sm-shot-main:hover,.sm-shot-side:hover{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
    .sm-shot input[type='file']{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:0}
    .sm-shot-ico{flex:0 0 auto;width:42px;height:42px;border-radius:12px;background:#fff;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:20px}
    .sm-shot b{display:block;font-size:14.5px;line-height:1.25}
    .sm-shot small{display:block;font-size:11.5px;color:var(--muted);margin-top:2px}
    .sm-shot-hint{font-size:12px;color:var(--muted);margin:2px 0 12px}
    .sm-pend{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 12px}
    .sm-logbar{display:flex;justify-content:flex-end;margin:2px 0 6px}
    .sm-log-toggle{border:0;background:none;color:var(--muted);font-size:12px;cursor:pointer;padding:4px 2px}
    .sm-log-toggle:hover{color:var(--text)}
    .sm-passport{border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:linear-gradient(180deg,#fbfdff,#fff);margin:4px 0 12px}
    .sm-passport-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between}
    .sm-doc{display:flex;align-items:center;gap:10px;min-width:0}
    .sm-doc-ico{flex:0 0 auto;width:36px;height:36px;border-radius:10px;background:#fff;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px}
    .sm-doc b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
    .sm-doc small{display:block;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
    .sm-passport-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
    .sm-passport-tools .btn{position:relative;overflow:hidden}
    .sm-ai{font-size:12px;color:var(--muted);max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hidden-file{position:absolute;inset:0;opacity:0;font-size:0;cursor:pointer}
    .sm-fields{display:grid;grid-template-columns:minmax(0,1fr) 170px minmax(0,1.6fr);gap:10px;margin:10px 0 0}
    .sm-check{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-radius:10px;padding:8px 10px;margin-top:10px;font-size:12px}
    .sm-check.ok{background:#eaf8f0;color:#146c43}
    .sm-check.bad{background:#fff7e2;color:#8a5a00}
    .sm-check.na{background:#f1f5f9;color:#475569}
    .sm-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:26px 18px;border:1px dashed var(--border);border-radius:12px;background:#fbfcfe;margin-top:10px}
    .sm-empty-ico{font-size:34px}
    .sm-empty b{font-size:16px}
    .sm-empty p{margin:0;max-width:540px;color:#8a5a00;background:#fff7e2;border:1px solid #f0d9a6;border-radius:8px;padding:8px 12px;font-size:13px}
    .sm-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
    .sm-empty-file{font-size:12px}

    .sm-check-ico{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;background:#fff;flex:0 0 auto}
    .sm-check-title{font-weight:700;margin-right:2px}
    .sm-chip{background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:999px;padding:3px 10px;font-variant-numeric:tabular-nums;white-space:nowrap}
    .sm-chip.ok{border-color:#8fd6ab}
    .sm-chip:not(.ok){border-color:#e6b95c;background:#fffbef}
    .sm-chip i{font-style:normal;font-weight:700;margin-left:4px}
    .sm-count{background:#eef2f7;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:700;color:#475569}
    .sm-notes{border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px}
    .sm-notes summary{cursor:pointer;font-weight:600;outline:none}
    .sm-notes.bad{background:#fff7e2;border:1px solid #f0d9a6;color:#8a5a00}
    .sm-notes.ok{background:var(--accent-soft);color:#1e4a8a}
    .sm-notes ul{margin:6px 0 0;padding-left:18px}
    .sm-notes li{margin:2px 0;line-height:1.4}
    .sm-docnums{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:2px}
    .sm-docnums .mini{width:100%;max-width:none}
    .sm-result-sum{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:13px}
    .sm-result-sum b{font-variant-numeric:tabular-nums}
    @media (max-width:640px){
      .sm-docnums{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
      .sm-docnums .f:last-child{grid-column:1/-1}
      .imp-foot{padding:10px 12px}
      .sm-result-sum{width:100%;justify-content:center}
    }
    @media (max-width:1100px){
      .sm-shot{grid-template-columns:1fr}
      .sm-fields{grid-template-columns:minmax(0,1fr) 160px}
      .rc-body{grid-template-columns:minmax(0,1fr)}
      .rc-nums{border-right:0;border-bottom:1px solid #eef3f8}
      .prod-sel{max-width:none}
    }
    /* карточки строк на телефоне: крупные поля в один столбец, итог и крестик всегда в шапке */
    @media (max-width:640px){
      .rc-head{grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"idx money x" "title title title";gap:8px 10px;padding:10px 12px}
      .rc-idx{grid-area:idx}
      .rc-money{grid-area:money;justify-self:end;min-width:0}
      .rc-money b{font-size:16px}
      .rc-x{grid-area:x;width:36px;height:36px}
      .rc-title{grid-area:title}
      .rc-name{font-size:14.5px}
      .rc-nums{grid-template-columns:minmax(0,1fr);padding:10px 12px;gap:10px}
      .rc-inline select{flex-basis:86px}
      .rc-match{padding:10px 12px}
      .rc-pick{grid-template-columns:minmax(0,1fr)}
      .rc-notes{padding:0 12px 10px}
      .rc-foot{padding:8px 12px}
      .rc-why{flex-basis:100%}
      .rc-reset{min-height:36px}
      .rc-seg{width:100%}
      .rc-seg button{flex:1;padding:9px 8px;font-size:12.5px}
      .rc-filters{width:100%;margin-left:0}
      .rc-filters button{flex:1}
      .rc-bar-info .muted{display:none}
    }
`,
  ],
  template: `
    <h1 class="page-title">📥 Входящие накладные</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid2 wl">
      <!-- ===== список ===== -->
      <div class="panel" id="journal">
        <h3>Журнал накладных</h3>
        <table class="tbl stack">
          <tr class="th-row"><th>№</th><th>Дата</th><th>Поставщик</th><th>Принял</th><th class="num">Поз.</th><th class="num">Сумма</th><th></th></tr>
          @for (w of list(); track w.id) {
            <tr class="wb-row" [class.reversed]="w.status === 'reversed'" (click)="open(w.id)">
              <td><b>{{ w.number }}</b> @if (w.status === 'reversed') { <span class="badge">отменена</span> }</td>
              <td class="nw" data-l="дата">{{ w.docDate }}</td>
              <td class="wide" data-l="поставщик">{{ w.supplier }}</td>
              <td class="nw small" data-l="принял">
                @if (w.acceptedLogin) {
                  <b [title]="w.acceptedLogin">{{ w.acceptedName || w.acceptedLogin }}</b>
                  <div class="muted">{{ fmtWhen(w.acceptedAt) }}</div>
                } @else {
                  <span class="muted">—</span>
                }
              </td>
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
            <tr class="empty"><td colspan="7">Накладных пока нет</td></tr>
          }
        </table>

        @if (detail(); as d) {
          <hr class="hr" />
          <div class="row wb-head">
            <h3>Накладная №{{ d.number }} · {{ d.docDate }}</h3>
            @if (d.supplierPib) { <span class="muted pib">PIB {{ d.supplierPib }}</span> }
            <span class="badge">{{ d.currency ?? 'RSD' }}</span>
            @if (d.acceptedLogin) {
              <span class="muted small accepted">принял: <b [title]="d.acceptedLogin">{{ d.acceptedName || d.acceptedLogin }}</b> · {{ fmtWhen(d.acceptedAt) }}</span>
            }
            @if (d.reversedLogin) {
              <span class="muted small accepted">отменил: <b [title]="d.reversedLogin">{{ d.reversedName || d.reversedLogin }}</b> · {{ fmtWhen(d.reversedAt) }}</span>
            }
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
      <div class="panel" id="new">
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
            <input class="m-price" type="number" [(ngModel)]="it.price" [placeholder]="'Цена, ' + cur()" aria-label="Цена" />
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
    <div class="panel" id="smart" style="margin-top:16px">
      <div class="sm-head">
        <div class="sm-title">
          <span class="sm-ico">🧾</span>
          <div>
            <h3>Умный приход</h3>
            <p>Сфотографируйте накладную — ИИ прочитает позиции, PDV и скидки и сверит итоги с документом</p>
          </div>
        </div>
        @if (impBusy()) {
          <span class="sm-state on"><i class="live-dot on"></i>ИИ работает</span>
        } @else if (parsed()) {
          <span class="sm-state" [class.ok]="impItems().length" [class.na]="!impItems().length">{{ impItems().length ? '✓ разобрано' : '— это не накладная' }}</span>
        }
      </div>

      @if (impBusy()) {
        <div class="sm-steps" aria-label="Этапы распознавания">
          @for (st of smartSteps; track st.n) {
            <div class="sm-step" [class.on]="st.n === impAct()" [class.done]="st.n < impAct()">
              <span class="sm-step-dot">{{ st.n < impAct() ? '✓' : st.n }}</span>
              <div><b>{{ st.title }}</b><small>{{ st.hint }}</small></div>
            </div>
          }
        </div>
        <div class="sm-last" title="Текущий этап">{{ lastLog() || 'Готовлю файл…' }}</div>
      }

      @if (!parsed() && !impBusy()) {
        <div class="sm-shot">
          <label class="sm-shot-main">
            <input type="file" accept="image/*" capture="environment" (change)="onImpFile($event)" />
            <span class="sm-shot-ico">📷</span>
            <span><b>Снять накладную</b><small>камера телефона · лист целиком, без наклона</small></span>
          </label>
          <label class="sm-shot-side">
            <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" (change)="onImpFile($event)" />
            <span class="sm-shot-ico">📎</span>
            <span><b>Выбрать файлы</b><small>JPG · PNG · PDF до 15 МБ · до 8 листов</small></span>
          </label>
        </div>
        <div class="sm-shot-hint">{{ busyHint() }}</div>
      }

      @if (impErr()) { <div class="err">{{ impErr() }}</div> }

      @if (!parsed() && pendFiles().length && !impBusy()) {
        <div class="sm-pend">
          @for (f of pendFiles(); track f.uid) {
            <span class="pend">
              <img class="thumb" [src]="f.dataUrl" [alt]="f.name" title="Кликните, чтобы открыть во весь экран" (click)="openGallery($index)" />
              <button class="pm" type="button" title="Убрать фото" (click)="removePend($index)">✕</button>
            </span>
          }
          <label class="add-more" title="Добавить ещё лист">
            ＋<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" (change)="addMoreFiles($event)" />
          </label>
          <button class="btn primary" [disabled]="impBusy()" (click)="parseFiles()">Распознать накладную</button>
          <span class="muted files-hint">{{ sheetsWord(pendFiles().length) }} одним документом</span>
        </div>
      }

      @if (logs.lines().length) {
        <div class="sm-logbar">
          <button type="button" class="sm-log-toggle" (click)="logOpen.set(!logOpen())">
            {{ logOpen() ? '▾' : '▸' }} ход распознавания ({{ logs.lines().length }})
          </button>
        </div>
        @if (logOpen()) {
          <div class="ai-log-body" #logBox>
            @for (l of logs.lines(); track $index) {
              <div [class]="'ai-line k-' + l.kind"><span class="t">{{ l.time }}</span>{{ l.text }}</div>
            }
          </div>
        }
      }

      @if (parsed(); as p) {
                @if (!impItems().length) {
          <div class="sm-empty">
            <span class="sm-empty-ico">🕵️</span>
            <b>Похоже, это не накладная</b>
            <p>{{ impWarns()[0] || 'ИИ не нашёл ни одной товарной строки — проверьте, что снят весь лист.' }}</p>
            <div class="sm-empty-actions">
              <button type="button" class="btn primary" (click)="resetSmart()">Снять другой документ</button>
              <button type="button" class="btn" [disabled]="impBusy()" (click)="reparseWithTranscript()">🔍 перечитать фото</button>
            </div>
            @if (p.fileName) { <span class="muted sm-empty-file">📎 {{ p.fileName }}</span> }
          </div>
        } @else {
<div class="sm-passport">
          <div class="sm-passport-top">
            <div class="sm-doc">
              <span class="sm-doc-ico">🧾</span>
              <div>
                <b>{{ impNumber || 'Накладная без номера' }}</b>
                <small>{{ impSupplier || 'поставщик не распознан' }}@if (impDate) { · {{ impDate }} }</small>
              </div>
            </div>
            <div class="sm-passport-tools">
              @if (curUrl()) {
                @if (isPdf(curUrl())) {
                  <span class="badge clickable" (click)="openPdf(curUrl())">📄 PDF</span>
                } @else {
                  <img class="thumb" [src]="curUrl()" alt="Фото накладной" title="Кликните, чтобы открыть во весь экран" (click)="openGallery(curLb() ?? 0)" />
                }
              }
              <span class="sm-ai" [title]="p.fileName">🤖 ИИ · {{ p.fileName }}@if (p.extraFiles?.length) { · {{ sheetsWord(p.extraFiles!.length) }} }</span>
              <button type="button" class="btn sm" [disabled]="impBusy()"
                      title="Перечитать фото и показать, что именно увидел ИИ — когда цифра в строке не сходится"
                      (click)="reparseWithTranscript()">🔍 сверить с фото</button>
              <label class="btn sm" title="Добавить ещё лист к этой накладной и перечитать документ">
                ＋ лист
                <input class="hidden-file" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" (change)="addPagesAndReparse($event)" />
              </label>
              <button type="button" class="btn sm" [disabled]="impBusy()" title="Убрать разбор и сфотографировать другой документ" (click)="resetSmart()">✕ другой</button>
            </div>
          </div>
          <div class="sm-fields">
            <label class="f">Номер<input [(ngModel)]="impNumber" /></label>
            <label class="f">Дата<input type="date" [(ngModel)]="impDate" /></label>
            <label class="f f-full">Поставщик<input [(ngModel)]="impSupplier" /></label>
            <div class="sm-docnums">
              <label class="f">нетто в документе<input class="mini" type="number" step="any" [(ngModel)]="impDocNet" aria-label="Нетто в документе" /></label>
              <label class="f">PDV в документе<input class="mini" type="number" step="any" [(ngModel)]="impDocVat" aria-label="PDV в документе" /></label>
              <label class="f">к оплате в документе<input class="mini" type="number" step="any" [(ngModel)]="impDocGross" aria-label="К оплате в документе" /></label>
            </div>
          </div>
          <div class="sm-check" [class.ok]="docHasTotals() && docSumsOk()" [class.bad]="docHasTotals() && !docSumsOk()" [class.na]="!docHasTotals()">
            <span class="sm-check-ico">{{ !docHasTotals() ? '—' : docSumsOk() ? '✓' : 'Δ' }}</span>
            <b class="sm-check-title">{{ !docHasTotals() ? 'Итоги в документе не напечатаны' : docSumsOk() ? 'Итоги сходятся с документом' : 'Итоги расходятся с документом' }}</b>
            <span class="sm-chip" [class.ok]="totOk(impTotal(), docNet())" title="Нетто: по строкам против напечатанного">нетто <b>{{ moneyOrDash(docNet()) }}</b>@if (!totOk(impTotal(), docNet())) { <i>≠ {{ fmtMoney(impTotal()) }}</i> }</span>
            <span class="sm-chip" [class.ok]="totOk(impVat(), docVat())" title="PDV: по ставкам против напечатанного">PDV <b>{{ moneyOrDash(docVat()) }}</b>@if (!totOk(impVat(), docVat())) { <i>≠ {{ fmtMoney(impVat()) }}</i> }</span>
            <span class="sm-chip" [class.ok]="totOk(impGross(), docGross())" title="К оплате против напечатанного">к оплате <b>{{ moneyOrDash(docGross()) }}</b>@if (!totOk(impGross(), docGross())) { <i>≠ {{ fmtMoney(impGross()) }}</i> }</span>
          </div>
        </div>

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
        @if (p.transcript; as tr) {
          <pre class="transcript">{{ tr }}</pre>
        }
        @if (impWarns().length) {
          <details class="sm-notes bad" open>
            <summary>⚠ Требует внимания · {{ impWarns().length }}</summary>
            <ul class="imp-msg-list">@for (w of impWarns(); track $index) { <li>{{ w }}</li> }</ul>
          </details>
        }
        @if (impFixes().length) {
          <details class="sm-notes ok">
            <summary>🧐 Что ИИ уточнил сам · {{ impFixes().length }}</summary>
            <ul class="imp-msg-list">@for (w of impFixes(); track $index) { <li>{{ w }}</li> }</ul>
          </details>
        }

        <div class="rc-bar">
          <div class="rc-bar-info">
            <b>Позиции из документа</b>
            <span class="sm-count">{{ impItems().length }}</span>
            <span class="muted">Правьте числа прямо в карточке — итоги и сверка пересчитываются сразу</span>
          </div>
          <div class="rc-filters" role="group" aria-label="Фильтр строк">
            <button type="button" [class.on]="impFilter() === 'all'" (click)="impFilter.set('all')">
              Все <span class="n">{{ impItems().length }}</span>
            </button>
            <button type="button" class="hot" [class.on]="impFilter() === 'todo'" (click)="impFilter.set('todo')">
              Внимание <span class="n">{{ impAttentionCount() }}</span>
            </button>
            <button type="button" [class.on]="impFilter() === 'ok'" (click)="impFilter.set('ok')">
              Готовы <span class="n">{{ impReadyCount() }}</span>
            </button>
          </div>
        </div>

        @for (row of visibleImpRows(); track row.idx) {
          @let it = row.it;
          @let stt = lineState(it);
          <article class="rc" [class.rc-fix]="stt.key === 'fix'" [class.rc-check]="stt.key === 'check'" [class.rc-new]="stt.key === 'new'" [class.rc-ready]="stt.key === 'ready'">
            <header class="rc-head">
              <span class="rc-idx">{{ row.idx + 1 }}</span>
              <div class="rc-title">
                <input class="rc-name" [(ngModel)]="it.rawName" title="Название товара, как напечатано в накладной — можно поправить, псевдоним запомнится по нему" aria-label="Название из документа" />
                <div class="rc-chips">
                  <span class="rc-state" [class]="'st-' + stt.key"><i></i>{{ stt.label }}</span>
                  @if (it.mode === 'match' && it.via) { <span class="rc-tag">{{ viaLabel(it.via) }}</span> }
                  @if (it.qtyForecast) {
                    <span class="rc-tag amber" title="ИИ решил, что позицию класть на склад содержимым (упаковки -> г/мл): количество и цена пересчитаны, сумма строки не изменилась">пересчёт по фасовке</span>
                  }
                  @if (it.discount; as dsc) {
                    <span class="rc-tag green" [title]="'Скидка по документу: ' + dsc.name + (dsc.reason ? ' · ' + dsc.reason : '')">🏷 скидка −{{ trim(c(dsc.amount)) }}{{ dsc.percent != null ? ' · ' + trim(dsc.percent) + '%' : '' }}</span>
                  }
                </div>
              </div>
              <div class="rc-money" title="Итог строки: нетто + PDV">
                <span class="rc-money-l">к оплате</span>
                <b>{{ trim(c((it.qty ?? 0) * (it.price ?? 0) * (1 + (it.vatRate ?? 0) / 100))) }} {{ cur() }}</b>
                <small>нетто {{ trim(c((it.qty ?? 0) * (it.price ?? 0))) }}@if (it.vatRate) { · PDV {{ trim(c((it.qty ?? 0) * (it.price ?? 0) * it.vatRate / 100)) }} } @else { · без PDV }</small>
              </div>
              <button class="rc-x" type="button" title="Убрать строку" (click)="removeImp(row.idx)">✕</button>
            </header>

            <div class="rc-body">
              <div class="rc-nums">
                <label class="rc-field">
                  <span class="rc-label">Количество <em>на склад</em></span>
                  <span class="rc-inline">
                    <input type="number" [(ngModel)]="it.qty" (ngModelChange)="recalcPrice(it)" title="Количество в базовых единицах (г/мл/шт)" aria-label="Количество" />
                    <select [(ngModel)]="it.unitId" (ngModelChange)="onDraftChange()" title="Базовая складская единица (г/мл/шт)" aria-label="Единица">
                      <option [ngValue]="null">—</option>
                      @for (u of units(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
                    </select>
                  </span>
                  <small class="rc-hint">{{ qtyHint(it) || 'Базовые единицы: г / мл / шт' }}</small>
                </label>

                <label class="rc-field">
                  <span class="rc-label">Цена <em>как в документе</em></span>
                  @if (it.docPricePrinted != null) {
                    <span class="rc-inline">
                      <input type="number" step="any" [(ngModel)]="it.docPricePrinted" (ngModelChange)="onDocPriceEdit(it)" [title]="priceTitle" aria-label="Цена как в документе" />
                      <span class="rc-cur">{{ cur() }}/{{ it.docUnitPrinted || unitCodeOf(it.unitId) || 'ед.' }}</span>
                    </span>
                    <small class="rc-hint">на склад {{ baseCostReadout(it) }}</small>
                  } @else {
                    <span class="rc-inline">
                      <input type="number" step="any" [(ngModel)]="it.price" (ngModelChange)="onPriceEdit(it)" [title]="priceTitle" placeholder="цена/баз." aria-label="Цена без PDV" />
                      <span class="rc-cur">{{ cur() }}/{{ unitCodeOf(it.unitId) || 'ед.' }}</span>
                    </span>
                    <small class="rc-hint">{{ priceHint(it) || 'В документе цена не напечатана — введите цену за базовую единицу' }}</small>
                  }
                </label>

                <label class="rc-field">
                  <span class="rc-label">Сумма без PDV <em>главная цифра</em></span>
                  <span class="rc-inline">
                    <input type="number" step="any" [(ngModel)]="it.lineSum" (ngModelChange)="onSumEdit(it)" aria-label="Сумма строки в документе" title="Сумма строки без PDV — деньги этой позиции. Правится вместе с ценой: меняете сумму — пересчитается цена, меняете цену — пересчитается сумма" />
                    <span class="rc-cur">{{ cur() }}</span>
                  </span>
                  <small class="rc-hint" [class.bad]="lineMismatch(it)">
                    @if (lineMismatch(it)) { не сходится с документом — сверьте с фото }
                    @else if (it.lineSumPrinted) { как напечатано{{ it.discount ? ', скидка уже вычтена' : '' }} }
                    @else { собрано из Кол × Цена }
                  </small>
                </label>

                <label class="rc-field">
                  <span class="rc-label">PDV <em>ставка из документа</em></span>
                  <span class="rc-inline">
                    <input type="number" min="0" max="100" step="0.5" [(ngModel)]="it.vatRate" (ngModelChange)="onVatChange(it)" placeholder="0" title="Ставка PDV из колонки «ПДВ», %; пусто или 0 — без НДС" aria-label="Ставка PDV" />
                    <span class="rc-cur">%</span>
                  </span>
                  <small class="rc-hint">
                    @if (it.vatSuspect) { ⚠ прочитан неуверенно — сверьте с фото }
                    @else if (it.vatInferred) { ⚠ выведен по итогам — проверьте ставку }
                    @else if (it.vatRate) { +{{ trim(c((it.qty ?? 0) * (it.price ?? 0) * it.vatRate / 100)) }} {{ cur() }} к нетто }
                    @else { без налога }
                  </small>
                </label>
              </div>

              <div class="rc-match">
                <div class="rc-match-top">
                  <span class="rc-label">Позиция склада</span>
                  <div class="rc-seg">
                    <button type="button" [class.on]="it.mode === 'match'" (click)="setMode(it, 'match')">существующая</button>
                    <button type="button" [class.on]="it.mode === 'create'" (click)="setMode(it, 'create')">создать новую</button>
                  </div>
                </div>
                @if (it.mode === 'match') {
                  @if (it.candidates.length) {
                    <div class="rc-sugg">
                      <span class="rc-sugg-l">Похожие:</span>
                      @for (cnd of it.candidates; track cnd.productId) {
                        <button type="button" class="rc-sugg-btn" [class.on]="it.productId === cnd.productId" [title]="'Привязать к «' + cnd.name + '»'" (click)="pickCandidate(it, cnd.productId)">
                          {{ cnd.name }}@if (simPct(cnd.sim)) { <small>{{ simPct(cnd.sim) }}</small> }
                        </button>
                      }
                    </div>
                  }
                  <div class="rc-pick">
                    <label class="rc-pick-field">
                      <span class="rc-pick-label">Категория</span>
                      <select [(ngModel)]="it.pickCat" (ngModelChange)="setPickCat(it, $event)" aria-label="Категория товара">
                        <option value="">все категории</option>
                        @for (c of productCategories(); track c.name) {
                          <option [value]="c.name">{{ c.name }}</option>
                        }
                      </select>
                    </label>
                    <label class="rc-pick-field">
                      <span class="rc-pick-label">Товар</span>
                      <select class="prod-sel" [(ngModel)]="it.productId" (ngModelChange)="onProductPicked(it, $event)" aria-label="Товар склада">
                        <option [ngValue]="null">— выбрать товар —</option>
                        @for (pr of pickProducts(it); track pr.id) {
                          <option [ngValue]="pr.id">{{ pr.name }}</option>
                        }
                      </select>
                    </label>
                  </div>
                  @if (it.productId) {
                    @if (willAlias(it)) {
                      <small class="rc-hint">🔖 «{{ it.rawName }}» запомнится как псевдоним — в следующий раз ИИ узнает товар сам</small>
                    } @else {
                      <small class="rc-hint">✓ Товар привязан — сумма уйдёт в себестоимость склада</small>
                    }
                  } @else {
                    <small class="rc-hint bad">Выберите товар{{ it.candidates.length ? ' или нажмите подсказку выше' : ' из списка' }} — либо создайте новую позицию</small>
                  }
                } @else {
                  <div class="create-box">
                    <input class="cb-name" [(ngModel)]="it.newName" (ngModelChange)="onDraftChange()" placeholder="Название на склад" aria-label="Название на склад" />
                    <div class="cb-cat-wrap">
                      <select class="cb-cat" [(ngModel)]="it.newCategory" (ngModelChange)="onDraftChange()" title="Категория из справочника (настраивается в Настройках: иконка и цвет)" aria-label="Категория">
                        <option value="прочее">— категория «прочее» —</option>
                        @for (c of categories(); track c.id) {
                          <option [value]="c.name">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
                        }
                        @if (it.newCategory && !catOf(it.newCategory)) {
                          <option [value]="it.newCategory">{{ it.newCategory }} — нет в справочнике</option>
                        }
                      </select>
                      @if (catOf(it.newCategory); as cat) {
                        <span class="cb-cat-badge" [style.background]="cat.color || '#eef2f7'"
                              [title]="'Категория: ' + cat.name + (cat.color ? ' · цвет ' + cat.color : '')">{{ cat.icon || '·' }}</span>
                      }
                    </div>
                    <select class="cb-unit" [(ngModel)]="it.newUnitId" (ngModelChange)="onDraftChange()" aria-label="Складская единица">
                      @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">хранить в {{ u.code }}</option> }
                    </select>
                  </div>
                  <small class="rc-hint">Новый товар появится в номенклатуре и сразу ляжет на склад. Категорию и единицу можно поправить позже.</small>
                }
              </div>
            </div>

            @if (it.warnings.length || it.doubt) {
              <div class="rc-notes" aria-label="Замечания по строке">
                @if (it.doubt) { <div class="rc-note">🤖 {{ it.doubt }}</div> }
                @for (w of it.warnings; track $index) { <div class="rc-note">⚠ {{ w }}</div> }
              </div>
            }

            <footer class="rc-foot">
              <span class="rc-why" [class]="'why-' + stt.key">{{ stt.hint }}</span>
              <button class="rc-reset" type="button" [disabled]="!lineChanged(it)" (click)="resetLine(it)" title="Вернуть количество, цену, PDV и привязку к товару в состояние после распознавания">↺ вернуть как было</button>
            </footer>
          </article>
        } @empty {
          <div class="rc-empty-filter">
            @if (impFilter() === 'todo') { Все строки заполнены — проверить нечего. }
            @else if (impFilter() === 'ok') { Пока нет готовых строк — начните с «Внимание». }
            @else { В документе не осталось строк. }
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
          <div class="sm-result-sum" title="Что уйдёт на склад: нетто + PDV">
            <span class="muted">на склад</span>
            <b>{{ fmtMoney(impTotal()) }}</b>
            @if (impVat() > 0) {
              <span class="muted">+ PDV</span><b class="vat-note">{{ fmtMoney(impVat()) }}</b>
              <span class="muted">=</span><b>{{ fmtMoney(impGross()) }}</b>
            }
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
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  /** effect() в ngOnInit вне инжект-контекста — передаём инжектор явно */
  private injector = inject(Injector);
  /** Живой лог сервера (WebSocket): этапы распознавания. */
  logs = inject(LogService);
  logOpen = signal(true);
  lastLog = computed(() => {
    const arr = this.logs.lines();
    return arr.length ? arr[arr.length - 1].text : '';
  });
  private logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');

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
  /** ?panel= из быстрых действий: прокрутить к панели после загрузки журнала */
  anchor = signal<string | null>(null);
  detail = signal<Waybill | null>(null);
  products = signal<Product[]>([]);
  units = signal<Unit[]>([]);
  /** Справочник категорий номенклатуры — селект категории при создании новой позиции из разбора. */
  categories = signal<CategoryOption[]>([]);
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
  /** Значок валюты из настроек (по умолчанию «дин.»): ₽ в суммах быть не должно. */
  cur = currencySymbol;
  /** Момент приёмки/отмены — общий форматтер даты-времени. */
  fmtWhen = fmtDateTime;
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
    this.destroyRef.onDestroy(() => clearTimeout(this.autoTimer));
    // живой канал логов держим открытым заранее — первые события разбора не потеряются
    this.logs.connect();
    this.api.products$().subscribe((p) => this.products.set(p));
    this.api.units$().subscribe((u) => this.units.set(u));
    this.api.categoriesDictionary$().subscribe((c) => this.categories.set(c));
    // быстрые действия панели приходят как ?panel=new|smart|journal — прокручиваем к нужной панели
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        const v = typeof p['panel'] === 'string' ? p['panel'] : '';
        this.anchor.set(['new', 'smart', 'journal'].includes(v) ? v : null);
      });
    effect(
      () => {
        this.logs.lines();
        const box = this.logBox()?.nativeElement;
        if (box) queueMicrotask(() => (box.scrollTop = box.scrollHeight));
      },
      { injector: this.injector }
    );
    effect(
      () => {
        const id = this.anchor();
        if (id) {
          untracked(() => {
            this.anchor.set(null);
            // панель может отрисоваться в этом же тике — прокручиваем после рендера
            queueMicrotask(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
          });
        }
      },
      { injector: this.injector }
    );
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

  /** Этапы конвейера — показываются на экране, пока идёт распознавание. */
  readonly smartSteps = [
    { n: 1, title: 'Распознавание', hint: 'фото → строки документа' },
    { n: 2, title: 'Каталог', hint: 'товары, фасовки, категории' },
    { n: 3, title: 'Сверка', hint: 'суммы, PDV и итоги' },
    { n: 4, title: 'Контроль', hint: 'проверка спорных строк' },
  ];
  /** Активный этап по последним событиям сервера (1…4). */
  impAct = computed(() => {
    const tail = this.logs.lines().slice(-8).map((l) => l.text).join(' ');
    if (/Агент «Контроль»/.test(tail)) return 4;
    if (/Сверка|Счетовод/.test(tail)) return 3;
    if (/Каталог|Товаровед/.test(tail)) return 2;
    return 1;
  });
  parsed = signal<ImportParseResult | null>(null);
  impItems = signal<ImpDraft[]>([]);
  impBusy = signal(false);
  impSaving = signal(false);
  impErr = signal('');
  impNumber = '';
  impSupplier = '';
  impDate = today();
  /** Напечатанные итоги документа: взяты из накладной, значит тоже правятся руками — ИИ мог ошибиться в цифре. */
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

  /** Убрать разбор и сфотографировать другой документ. */
  resetSmart(): void {
    if (this.impBusy()) return;
    this.parsed.set(null);
    this.impFilter.set('all');
    this.impItems.set([]);
    this.pendFiles.set([]);
    this.extrasPreview.set([]);
    this.impErr.set('');
    this.impFileName.set('');
    this.impNumber = '';
    this.impSupplier = '';
    this.impDate = today();
    this.impDocNet = null;
    this.impDocVat = null;
    this.impDocGross = null;
    this.lastPackage = [];
    this.curLb.set(null);
    this.discNotes.set([]);
    this.logs.clear();
  }

  /** Подсказка под загрузкой: что подходит и что происходит сейчас. */
  busyHint(): string {
    if (this.impBusy()) return 'ИИ распознаёт документ — обычно 20–90 секунд, пакет листов дольше, не закрывайте страницу';
    const n = this.pendFiles().length;
    if (!this.parsed() && n) return `${this.sheetsWord(n)} в пакете — можно добавить ещё или распознавать`;
    return this.impFileName() || 'JPG / PNG / WEBP / GIF / PDF до 15 МБ · несколько листов склеиваются в одну накладную';
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
  /** Блок скидок из разбора (ИИ выделяет их отдельной росписью). */
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
  /** Есть ли скидки с прочитанной суммой — показывать строку «Скидок всего» (уже учтённые тоже считаем). */
  hasDiscWithAmount = computed(
    () =>
      this.discountsSeparate().some((d) => d.amount != null) ||
      this.discountsIncluded().some((d) => Math.abs(d.amount ?? 0) > 0)
  );
  /** Кнопка «вычесть скидки из строк» нужна только для ещё не учтённых скидок. */
  canApplyDisc = computed(() => this.discountsSeparate().some((d) => (d.amount ?? 0) > 0));
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
    if (doc == null) return false;
    // скидка из отдельной строки POPUST уже вычтена из lineSum — сверяем с «печать минус скидка»
    const expected = it.discount ? doc - it.discount.amount : doc;
    return Math.abs(it.lineSum - expected) > Math.max(1, it.lineSum * 0.01);
  }

  /** Мой расчёт сходится с напечатанным в документе (±2%, но не меньше 1 din)? */
  /** Сверка с напечатанным итогом: допуск только на округление, не проценты — иначе сотня рублей «сходится». */
  totOk(mine: number, printed: number | null): boolean {
    if (printed == null) return true;
    return Math.abs(mine - printed) <= Math.max(2, printed * 0.0005);
  }

  /** Все три напечатанных итога сходятся с тем, что посчитано по строкам. */
  docSumsOk(): boolean {
    return (
      this.totOk(this.impTotal(), this.docNet()) &&
      this.totOk(this.impVat(), this.docVat()) &&
      this.totOk(this.impGross(), this.docGross())
    );
  }

  /** В документе вообще напечатаны итоги — иначе «сходится» показывать нечего. */
  docHasTotals(): boolean {
    return this.docNet() != null || this.docVat() != null || this.docGross() != null;
  }

  moneyOrDash(v: number | null): string {
    return v == null ? '—' : this.fmtMoney(v);
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
      else this.scheduleAutoParse();
    });
  }

  /** Один тап: файл выбран — через секунду уже идёт распознавание (успейте добавить ещё лист). */
  private autoTimer?: ReturnType<typeof setTimeout>;
  private scheduleAutoParse(): void {
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      this.autoTimer = undefined;
      if (!this.impBusy() && !this.parsed() && this.pendFiles().length) this.parseFiles();
    }, 1200);
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
      this.scheduleAutoParse();
    });
  }

  removePend(i: number): void {
    clearTimeout(this.autoTimer);
    this.pendFiles.update((arr) => arr.filter((_, idx) => idx !== i));
    if (this.pendFiles().length) this.scheduleAutoParse();
  }

  /** «＋ лист» в уже разобранном документе: добавить страницу и перечитать всё заново. */
  addPagesAndReparse(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length || this.impBusy()) return;
    this.impErr.set('');
    void this.readFiles(files).then((add) => {
      if (!add.length) return;
      this.pendFiles.update((arr) => [...arr, ...add].slice(0, 8));
      this.parseFiles();
    });
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

  /** Собрать из выбранных фото ОДну накладную: один вызов ИИ на весь пакет. */
  parseFiles(): void {
    clearTimeout(this.autoTimer);
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
    const jobId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.logOpen.set(false);
    this.logs.watch(jobId);
    const payload = {
      jobId,
      files: list.map((f) => ({ fileName: f.name, mime: f.mime, base64: f.dataUrl.split(',')[1] ?? '' })),
      ...(debug ? { debug: true } : {}),
    };
    const request$ = this.api.importParseCli$(payload);
    request$.subscribe({
        next: (r) => {
          this.impBusy.set(false);
          this.parsed.set(r);
          this.discNotes.set([]); // разбор новый — заметки про учёт скидок из прежнего больше не актуальны
          this.extrasPreview.set(list.slice(1).map((f) => f.dataUrl));
          // lightbox не открываем (curLb остаётся null) — сразу виден распознанный список, фото доступно по клику на миниатюру
          this.impNumber = r.doc.number ?? '';
          this.impSupplier = r.doc.supplier ?? '';
          this.impDate = r.doc.date ?? today();
          this.impDocNet = r.doc.totalSum ?? null;
          this.impDocVat = r.doc.totalVat ?? null;
          this.impDocGross = r.doc.totalGross ?? null;
          this.impFilter.set('all'); // новый документ — показываем все строки, а не фильтр прошлого
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
    const pickedId = it.match?.productId ?? it.candidates[0]?.productId ?? null;
    const pickedCategory = pickedId != null ? this.products().find((p) => p.id === pickedId)?.category ?? '' : '';
    const draft: ImpDraft = {
      rawName: it.rawName,
      qty: it.qty,
      unitId,
      docUnitPrinted: it.docUnitPrinted ?? null,
      docQtyPrinted: it.docQtyPrinted ?? null,
      docPricePrinted: it.docPricePrinted ?? null,
      qtyForecast: !!it.qtyForecast,
      doubt: doubt || null,
      warnings: it.warnings ?? [],
      price: it.price,
      vatRate: it.vatRate,
      vatSuspect: !!it.vatSuspect,
      vatInferred: !!it.vatInferred,
      lineSum,
      lineSumPrinted: printed,
      discount: it.rowDiscount ?? null,
      edited: false,
      mode: it.match ? 'match' : 'create',
      productId: pickedId,
      pickCat: pickedCategory,
      via: it.match?.via ?? null,
      candidates: it.candidates,
      newName: it.newHint?.name ?? it.rawName,
      newCategory: it.newHint?.category ?? 'прочее',
      newUnitId: unitId ?? this.baseUnits()[0]?.id ?? null,
      orig: null as unknown as ImpOrig,
    };
    draft.orig = {
      qty: draft.qty,
      unitId: draft.unitId,
      docPricePrinted: draft.docPricePrinted,
      price: draft.price,
      vatRate: draft.vatRate,
      vatSuspect: draft.vatSuspect,
      vatInferred: draft.vatInferred,
      lineSum: draft.lineSum,
      edited: draft.edited,
      mode: draft.mode,
      productId: draft.productId,
      pickCat: draft.pickCat,
      newName: draft.newName,
      newCategory: draft.newCategory,
      newUnitId: draft.newUnitId,
    };
    return draft;
  }

  unitCodeOf(unitId: number | null): string {
    return this.units().find((u) => u.id === unitId)?.code ?? '';
  }

  /** Категория справочника по имени (регистр/пробелы не важны); null — такой категории ещё нет. */
  catOf(name: string | null | undefined): CategoryOption | null {
    const n = (name ?? '').trim().toLowerCase();
    return n ? this.categories().find((c) => c.name.trim().toLowerCase() === n) ?? null : null;
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

  /** Подсказка под ценой: цена за базовую единицу показывается за удобную (дин./кг, дин./л). */
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

  /** Себестоимость за базовую единицу склада (дин./г, дин./мл, дин./шт) — то, что реально приходуется. */
  baseCostReadout(it: ImpDraft): string {
    if (it.price == null) return '—';
    const code = this.unitCodeOf(it.unitId);
    return `${trim(it.price)} ${currencySymbol()}/${code || 'ед.'}`;
  }

  /** Правка денег строки (и количества): цена за базовую = деньги ÷ количество, сумма не «уплывает». */
  recalcPrice(it: ImpDraft): void {
    const money = this.money(it);
    const q = it.qty ?? 0;
    if (money != null && q > 0) it.price = Math.round((money / q) * 1e10) / 1e10;
    this.touchItems();
  }

  /** Сигнал impItems не знает о правках полей на месте — будим его, чтобы итоги и сверка пересчитались сразу. */
  private touchItems(): void {
    this.impItems.update((arr) => arr.slice());
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
    this.touchItems();
  }

  /**
   * Правка цены как в накладной: деньги строки собираются из печатных Кол × Цена документа,
   * базовая себестоимость — следом из денег и базового количества. Так поле = цифре с бумаги.
   */
  onDocPriceEdit(it: ImpDraft): void {
    it.edited = true;
    const disc = it.discount?.amount ?? 0;
    if (it.docPricePrinted != null && it.docQtyPrinted != null && it.docQtyPrinted > 0) {
      it.lineSum = Math.max(0, Math.round((it.docQtyPrinted * it.docPricePrinted - disc) * 100) / 100);
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
    this.touchItems();
  }

  private unitIdByCode(code: string | null): number | null {
    if (!code) return null;
    return this.units().find((u) => u.code === code)?.id ?? null;
  }

  viaLabel(via: string): string {
    return via === 'alias' ? '🔖 найдено по псевдониму' : via === 'name' ? 'найдено по названию' : via === 'llm' ? 'подобрано по смыслу' : '';
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

  // ==================== карточки строк: статусы, фильтр, быстрые действия ====================

  /** Фильтр списка: всё / только проблемные / только готовые. */
  impFilter = signal<'all' | 'todo' | 'ok'>('all');

  /** Чего не хватает для проведения строки — короткими словами, для статуса и подсказки. */
  lineMissing(it: ImpDraft): string[] {
    const out: string[] = [];
    if ((it.qty ?? 0) <= 0) out.push('количество');
    if (it.unitId == null) out.push('единица склада');
    if (it.mode === 'match') {
      if (it.productId == null) out.push('товар склада');
    } else if (!it.newName.trim() || it.newUnitId == null) {
      out.push('название и единица нового товара');
    }
    return out;
  }

  /** Почему строку стоит проверить по фото — даже если она формально заполнена. */
  lineFlags(it: ImpDraft): string[] {
    const f: string[] = [];
    if (it.vatSuspect) f.push('PDV прочитан неуверенно');
    if (it.vatInferred) f.push('PDV выведен по итогам документа');
    if (it.qtyForecast) f.push('количество пересчитано по фасовке');
    if (this.lineMismatch(it)) f.push('сумма строки не сходится с Кол × Цена');
    if (it.doubt) f.push('у ИИ есть вопрос по строке');
    return f;
  }

  /** Итоговый статус строки: дополнить → проверить → новая → готово. */
  lineState(it: ImpDraft): { key: ImpLineState; label: string; hint: string } {
    const missing = this.lineMissing(it);
    if (missing.length) {
      return { key: 'fix', label: 'нужно дополнить', hint: `Дополните: ${missing.join(', ')}` };
    }
    const flags = this.lineFlags(it);
    if (flags.length) {
      return { key: 'check', label: 'проверить', hint: `Сверьте с фото: ${flags.join(' · ')}` };
    }
    if (it.mode === 'create') {
      const unit = this.unitCodeOf(it.newUnitId) || 'ед.';
      return {
        key: 'new',
        label: 'новая позиция',
        hint: `Создастся товар «${it.newName}»${it.newCategory ? ' · ' + it.newCategory : ''} · хранить в ${unit}`,
      };
    }
    const product = this.products().find((p) => p.id === it.productId);
    return {
      key: 'ready',
      label: 'готово',
      hint: `На склад: «${product?.name ?? '—'}» · ${fmtQty(it.qty ?? 0, this.unitCodeOf(it.unitId))} · ${this.baseCostReadout(it)}`,
    };
  }

  /** Строка требует действия или проверки — именно её показывает фильтр «Внимание». */
  lineAttention(it: ImpDraft): boolean {
    const key = this.lineState(it).key;
    return key === 'fix' || key === 'check';
  }

  impAttentionCount = computed(() => this.impItems().filter((i) => this.lineAttention(i)).length);
  impReadyCount = computed(() => this.impItems().length - this.impAttentionCount());

  /** Видимые строки с исходным индексом — удаление и нумерация остаются верными при фильтре. */
  visibleImpRows = computed(() => {
    const f = this.impFilter();
    return this.impItems()
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => f === 'all' || (f === 'todo' ? this.lineAttention(it) : !this.lineAttention(it)));
  });

  /** Переключатель «существующая / создать новую»: будим сигнал, чтобы статус и фильтр пересчитались. */
  setMode(it: ImpDraft, mode: 'match' | 'create'): void {
    it.mode = mode;
    this.touchItems();
  }

  /** Один клик по подсказке «похожие» — сразу привязывает товар и запоминает псевдоним при подтверждении. */
  pickCandidate(it: ImpDraft, productId: number): void {
    it.mode = 'match';
    it.productId = productId;
    const p = this.products().find((x) => x.id === productId);
    if (p) it.pickCat = p.category;
    this.touchItems();
  }

  /** Категории товаров склада с количеством позиций — отдельное поле в карточке. */
  productCategories = computed(() => {
    const map = new Map<string, number>();
    for (const p of this.products()) map.set(p.category, (map.get(p.category) ?? 0) + 1);
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  /** Товары выбранной категории; уже выбранный товар не теряется при смене фильтра. */
  pickProducts(it: ImpDraft): Product[] {
    const all = this.products();
    const selected = it.productId != null ? all.find((p) => p.id === it.productId) ?? null : null;
    const list = it.pickCat ? all.filter((p) => p.category === it.pickCat) : all;
    return selected && !list.some((p) => p.id === selected.id) ? [selected, ...list] : list;
  }

  /** Категория фильтрует список товаров; выбранный товар из другой категории снимается. */
  setPickCat(it: ImpDraft, category: string): void {
    it.pickCat = category;
    if (category) {
      const current = this.products().find((p) => p.id === it.productId);
      if (current && current.category !== category) it.productId = null;
    }
    this.touchItems();
  }

  /** Выбор товара: категория подтягивается за товаром, чтобы поля не расходились. */
  onProductPicked(it: ImpDraft, productId: number | null): void {
    it.productId = productId;
    if (productId != null) {
      const p = this.products().find((x) => x.id === productId);
      if (p) it.pickCat = p.category;
    }
    this.touchItems();
  }

  /** Любая правка полей карточки: статус, счётчики и фильтр должны обновиться сразу. */
  onDraftChange(): void {
    this.touchItems();
  }

  /** Строку правили после разбора? Тогда «вернуть как было» активна. */
  lineChanged(it: ImpDraft): boolean {
    const o = it.orig;
    return (
      it.qty !== o.qty ||
      it.unitId !== o.unitId ||
      it.docPricePrinted !== o.docPricePrinted ||
      it.price !== o.price ||
      it.vatRate !== o.vatRate ||
      it.vatSuspect !== o.vatSuspect ||
      it.vatInferred !== o.vatInferred ||
      it.lineSum !== o.lineSum ||
      it.edited !== o.edited ||
      it.mode !== o.mode ||
      it.productId !== o.productId ||
      it.pickCat !== o.pickCat ||
      it.newName !== o.newName ||
      it.newCategory !== o.newCategory ||
      it.newUnitId !== o.newUnitId
    );
  }

  /** Вернуть строку ровно в то состояние, которое дал разбор (до ручных правок). */
  resetLine(it: ImpDraft): void {
    const o = it.orig;
    Object.assign(it, {
      qty: o.qty,
      unitId: o.unitId,
      docPricePrinted: o.docPricePrinted,
      price: o.price,
      vatRate: o.vatRate,
      vatSuspect: o.vatSuspect,
      vatInferred: o.vatInferred,
      lineSum: o.lineSum,
      edited: o.edited,
      mode: o.mode,
      productId: o.productId,
      pickCat: o.pickCat,
      newName: o.newName,
      newCategory: o.newCategory,
      newUnitId: o.newUnitId,
    });
    this.touchItems();
  }

  /** Похожесть подсказки (pg_trgm 0…1) — в процентах, только если сервер её дал. */
  simPct(sim: number | undefined): string {
    return sim && sim > 0 ? `${Math.round(sim * 100)}%` : '';
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
        this.logs.clear();
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
