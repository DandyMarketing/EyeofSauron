import { parseXeroDate, parseNumber, type BillRow, type BillLineRow } from './bills.js';

/**
 * Supplier credit notes: the refunds and returns that make bill-derived cost
 * overstated until they are counted.
 *
 * Measured for Neon Pigeon, June 2026: four accounts came back ABOVE 100% of
 * their ledger total, COGS Food at 109%. Bills said more was spent on food than
 * the P&L recorded, which is impossible -- the missing piece is ACCPAYCREDIT,
 * a credit note reducing what a supplier is owed. `query_supplier_bills` has
 * been saying so out loud since coverage was built, which made the answer
 * honest and left it wrong.
 *
 * NO NEW SCOPE. Credit notes sit under `accounting.invoices`, which this app
 * already holds -- confirmed against Xero's granular scope mapping before any
 * work started, because the one-scope-at-a-time rule exists precisely so
 * nobody guesses at this and burns a consent round on three organisations.
 *
 * XERO RETURNS CREDIT NOTE AMOUNTS AS POSITIVE, AND THAT IS THE TRAP. A credit
 * note for $400 arrives as Total: 400. Stored as it comes it would ADD $400 to
 * apparent spend -- doubling the error it exists to correct, and moving COGS
 * Food from 109% to something worse while looking like a fix. Every monetary
 * field is negated here, at the boundary, so that nothing downstream has to
 * remember: coverageByAccount() sums line amounts and a credit simply reduces
 * the numerator.
 *
 * `quantity` is deliberately NOT negated. You credited five units at a negative
 * price, not minus five units -- and keeping unit_amount negative preserves
 * quantity x unit_amount = line_amount, so a reader who checks the arithmetic
 * finds it holds.
 */

/** Flip a monetary field, leaving null as null rather than turning it into -0. */
function negate(value: number | null): number | null {
  return value === null ? null : -value;
}

/**
 * One credit note into the same row shape as a bill.
 *
 * Mapped onto BillRow rather than a parallel type so the two share one table,
 * one upsert and one set of payroll guards. A separate path would mean the
 * exclusions live in two places, and the day they drift is the day a credit
 * note reversing a wage payment carries a person's name into the warehouse.
 */
export function toCreditNoteRow(creditNote: any): BillRow | null {
  const creditNoteId = creditNote?.CreditNoteID;
  if (!creditNoteId) return null;

  const date = parseXeroDate(creditNote?.DateString ?? creditNote?.Date);
  if (!date) return null;

  return {
    // Xero's own id. A CreditNoteID is a different UUID space from an
    // InvoiceID, so the two cannot collide on (tenant_id, invoice_id).
    invoice_id: String(creditNoteId),
    invoice_number: creditNote?.CreditNoteNumber ? String(creditNote.CreditNoteNumber) : null,
    reference: creditNote?.Reference ? String(creditNote.Reference) : null,
    supplier_name: creditNote?.Contact?.Name ? String(creditNote.Contact.Name) : null,
    bill_date: date,
    // A credit note has no due date of its own.
    due_date: null,
    status: creditNote?.Status ? String(creditNote.Status) : null,
    sub_total: negate(parseNumber(creditNote?.SubTotal)),
    total_tax: negate(parseNumber(creditNote?.TotalTax)),
    total: negate(parseNumber(creditNote?.Total)),
    currency_code: creditNote?.CurrencyCode ? String(creditNote.CurrencyCode) : null,
  };
}

/**
 * A credit note's lines, negated.
 *
 * `position-` keying matches the bills parser: a line with no LineItemID cannot
 * be upserted, and dropping it would quietly lose a credit -- which would leave
 * the account overstated by exactly the amount nobody can see.
 */
export function toCreditNoteLineRows(creditNote: any): BillLineRow[] {
  const lines: BillLineRow[] = [];

  (creditNote?.LineItems ?? []).forEach((line: any, index: number) => {
    if (!line) return;
    lines.push({
      line_item_id: line.LineItemID ? String(line.LineItemID) : `position-${index}`,
      description: line.Description ? String(line.Description) : null,
      // NOT negated: five units were credited, not minus five units.
      quantity: parseNumber(line.Quantity),
      unit_amount: negate(parseNumber(line.UnitAmount)),
      line_amount: negate(parseNumber(line.LineAmount)),
      account_code: line.AccountCode ? String(line.AccountCode) : null,
      account_id: line.AccountID ? String(line.AccountID) : null,
      tracking: Array.isArray(line.Tracking) && line.Tracking.length > 0 ? line.Tracking : null,
    });
  });

  return lines;
}
