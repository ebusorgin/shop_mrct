/**
 * PDF-версия отчёта-отгрузки (Otpremnica) для скачивания.
 * Вёрстка повторяет печатную (браузерную) версию бланка: те же поля,
 * подчёркнутые значения реквизитов, таблица с теми же пропорциями колонок,
 * итоговый блок 104 мм и подписи у нижнего края. Шрифт Roboto из assets/fonts —
 * в нём есть сербская латиница (č/ć/š/ž/đ), которой нет в стандартных шрифтах PDF.
 */
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import type { ReportDoc, ReportLine } from './order-report';

const MM = 2.834645669; // типографский пункт на миллиметр
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 10 * MM;

/** Сначала dist/assets (прод), затем assets в корне сервера (tsx-разработка). */
function fontFile(name: string): string {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'fonts', name),
    path.join(__dirname, '..', '..', 'assets', 'fonts', name),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`PDF: не найден шрифт ${name}`);
  return found;
}

let fonts: { regular: string; bold: string } | null = null;
function fontPaths(): { regular: string; bold: string } {
  if (!fonts) {
    fonts = {
      regular: fontFile('Roboto-Regular.ttf'),
      bold: fontFile('Roboto-Bold.ttf'),
    };
  }
  return fonts;
}

/** Сербское число: точка — тысячи, запятая — дробная часть (45.505,00). */
function grouped(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const head = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}${head}${decimals ? ',' + frac : ''}`;
}

function money(value: number): string {
  return grouped(value, 2);
}

function rateLabel(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : String(rate).replace('.', ',');
}

function dateLabel(iso: string): string {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : iso;
}

function unitLabel(line: ReportLine): string {
  return line.unit === 'porcija' ? 'porc.' : line.unit;
}

/** Пропорции колонок как в печатной таблице (6 / 26 / 7 / 12 / 12 / 10 / 13 / 14 %). */
const COL_PCT = [0.06, 0.26, 0.07, 0.12, 0.12, 0.1, 0.13, 0.14];
const COL_TITLE: string[][] = [
  ['№'],
  ['Naziv'],
  ['JM'],
  ['Količina'],
  ['Cena'],
  ['Stopa', 'PDV-a, %'],
  ['Iznos', 'PDV-a'],
  ['Ukupna cena', 'sa PDV-om'],
];
const COL_ALIGN: ('left' | 'center' | 'right')[] = ['left', 'left', 'center', 'right', 'right', 'right', 'right', 'right'];
const CONTENT_W = PAGE.width - MARGIN * 2;
const COLS = COL_PCT.map((pct, i) => ({
  w: pct * CONTENT_W,
  title: COL_TITLE[i],
  align: COL_ALIGN[i],
}));

interface PartyRow {
  label: string;
  value: string;
  strong?: boolean;
}

/**
 * Подчёркнутое поле как в HTML: слева подпись (31 мм), справа значение
 * с линией под ним; между строками 1,6 мм.
 */
function drawParty(doc: PDFKit.PDFDocument, x: number, y: number, width: number, rows: PartyRow[]): number {
  const labelW = 31 * MM;
  const valueW = width - labelW - 1.8 * MM;
  let yy = y;
  for (const row of rows) {
    doc.font('regular').fontSize(7.5).fillColor('#222222');
    doc.text(row.label, x, yy, { width: labelW, align: 'left', lineBreak: false });
    doc.font(row.strong ? 'bold' : 'regular').fillColor('#111111');
    const textW = valueW;
    const h = doc.heightOfString(row.value || ' ', { width: textW });
    doc.text(row.value, x + labelW + 1.8 * MM, yy, { width: textW });
    doc.lineWidth(0.5).strokeColor('#555555');
    doc.moveTo(x + labelW + 1.8 * MM, yy + h + 0.8).lineTo(x + labelW + 1.8 * MM + textW, yy + h + 0.8).stroke();
    yy += Math.max(4.6, h + 1.6 * MM);
  }
  return yy;
}

/** Шапка таблицы: белый фон, обычное начертание, рамки #555 — как на экране. */
function drawTableHead(doc: PDFKit.PDFDocument, y: number): number {
  const height = 27;
  doc.lineWidth(0.6).strokeColor('#555555');
  let x = MARGIN;
  doc.font('regular').fontSize(7.5).fillColor('#111111');
  for (const col of COLS) {
    const lines = col.title;
    const lineH = 8.6;
    const startY = y + (height - lines.length * lineH) / 2 + 0.5;
    lines.forEach((t, i) => {
      doc.text(t, x + 2, startY + i * lineH, { width: col.w - 4, align: 'center', lineBreak: false });
    });
    doc.moveTo(x, y).lineTo(x, y + height).stroke();
    x += col.w;
  }
  doc.moveTo(x, y).lineTo(x, y + height).stroke();
  doc.moveTo(MARGIN, y).lineTo(MARGIN + COLS.reduce((s, c) => s + c.w, 0), y).stroke();
  doc.moveTo(MARGIN, y + height).lineTo(MARGIN + COLS.reduce((s, c) => s + c.w, 0), y + height).stroke();
  return y + height;
}

function rowHeight(doc: PDFKit.PDFDocument, line: ReportLine): number {
  doc.font('regular').fontSize(7.5);
  const nameH = doc.heightOfString(line.name, { width: COLS[1].w - 8 });
  return Math.max(14, nameH + 5.6);
}

/** Строка таблицы; возвращает новую высоту курсора. */
function drawLine(doc: PDFKit.PDFDocument, line: ReportLine, index: number, y: number): number {
  const h = rowHeight(doc, line);
  const cells = [
    String(index + 1),
    line.name,
    unitLabel(line),
    grouped(line.qty, 3),
    money(line.price),
    rateLabel(line.vatRate),
    money(line.vat),
    money(line.gross),
  ];
  doc.lineWidth(0.4).strokeColor('#555555');
  let x = MARGIN;
  COLS.forEach((col, i) => {
    doc.font('regular').fontSize(7.5).fillColor('#111111');
    const padTop = (h - doc.heightOfString(cells[i], { width: col.w - 4 })) / 2;
    doc.text(cells[i], x + 2, y + Math.max(2.8, padTop), {
      width: col.w - 4,
      align: col.align,
      lineBreak: i === 1,
    });
    doc.moveTo(x, y).lineTo(x, y + h).stroke();
    x += col.w;
  });
  doc.moveTo(x, y).lineTo(x, y + h).stroke();
  doc.moveTo(MARGIN, y + h).lineTo(MARGIN + COLS.reduce((s, c) => s + c.w, 0), y + h).stroke();
  return y + h;
}

/** Итоги: блок 104 мм у правого края, как в печатной версии. */
function drawTotals(doc: PDFKit.PDFDocument, d: ReportDoc, y: number): number {
  const width = 104 * MM;
  const x = PAGE.width - MARGIN - width;
  const rows: [string, string, boolean][] = [
    ['Iznos bez PDV-a:', money(d.net), false],
    [`Iznos PDV-a (${rateLabel(d.vatRate)} %):`, money(d.vat), false],
    ['Ukupno sa PDV:', money(d.gross), true],
  ];
  const rh = 15.5;
  if (y + rows.length * rh > PAGE.height - MARGIN - 30) {
    doc.addPage();
    y = MARGIN;
  }
  doc.lineWidth(0.6).strokeColor('#555555');
  let yy = y;
  for (const [label, value, strong] of rows) {
    doc.font(strong ? 'bold' : 'regular').fontSize(7.5).fillColor('#111111');
    doc.text(label, x + 4, yy + 4.4, { width: 72 * MM - 4 });
    doc.text(value, x + 72 * MM, yy + 4.4, { width: width - 72 * MM - 4, align: 'right' });
    doc.rect(x, yy, width, rh).stroke();
    yy += rh;
  }
  return yy;
}

function renderDocument(doc: PDFKit.PDFDocument, d: ReportDoc): void {
  doc.fillColor('#111111');
  let y = MARGIN;

  // Верхние поля с подчёркнутыми значениями: номер документа и дата.
  const lineLabelW = 34 * MM;
  const lineValueW = 70 * MM;
  for (const [label, value] of [
    ['Broj dokumenta:', d.number],
    ['Datum:', dateLabel(d.deliveryDate)],
  ] as [string, string][]) {
    doc.font('regular').fontSize(7.5).fillColor('#111111');
    doc.text(label, MARGIN, y, { width: lineLabelW, lineBreak: false });
    doc.text(value, MARGIN + lineLabelW, y, { width: lineValueW });
    doc.lineWidth(0.5).strokeColor('#444444');
    doc.moveTo(MARGIN + lineLabelW, y + 10).lineTo(MARGIN + lineLabelW + lineValueW, y + 10).stroke();
    y += 2.5 * MM + 10;
  }
  y += 5 * MM;

  // Реквизиты сторон в две колонки с зазором 8 мм.
  const colW = (PAGE.width - MARGIN * 2 - 8 * MM) / 2;
  const leftEnd = drawParty(doc, MARGIN, y, colW, [
    { label: 'Dobavljač', value: d.supplier.name, strong: true },
    { label: 'Adresa:', value: d.supplier.address },
    { label: 'PIB:', value: d.supplier.pib },
    { label: 'MBR:', value: d.supplier.mbr },
    { label: 'Tekući račun:', value: d.supplier.account },
  ]);
  const rightEnd = drawParty(doc, MARGIN + colW + 8 * MM, y, colW, [
    { label: 'Primalac', value: d.buyer.name, strong: true },
    { label: 'Adresa:', value: d.buyer.address },
    { label: 'PIB:', value: d.buyer.pib },
    { label: 'MBR:', value: d.buyer.mbr },
    { label: 'Tekući račun:', value: d.buyer.account },
  ]);
  y = Math.max(leftEnd, rightEnd) + 5 * MM;

  doc.font('bold').fontSize(16.5).fillColor('#111111');
  doc.text('Otpremnica', MARGIN, y, { width: PAGE.width - MARGIN * 2, align: 'center' });
  y += 4 * MM + 12;

  y = drawTableHead(doc, y);
  const bottomLimit = PAGE.height - MARGIN - 40;
  d.lines.forEach((line, index) => {
    if (y + rowHeight(doc, line) > bottomLimit) {
      doc.addPage();
      y = drawTableHead(doc, MARGIN);
    }
    y = drawLine(doc, line, index, y);
  });

  y = drawTotals(doc, d, y + 3 * MM);

  // Подписи у нижнего края страницы.
  const signY = PAGE.height - MARGIN - 26;
  const lineW = 52 * MM;
  doc.lineWidth(0.6).strokeColor('#333333');
  doc.moveTo(MARGIN, signY).lineTo(MARGIN + lineW, signY).stroke();
  doc.moveTo(PAGE.width - MARGIN - lineW, signY).lineTo(PAGE.width - MARGIN, signY).stroke();
  doc.font('regular').fontSize(7.5).fillColor('#333333');
  doc.text('Dobavljač:', MARGIN, signY + 3, { width: lineW });
  doc.text('Primalac:', PAGE.width - MARGIN - lineW, signY + 3, { width: lineW, align: 'right' });
}

/** Готовый PDF-документ (поток) для скачивания или вложения в zip. */
export function createReportPdf(d: ReportDoc): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN },
    bufferPages: true,
    info: { Title: `Otpremnica ${d.number}`, Author: d.supplier.name },
  });
  const f = fontPaths();
  doc.registerFont('regular', f.regular);
  doc.registerFont('bold', f.bold);
  renderDocument(doc, d);
  return doc;
}
