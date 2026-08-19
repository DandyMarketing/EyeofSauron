import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXeroDate, parseNumber, toBillRow, toBillLineRows, isSpend,
} from './bills.js';

describe('parseXeroDate — two formats in one response', () => {
  test('reads the .NET format Xero uses on Date fields', () => {
    // 2026-06-15T00:00:00Z
    assert.equal(parseXeroDate('/Date(1781481600000+0000)/'), '2026-06-15');
  });

  test('reads the ISO format Xero uses on DateString fields', () => {
    assert.equal(parseXeroDate('2026-06-15T00:00:00'), '2026-06-15');
  });

  test('an unreadable date is null, never today', () => {
    // A bill dated today instead of June is a cost attributed to the wrong
    // month, which is a wrong answer rather than a visible gap.
    assert.equal(parseXeroDate('whenever'), null);
    assert.equal(parseXeroDate(''), null);
    assert.equal(parseXeroDate(undefined), null);
  });
});

describe('parseNumber', () => {
  test('reads numbers and numeric strings', () => {
    assert.equal(parseNumber(1234.56), 1234.56);
    assert.equal(parseNumber('1234.56'), 1234.56);
  });

  test('anything unreadable is null, not zero', () => {
    // A missing amount is not a free line.
    assert.equal(parseNumber('n/a'), null);
    assert.equal(parseNumber(''), null);
    assert.equal(parseNumber(null), null);
  });
});

describe('toBillRow', () => {
  const invoice = {
    InvoiceID: 'abc-123',
    InvoiceNumber: 'INV-042',
    Reference: 'June retainer',
    Contact: { Name: 'Some Agency Pte Ltd' },
    DateString: '2026-06-15T00:00:00',
    DueDateString: '2026-07-15T00:00:00',
    Status: 'AUTHORISED',
    SubTotal: 1000,
    TotalTax: 90,
    Total: 1090,
    CurrencyCode: 'SGD',
  };

  test('reads a whole bill', () => {
    const row = toBillRow(invoice)!;
    assert.equal(row.invoice_id, 'abc-123');
    assert.equal(row.supplier_name, 'Some Agency Pte Ltd');
    assert.equal(row.bill_date, '2026-06-15');
    assert.equal(row.total, 1090);
  });

  test('a bill with no id cannot be stored', () => {
    assert.equal(toBillRow({ ...invoice, InvoiceID: undefined }), null);
  });

  test('a bill with no readable date is DROPPED rather than guessed', () => {
    // Better a visible gap than a cost silently filed against the wrong month.
    assert.equal(toBillRow({ ...invoice, DateString: 'whenever', Date: undefined }), null);
  });
});

describe('toBillLineRows', () => {
  test('keeps both account identifiers', () => {
    // account_code is what a human recognises; account_id is what JOINS to
    // profit_and_loss.account_id, which is what removed the need for another
    // OAuth scope.
    const lines = toBillLineRows({
      LineItems: [{
        LineItemID: 'line-1',
        Description: 'Social media retainer',
        Quantity: 1,
        UnitAmount: 1000,
        LineAmount: 1000,
        AccountCode: '473',
        AccountID: 'uuid-of-marketing-account',
      }],
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].account_code, '473');
    assert.equal(lines[0].account_id, 'uuid-of-marketing-account');
    assert.equal(lines[0].description, 'Social media retainer');
  });

  test('a line with no id is kept, keyed by position', () => {
    // Dropping it would lose spend, and the stored lines would then disagree
    // with the bill total they came from -- an unexplainable gap.
    const lines = toBillLineRows({ LineItems: [{ Description: 'No id', LineAmount: 50 }] });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].line_item_id, 'position-0');
  });

  test('empty tracking is null rather than an empty array', () => {
    const lines = toBillLineRows({ LineItems: [{ LineItemID: 'a', Tracking: [] }] });
    assert.equal(lines[0].tracking, null);
  });

  test('a bill with no lines yields none, not a crash', () => {
    assert.deepEqual(toBillLineRows({}), []);
    assert.deepEqual(toBillLineRows({ LineItems: null }), []);
  });
});

describe('isSpend', () => {
  const bill = (status: string | null) => ({
    invoice_id: 'x', invoice_number: null, reference: null, supplier_name: null,
    bill_date: '2026-06-15', due_date: null, status,
    sub_total: null, total_tax: null, total: 100, currency_code: null,
  });

  test('authorised and paid bills are spend', () => {
    assert.equal(isSpend(bill('AUTHORISED')), true);
    assert.equal(isSpend(bill('PAID')), true);
  });

  test('a VOIDED bill is not spend, though it is still real', () => {
    // It exists in Xero and comes back from the API. Counting it is money the
    // business never spent -- an error that survives review, because the bill
    // is real and the number is real and only the status says otherwise.
    assert.equal(isSpend(bill('VOIDED')), false);
    assert.equal(isSpend(bill('DELETED')), false);
    assert.equal(isSpend(bill('voided')), false);
  });
});
