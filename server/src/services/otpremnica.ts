import { pool } from '../db';
import { productionSettings, ProductionDetails } from './settings';

export { ProductionDetails };

export async function generateOtpremniceDoc(date: string, storeId?: number): Promise<Buffer> {
  const prod = await productionSettings();

  let { rows: stores } = await pool.query(
    `select st.id, st.code, st.name, st.address, st.pib, st.mbr, st.account_no as "accountNo"
       from stores st
       join orders o on o.store_id = st.id
      where o.date_tab = $1::date and o.status != 'cancelled'
      group by st.id, st.code, st.name, st.address, st.pib, st.mbr, st.account_no, st.position
      order by st.position, st.id`,
    [date]
  );

  const sections: string[] = [];

  // Если указан storeId, оставляем только нужный магазин
if (storeId !== undefined && storeId !== null) {
  const filtered = stores.filter((s:any) => s.id === storeId);
  stores = filtered;
}
for (let i = 0; i < stores.length; i++) {
    const st = stores[i];
    const { rows: items } = await pool.query(
      `select o.id, coalesce(tc.name, o.source_name) as name,
              o.quantity::float8 as qty, o.unit_code as "unitCode",
              u.code as "cardUnit", o.vk_price::float8 as vk
         from orders o
         left join tech_cards tc on tc.id = o.card_id
         left join units u on u.id = tc.portion_unit_id
        where o.store_id = $1 and o.date_tab = $2::date and o.status != 'cancelled'
        order by coalesce(tc.name, o.source_name)`,
      [st.id, date]
    );

    let totalNet = 0;
    let totalVat = 0;
    let totalGross = 0;
    const pdvRate = 20;

    const rowsHtml = items.map((it, idx) => {
      const qty = Number(it.qty) || 0;
      const unit = it.cardUnit || it.unitCode || 'шт';
      const vk = Number(it.vk) || 0;
      const lineGross = qty * vk;
      const lineNet = lineGross / (1 + pdvRate / 100);
      const lineVat = lineGross - lineNet;

      totalNet += lineNet;
      totalVat += lineVat;
      totalGross += lineGross;

      return `<tr>
        <td style="text-align:center;">${idx + 1}</td>
        <td>${escapeHtml(it.name)}</td>
        <td style="text-align:center;">${escapeHtml(unit)}</td>
        <td style="text-align:right;">${qty.toFixed(3)}</td>
        <td style="text-align:right;">${vk.toFixed(2)}</td>
        <td style="text-align:center;">${pdvRate}%</td>
        <td style="text-align:right;">${lineVat.toFixed(2)}</td>
        <td style="text-align:right;">${lineGross.toFixed(2)}</td>
      </tr>`;
    }).join('\n');

    const docNo = `OTP-${st.id}-${date.replace(/-/g, '')}`;
    const isLast = i === stores.length - 1;

    sections.push(`
<div class="store-page"${isLast ? ' style="page-break-after: avoid;"' : ''}>
<!-- Номер документа и дата -->
<table class="meta" cellpadding="0" cellspacing="0">
  <tr>
    <td class="label">Broj dokumenta</td>
    <td class="value">${escapeHtml(docNo)}</td>
  </tr>
  <tr>
    <td class="label">Datum</td>
    <td class="value">${escapeHtml(date)}</td>
  </tr>
</table>

<!-- Поставщик и получатель -->
<table class="parties" cellpadding="0" cellspacing="0">
  <tr>
    <!-- Поставщик -->
    <td>
      <table class="party" cellpadding="0" cellspacing="0">
        <tr>
          <td class="label">Dobavljač:</td>
          <td class="value">${escapeHtml(prod.name)}</td>
        </tr>
        <tr>
          <td class="label">Adresa:</td>
          <td class="value">${escapeHtml(prod.address)}</td>
        </tr>
        <tr>
          <td class="label">PIB:</td>
          <td class="value">${escapeHtml(prod.pib)}</td>
        </tr>
        <tr>
          <td class="label">MBR:</td>
          <td class="value">${escapeHtml(prod.mbr)}</td>
        </tr>
        <tr>
          <td class="label">Tekući račun:</td>
          <td class="value">${escapeHtml(prod.accountNo)}</td>
        </tr>
      </table>
    </td>
    <!-- Получатель -->
    <td>
      <table class="party" cellpadding="0" cellspacing="0">
        <tr>
          <td class="label">Primalac:</td>
          <td class="value">${escapeHtml(st.name)}</td>
        </tr>
        <tr>
          <td class="label">Adresa:</td>
          <td class="value">${escapeHtml(st.address || '-')}</td>
        </tr>
        <tr>
          <td class="label">PIB:</td>
          <td class="value">${escapeHtml(st.pib || '-')}</td>
        </tr>
        <tr>
          <td class="label">MBR:</td>
          <td class="value">${escapeHtml(st.mbr || '-')}</td>
        </tr>
        <tr>
          <td class="label">Tekući račun:</td>
          <td class="value">${escapeHtml(st.accountNo || '-')}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<!-- Заголовок -->
<h1>Otpremnica</h1>

<!-- Таблица товаров -->
<table class="items" border="1" bordercolor="#444"
       cellpadding="5" cellspacing="0">
  <colgroup>
    <col width="7%">
    <col width="28%">
    <col width="10%">
    <col width="10%">
    <col width="12%">
    <col width="9%">
    <col width="12%">
    <col width="12%">
  </colgroup>
  <thead>
    <tr>
      <th>№</th>
      <th>Naziv</th>
      <th>JM</th>
      <th>Količina</th>
      <th>Cena</th>
      <th>Stopa PDV-a, %</th>
      <th>Iznos PDV-a</th>
      <th>Ukupna cena sa PDV-om</th>
    </tr>
  </thead>
  <tbody>
    ${rowsHtml || `
      <tr>
        <td colspan="8" align="center">Nema stavki</td>
      </tr>
    `}
  </tbody>
</table>

<!-- Итоги -->
<table class="totals" cellpadding="0" cellspacing="0">
  <tr>
    <td>Iznos bez PDV-a:</td>
    <td>${totalNet.toFixed(2)}</td>
  </tr>
  <tr>
    <td>Iznos PDV-a:</td>
    <td>${totalVat.toFixed(2)}</td>
  </tr>
  <tr class="grand-total">
    <td>Ukupno sa PDV-om:</td>
    <td>${totalGross.toFixed(2)}</td>
  </tr>
</table>

<!-- Подписи -->
<table class="signatures" cellpadding="0" cellspacing="0">
  <tr>
    <td>Dobavljač</td>
    <td class="spacer"></td>
    <td>Primalac</td>
  </tr>
</table>
</div>
    `);
  }

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Otpremnice ${date}</title>
<style>
  @page {
    size: A4 portrait;
    margin: 18mm 12mm 15mm 12mm;
  }
  body {
    font-family: Arial, sans-serif;
    font-size: 9pt;
    color: #111;
    margin: 0;
  }
  .store-page {
    page-break-after: always;
  }
  .store-page:last-child {
    page-break-after: avoid;
  }
  /* Номер и дата документа */
  .meta {
    width: 260px;
    border-collapse: collapse;
    margin-bottom: 55px;
  }
  .meta td {
    padding: 4px 3px;
    font-size: 8pt;
  }
  .meta .label {
    width: 65px;
  }
  .meta .value {
    width: 180px;
    text-align: center;
    border-bottom: 1px solid #777;
  }
  /* Поставщик и получатель */
  .parties {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    margin-bottom: 35px;
  }
  .parties > tbody > tr > td {
    width: 50%;
    vertical-align: top;
    padding: 0 15px 0 0;
  }
  .parties > tbody > tr > td:last-child {
    padding: 0 0 0 15px;
  }
  .party {
    width: 100%;
    border-collapse: collapse;
  }
  .party td {
    padding: 3px 2px;
    font-size: 8pt;
    vertical-align: top;
  }
  .party .label {
    width: 85px;
    white-space: nowrap;
  }
  .party .value {
    border-bottom: 1px solid #888;
  }
  /* Заголовок */
  h1 {
    text-align: center;
    font-size: 16pt;
    font-weight: bold;
    margin: 0 0 28px 0;
  }
  /* Основная таблица */
  .items {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    border: 1px solid #333;
  }
  .items th,
  .items td {
    border: 1px solid #444;
    padding: 5px 4px;
    font-size: 7.5pt;
    vertical-align: middle;
  }
  .items th {
    text-align: center;
    font-weight: normal;
    height: 38px;
    background-color: #f2f2f2;
  }
  .items td {
    height: 25px;
  }
  .items td:nth-child(1),
  .items td:nth-child(3),
  .items td:nth-child(6) {
    text-align: center;
  }
  .items td:nth-child(2) {
    text-align: left;
  }
  .items td:nth-child(4),
  .items td:nth-child(5),
  .items td:nth-child(7),
  .items td:nth-child(8) {
    text-align: right;
  }
  /* Итоги */
  .totals {
    width: 320px;
    margin-left: auto;
    margin-top: 20px;
    margin-bottom: 40px;
    border-collapse: collapse;
    border: 1px solid #333;
  }
  .totals td {
    padding: 5px 8px;
    font-size: 8pt;
    border: 1px solid #444;
  }
  .totals td:first-child {
    text-align: left;
  }
  .totals td:last-child {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .totals tr.grand-total td {
    font-weight: bold;
    background-color: #f2f2f2;
  }
  /* Подписи */
  .signatures {
    width: 100%;
    margin-top: 40px;
    border-collapse: collapse;
  }
  .signatures td {
    width: 40%;
    text-align: center;
    vertical-align: top;
    padding-top: 35px;
    font-size: 8.5pt;
    font-weight: bold;
    border-top: 1px solid #444;
  }
  .signatures td.spacer {
    width: 20%;
    border-top: none;
  }
  @media print {
    body {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .items tr, .totals tr {
      page-break-inside: avoid;
    }
  }
</style>
</head>
<body>
${sections.length ? sections.join('\n') : '<div style="text-align:center; padding:40px;">Nema otpremnica za dati datum</div>'}
</body>
</html>`;

  return Buffer.from(html, 'utf-8');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
