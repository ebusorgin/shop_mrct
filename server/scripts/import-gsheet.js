import { pool } from '../dist/db.js';

function parseCSV(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let field = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(field.trim());
      field = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') { i++; }
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

function parseDate(row0Str) {
  const match = row0Str.match(/Доставка\s+(\d{2})\.(\d{2})\.(\d{2})/i);
  if (!match) return null;
  const [, dd, mm, yy] = match;
  return `20${yy}-${mm}-${dd}`;
}

async function main() {
  const arg = process.argv[2] || 'https://docs.google.com/spreadsheets/d/1tmtmBRcpDDRM5KaONo5wXo51RFcbm92nQ9GibFlHAzA/edit?gid=1990710825';
  let spreadsheetId = '1tmtmBRcpDDRM5KaONo5wXo51RFcbm92nQ9GibFlHAzA';
  let gid = '1990710825';

  const matchId = arg.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (matchId) spreadsheetId = matchId[1];
  const matchGid = arg.match(/gid=([0-9]+)/);
  if (matchGid) gid = matchGid[1];

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  console.log(`Fetching Google Sheet CSV for spreadsheet ${spreadsheetId}, gid ${gid}...`);
  
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch spreadsheet: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  const rows = parseCSV(text);

  if (!rows.length) {
    console.error('CSV is empty');
    process.exit(1);
  }

  const deliveryDate = parseDate(rows[0].join(' ')) || new Date().toISOString().slice(0, 10);
  console.log('Delivery date parsed:', deliveryDate);

  let headerIdx = rows.findIndex(r => r.some(c => c.toUpperCase().includes('PLU')));
  if (headerIdx < 0) {
    console.error('Header row with PLU not found');
    process.exit(1);
  }

  const header = rows[headerIdx].map(c => c.trim());
  const storeCols = [];
  const { rows: dbStores } = await pool.query('select id, code from stores');
  const storeMap = new Map(dbStores.map(s => [String(s.id), s.id]));

  for (let j = 0; j < header.length; j++) {
    if (storeMap.has(header[j])) {
      storeCols.push({ index: j, storeId: storeMap.get(header[j]) });
    }
  }
  console.log('Mapped store columns:', storeCols);

  const { rows: dbCards } = await pool.query('select id, plu, name from tech_cards');
  const cardByPlu = new Map(dbCards.filter(c => c.plu).map(c => [c.plu.toUpperCase(), c.id]));
  const cardByName = new Map(dbCards.map(c => [c.name.trim().toLowerCase(), c.id]));

  const nameIdx = header.findIndex(c => c.toLowerCase().includes('наименование'));
  const pluIdx = header.findIndex(c => c.toUpperCase() === 'PLU');
  const unitIdx = header.findIndex(c => c.toLowerCase().includes('ед'));

  let importedCount = 0;

  await pool.query('begin');
  try {
    const sheetName = `Заказ ${deliveryDate}`;
    let { rows: tabRows } = await pool.query(
      `select id from order_tabs where extract_date = $1::date`,
      [deliveryDate]
    );
    let tabId;
    if (tabRows.length > 0) {
      tabId = tabRows[0].id;
      await pool.query(`update order_tabs set sheet_name = $1 where id = $2`, [sheetName, tabId]);
    } else {
      const ins = await pool.query(
        `insert into order_tabs (sheet_name, extract_date, status) values ($1, $2::date, 'open') returning id`,
        [sheetName, deliveryDate]
      );
      tabId = ins.rows[0].id;
    }

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 3) continue;
      const name = r[nameIdx !== -1 ? nameIdx : 1];
      const plu = r[pluIdx !== -1 ? pluIdx : 2] || '';
      const unitCode = r[unitIdx !== -1 ? unitIdx : 5] || 'кг';

      if (!name) continue;
      if (name.toLowerCase().includes('наименование') || plu.toUpperCase() === 'PLU') continue;

      let cardId = (plu ? cardByPlu.get(plu.toUpperCase()) : null) ?? cardByName.get(name.trim().toLowerCase()) ?? null;

      for (const sc of storeCols) {
        const valStr = r[sc.index];
        if (!valStr || valStr.trim() === '') continue;
        const qty = parseFloat(valStr.replace(',', '.'));
        if (isNaN(qty) || qty <= 0) continue;

        const { rows: existing } = await pool.query(
          `select id from orders where store_id = $1 and date_tab = $2::date and source_name = $3`,
          [sc.storeId, deliveryDate, name]
        );
        if (existing.length > 0) {
          await pool.query(
            `update orders set quantity = $1, status = 'synced', card_id = $2, tab_id = $3 where id = $4`,
            [qty, cardId, tabId, existing[0].id]
          );
        } else {
          await pool.query(
            `insert into orders (tab_id, store_id, date_tab, card_id, source_name, plu, quantity, unit_code, status, source)
             values ($1, $2, $3::date, $4, $5, $6, $7, $8, 'synced', 'g_sheet')`,
            [tabId, sc.storeId, deliveryDate, cardId, name, plu, qty, unitCode]
          );
        }
        importedCount++;
      }
    }

    await pool.query('commit');
    console.log(`Successfully imported/updated ${importedCount} order lines for delivery date ${deliveryDate} into DB!`);
  } catch (err) {
    await pool.query('rollback');
    console.error('Import failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
