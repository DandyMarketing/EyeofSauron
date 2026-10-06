/**
 * Xero SALES invoices (ACCREC) and customer credit notes (ACCRECCREDIT) into
 * rows, without the network.
 *
 * Why at all: Neon Pigeon's sushi is sold wholesale and invoiced in Xero, never
 * rung through Revel, so the only record of a sushi sale between month-ends is
 * the invoice. The P&L gives sushi sales a month at a time; invoices carry a
 * date, so they give it a week at a time -- the same move the bills made for
 * cost. Khai, 6 Oct 2026: "load sales invoices to sushi sales to show weekly".
 *
 * NET OF GST, because the ledger is. A line's LineAmount is tax-INCLUSIVE when
 * the invoice's LineAmountTypes is "Inclusive", so summing it raw would read 9%
 * high against the P&L the coverage check compares it with. `net_amount` is the
 * figure to add up, and it is computed here, once, at the boundary.
 *
 * CREDIT NOTES ARE NEGATED here, for the reason given in credit-notes.ts: Xero
 * returns them positive, and a refund stored positive would ADD to sales.
 */
import { parseXeroDate, parseNumber, type BillRow, type BillLineRow } from './bills.js';

export interface SalesInvoiceRow extends BillRow {
  /** Exclusive | Inclusive | NoTax -- what LineAmount means on this invoice. */
  line_amount_types: string | null;
}

export interface SalesInvoiceLineRow extends BillLineRow {
  tax_amount: number | null;
  /** Ex-GST. The figure to sum; comparable with the P&L. */
  net_amount: number | null;
}

const negate = (v: number | null) => (v === null ? null : -v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** LineAmount without GST, given what the invoice says LineAmount includes. */
export function netOfTax(lineAmount: number | null, taxAmount: number | null, lineAmountTypes: string | null): number | null {
  if (lineAmount === null) return null;
  if ((lineAmountTypes ?? '').toLowerCase() !== 'inclusive') return lineAmount;
  // Inclusive with no tax figure cannot be split; null is honest, a guess is not.
  if (taxAmount === null) return null;
  return round2(lineAmount - taxAmount);
}

function header(doc: any, id: unknown, number: unknown, credit: boolean): SalesInvoiceRow | null {
  if (!id) return null;
  const date = parseXeroDate(doc?.DateString ?? doc?.Date);
  // Undated is dropped rather than guessed: a sale in the wrong week is worse
  // than a missing one, which somebody can at least see.
  if (!date) return null;
  const money = (v: unknown) => (credit ? negate(parseNumber(v)) : parseNumber(v));
  return {
    invoice_id: String(id),
    invoice_number: number ? String(number) : null,
    reference: doc?.Reference ? String(doc.Reference) : null,
    // The CUSTOMER here; the shared shape calls it supplier_name, and the
    // ingest renames it to customer_name before it is written.
    supplier_name: doc?.Contact?.Name ? String(doc.Contact.Name) : null,
    bill_date: date,
    due_date: credit ? null : parseXeroDate(doc?.DueDateString ?? doc?.DueDate),
    status: doc?.Status ? String(doc.Status) : null,
    sub_total: money(doc?.SubTotal),
    total_tax: money(doc?.TotalTax),
    total: money(doc?.Total),
    currency_code: doc?.CurrencyCode ? String(doc.CurrencyCode) : null,
    line_amount_types: doc?.LineAmountTypes ? String(doc.LineAmountTypes) : null,
  };
}

function lines(doc: any, credit: boolean): SalesInvoiceLineRow[] {
  const types = doc?.LineAmountTypes ? String(doc.LineAmountTypes) : null;
  const out: SalesInvoiceLineRow[] = [];
  (doc?.LineItems ?? []).forEach((line: any, index: number) => {
    if (!line) return;
    const amount = parseNumber(line.LineAmount);
    const tax = parseNumber(line.TaxAmount);
    const net = netOfTax(amount, tax, types);
    const sign = (v: number | null) => (credit ? negate(v) : v);
    out.push({
      line_item_id: line.LineItemID ? String(line.LineItemID) : `position-${index}`,
      description: line.Description ? String(line.Description) : null,
      // Not negated on a credit: five units were credited, not minus five.
      quantity: parseNumber(line.Quantity),
      unit_amount: sign(parseNumber(line.UnitAmount)),
      line_amount: sign(amount),
      tax_amount: sign(tax),
      net_amount: sign(net),
      account_code: line.AccountCode ? String(line.AccountCode) : null,
      account_id: line.AccountID ? String(line.AccountID) : null,
      tracking: Array.isArray(line.Tracking) && line.Tracking.length > 0 ? line.Tracking : null,
    });
  });
  return out;
}

export const toSalesInvoiceRow = (inv: any) => header(inv, inv?.InvoiceID, inv?.InvoiceNumber, false);
export const toSalesInvoiceLineRows = (inv: any) => lines(inv, false);
export const toCustomerCreditRow = (cn: any) => header(cn, cn?.CreditNoteID, cn?.CreditNoteNumber, true);
export const toCustomerCreditLineRows = (cn: any) => lines(cn, true);

/**
 * Statuses that are SALES. A draft or submitted invoice has not been approved
 * and is not in the ledger; a voided or deleted one never was. Counting either
 * would put a sale in the week that the P&L will never show.
 */
export const COUNTED_SALES_STATUSES = new Set(['AUTHORISED', 'PAID']);
