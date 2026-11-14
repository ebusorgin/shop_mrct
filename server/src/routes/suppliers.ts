/**
 * API раздела «Поставщики» — накладные, оцифрованные с фотографий.
 *
 *   GET /api/suppliers              — поставщики с краткими накладными (без позиций)
 *   GET /api/suppliers/invoices/:id — одна накладная с позициями и реквизитами поставщика
 *
 * Только чтение: документы не создают приходных накладных и не меняют остатки.
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, wrap } from '../http';

export const suppliersRouter = Router();

interface InvoiceShort {
  id: number;
  number: string;
  date: string;
  net: number | null;
  vat: number | null;
  gross: number | null;
  itemsCount: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

suppliersRouter.get('/', wrap(async (_req, res) => {
  const suppliers = await pool.query(`
    select id, code, name,
           legal_name as "legalName", address, pib, mb, phone, fax, email,
           accounts, gln, contact, note
      from suppliers
     order by id
  `);
  const invoices = await pool.query(`
    select i.id, i.supplier_id as "supplierId", i.number,
           to_char(i.doc_date, 'YYYY-MM-DD') as date,
           i.total_net as net, i.total_vat as vat, i.total_gross as gross,
           (select count(*)::int from supplier_invoice_items x where x.invoice_id = i.id) as "itemsCount"
      from supplier_invoices i
     order by i.doc_date desc, i.number desc
  `);
  const bySupplier = new Map<number, InvoiceShort[]>();
  for (const r of invoices.rows) {
    const list = bySupplier.get(r.supplierId) ?? [];
    list.push({
      id: r.id, number: r.number, date: r.date,
      net: num(r.net), vat: num(r.vat), gross: num(r.gross), itemsCount: r.itemsCount,
    });
    bySupplier.set(r.supplierId, list);
  }
  res.json(suppliers.rows.map((s) => ({
    ...s,
    accounts: Array.isArray(s.accounts) ? s.accounts : [],
    invoices: bySupplier.get(s.id) ?? [],
  })));
}));

suppliersRouter.get('/invoices/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'Некорректный номер накладной');
  const { rows } = await pool.query(`
    select i.id, i.number, to_char(i.doc_date, 'YYYY-MM-DD') as date,
           i.currency, i.recipient, i.buyer_code as "buyerCode", i.order_ref as "orderRef", i.note,
           i.source_file as "sourceFile",
           i.total_net as net, i.total_vat as vat, i.total_gross as gross,
           s.id as "supplierId", s.code as "supplierCode", s.name as "supplierName",
           s.legal_name as "supplierLegalName", s.address as "supplierAddress",
           s.pib as "supplierPib", s.mb as "supplierMb",
           s.phone as "supplierPhone", s.fax as "supplierFax", s.email as "supplierEmail",
           s.accounts as "supplierAccounts", s.gln as "supplierGln",
           s.contact as "supplierContact", s.note as "supplierNote"
      from supplier_invoices i
      join suppliers s on s.id = i.supplier_id
     where i.id = $1
  `, [id]);
  if (!rows.length) throw new ApiError(404, 'Накладная не найдена');
  const r = rows[0];
  const items = await pool.query(`
    select position, ident, name, qty, unit, price,
           discount_pct as "discountPct", vat_rate as "vatRate", net
      from supplier_invoice_items
     where invoice_id = $1
     order by position
  `, [id]);
  res.json({
    id: r.id, number: r.number, date: r.date,
    currency: r.currency, recipient: r.recipient, buyerCode: r.buyerCode,
    orderRef: r.orderRef, note: r.note,
    sourceFile: r.sourceFile,
    net: num(r.net), vat: num(r.vat), gross: num(r.gross),
    supplier: {
      id: r.supplierId, code: r.supplierCode, name: r.supplierName,
      legalName: r.supplierLegalName, address: r.supplierAddress,
      pib: r.supplierPib, mb: r.supplierMb, phone: r.supplierPhone,
      fax: r.supplierFax, email: r.supplierEmail,
      accounts: Array.isArray(r.supplierAccounts) ? r.supplierAccounts : [],
      gln: r.supplierGln, contact: r.supplierContact, note: r.supplierNote,
    },
    items: items.rows.map((i) => ({
      position: i.position, ident: i.ident, name: i.name,
      qty: Number(i.qty), unit: i.unit, price: Number(i.price),
      discountPct: Number(i.discountPct), vatRate: num(i.vatRate), net: Number(i.net),
    })),
  });
}));
