/**
 * Xero supplier bills into rows, without the network.
 *
 * A bill is an invoice of type ACCPAY. Its line items are the answer to
 * "marketing cost 26,034 on what" -- each carries a description, an amount and
 * the account it was coded to.
 */

export interface BillRow {
  invoice_id: string;
  invoice_number: string | null;
  reference: string | null;
  supplier_name: string | null;
  bill_date: string;
  due_date: string | null;
  status: string | null;
  sub_total: number | null;
  total_tax: number | null;
  total: number | null;
  currency_code: string | null;
}

export interface BillLineRow {
  line_item_id: string;
  description: string | null;
  quantity: number | null;
  unit_amount: number | null;
  line_amount: number | null;
  account_code: string | null;
  account_id: string | null;
  tracking: unknown;
}

/**
 * Xero sends dates as `/Date(1750000000000+0000)/` on some fields and ISO on
 * others. Both appear in one response, so both are handled -- and an
 * unreadable date returns null rather than today, because a bill filed against
 * the wrong month is a cost attributed to the wrong period.
 */
export function parseXeroDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;

  const dotNet = raw.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (dotNet) {
    const ms = Number(dotNet[1]);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
  }

  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Null rather than 0 for anything unreadable: a missing amount is not a free line. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * One bill into a row. Null when it cannot be stored or dated.
 *
 * A bill with no date is dropped rather than guessed at. Every question this
 * table exists for is "what did we spend in month X", and a bill in the wrong
 * month is worse than a bill that is missing -- the first is a wrong answer,
 * the second is a gap somebody can see.
 */
export function toBillRow(invoice: any): BillRow | null {
  const invoiceId = invoice?.InvoiceID;
  if (!invoiceId) return null;

  const billDate = parseXeroDate(invoice?.DateString ?? invoice?.Date);
  if (!billDate) return null;

  return {
    invoice_id: String(invoiceId),
    invoice_number: invoice?.InvoiceNumber ? String(invoice.InvoiceNumber) : null,
    reference: invoice?.Reference ? String(invoice.Reference) : null,
    supplier_name: invoice?.Contact?.Name ? String(invoice.Contact.Name) : null,
    bill_date: billDate,
    due_date: parseXeroDate(invoice?.DueDateString ?? invoice?.DueDate),
    status: invoice?.Status ? String(invoice.Status) : null,
    sub_total: parseNumber(invoice?.SubTotal),
    total_tax: parseNumber(invoice?.TotalTax),
    total: parseNumber(invoice?.Total),
    currency_code: invoice?.CurrencyCode ? String(invoice.CurrencyCode) : null,
  };
}

/**
 * A bill's lines.
 *
 * `index` is used to key a line that arrives without a LineItemID. Xero
 * normally supplies one, but a line with no key cannot be upserted, and
 * dropping it would quietly lose spend -- the total would then disagree with
 * the bill it came from, which is exactly the kind of unexplainable gap the
 * reconciliation gate exists to prevent elsewhere.
 */
export function toBillLineRows(invoice: any): BillLineRow[] {
  const lines: BillLineRow[] = [];

  (invoice?.LineItems ?? []).forEach((line: any, index: number) => {
    if (!line) return;
    lines.push({
      line_item_id: line.LineItemID ? String(line.LineItemID) : `position-${index}`,
      description: line.Description ? String(line.Description) : null,
      quantity: parseNumber(line.Quantity),
      unit_amount: parseNumber(line.UnitAmount),
      line_amount: parseNumber(line.LineAmount),
      account_code: line.AccountCode ? String(line.AccountCode) : null,
      // The UUID, and the reason this table joins to the P&L without a
      // chart-of-accounts lookup. profit_and_loss.account_id holds the same value.
      account_id: line.AccountID ? String(line.AccountID) : null,
      tracking: Array.isArray(line.Tracking) && line.Tracking.length > 0 ? line.Tracking : null,
    });
  });

  return lines;
}

/**
 * Statuses that are NOT spend.
 *
 * A voided bill still exists in Xero and still comes back from the API. Counting
 * one is money the business never spent, and it is the kind of error that
 * survives review because the bill is real and the number is real -- only the
 * status says otherwise.
 */
export const NON_SPEND_STATUSES = new Set(['VOIDED', 'DELETED']);

export function isSpend(bill: BillRow): boolean {
  return !NON_SPEND_STATUSES.has((bill.status ?? '').toUpperCase());
}
