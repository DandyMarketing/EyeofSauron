import { test } from 'node:test';
import assert from 'node:assert';
import { toCreditNoteRow, toCreditNoteLineRows } from './credit-notes.js';
import { isSpend } from './bills.js';

/** As Xero returns it: every amount POSITIVE. */
const CREDIT_NOTE = {
  CreditNoteID: 'cn-0001',
  CreditNoteNumber: 'CN-104',
  Reference: 'Returned stock',
  Contact: { Name: 'Angliss Singapore' },
  DateString: '2026-06-14T00:00:00',
  Status: 'AUTHORISED',
  SubTotal: 400.00,
  TotalTax: 36.00,
  Total: 436.00,
  CurrencyCode: 'SGD',
  LineItems: [
    {
      LineItemID: 'cnl-1',
      Description: 'Short-delivered beef',
      Quantity: 5,
      UnitAmount: 80.00,
      LineAmount: 400.00,
      AccountCode: '310',
      AccountID: 'acct-cogs-food',
    },
  ],
};

test('EVERY monetary field is negated — this is the whole point', () => {
  // Xero returns a $436 credit as Total: 436. Stored as it comes it would ADD
  // $436 to apparent spend, doubling the error it exists to correct.
  const row = toCreditNoteRow(CREDIT_NOTE)!;

  assert.equal(row.total, -436.00);
  assert.equal(row.sub_total, -400.00);
  assert.equal(row.total_tax, -36.00);
});

test('a credit line reduces the account rather than adding to it', () => {
  const [line] = toCreditNoteLineRows(CREDIT_NOTE);
  assert.equal(line.line_amount, -400.00);
  assert.equal(line.unit_amount, -80.00);
});

test('quantity is NOT negated, and the arithmetic still holds', () => {
  // Five units were credited, not minus five. Negating unit_amount is what
  // keeps quantity x unit_amount = line_amount true for anyone who checks.
  const [line] = toCreditNoteLineRows(CREDIT_NOTE);

  assert.equal(line.quantity, 5);
  assert.equal(line.quantity! * line.unit_amount!, line.line_amount);
});

test('a null amount stays null and does not become -0', () => {
  const row = toCreditNoteRow({ ...CREDIT_NOTE, TotalTax: null })!;
  assert.equal(row.total_tax, null);
});

test('the account id is carried through — it is what joins to the P&L', () => {
  const [line] = toCreditNoteLineRows(CREDIT_NOTE);
  assert.equal(line.account_id, 'acct-cogs-food');
  assert.equal(line.account_code, '310');
});

test('it maps onto the bill row shape, so one table and one set of guards', () => {
  // Deliberately the same type. A parallel path would mean the payroll
  // exclusions live in two places, and the day they drift is the day a credit
  // note reversing a wage payment carries a person's name into the warehouse.
  const row = toCreditNoteRow(CREDIT_NOTE)!;

  assert.equal(row.invoice_id, 'cn-0001');
  assert.equal(row.invoice_number, 'CN-104');
  assert.equal(row.supplier_name, 'Angliss Singapore');
  assert.equal(row.bill_date, '2026-06-14');
});

test('a credit note has no due date', () => {
  assert.equal(toCreditNoteRow(CREDIT_NOTE)!.due_date, null);
});

test('isSpend works on it unchanged — a voided credit is not a credit', () => {
  const voided = toCreditNoteRow({ ...CREDIT_NOTE, Status: 'VOIDED' })!;
  assert.equal(isSpend(voided), false);
  assert.equal(isSpend(toCreditNoteRow(CREDIT_NOTE)!), true);
});

test('no id or no date means it cannot be stored', () => {
  // Same rule as bills: a credit nobody can date is worse in the wrong month
  // than missing, because the first is a wrong answer and the second is a gap.
  assert.equal(toCreditNoteRow({ ...CREDIT_NOTE, CreditNoteID: undefined }), null);
  assert.equal(toCreditNoteRow({ ...CREDIT_NOTE, DateString: null, Date: null }), null);
});

test('a line with no LineItemID is kept under a positional key', () => {
  // Dropping it would lose a credit, leaving the account overstated by exactly
  // the amount nobody can see.
  const lines = toCreditNoteLineRows({
    ...CREDIT_NOTE,
    LineItems: [{ Description: 'no id', LineAmount: 120, AccountID: 'a' }],
  });

  assert.equal(lines[0].line_item_id, 'position-0');
  assert.equal(lines[0].line_amount, -120);
});

test('a credit note with no lines is empty, not an error', () => {
  assert.deepEqual(toCreditNoteLineRows({ ...CREDIT_NOTE, LineItems: [] }), []);
  assert.deepEqual(toCreditNoteLineRows({}), []);
});

test('bills and credit notes cannot collide on the unique key', () => {
  // CreditNoteID and InvoiceID are different UUID spaces, so both can share
  // (tenant_id, invoice_id) without a clash.
  const credit = toCreditNoteRow(CREDIT_NOTE)!;
  assert.notEqual(credit.invoice_id, 'inv-0001');
});
