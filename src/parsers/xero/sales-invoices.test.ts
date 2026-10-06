import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  netOfTax, toSalesInvoiceRow, toSalesInvoiceLineRows, toCustomerCreditRow, toCustomerCreditLineRows,
} from './sales-invoices.js';

describe('sales invoices: the figure summed is net of GST', () => {
  test('an Inclusive line has its GST taken out; Exclusive and NoTax are already net', () => {
    assert.equal(netOfTax(109, 9, 'Inclusive'), 100);
    assert.equal(netOfTax(100, 9, 'Exclusive'), 100);
    assert.equal(netOfTax(100, null, 'NoTax'), 100);
  });

  test('Inclusive with no tax figure cannot be split, so it is null, never the gross', () => {
    assert.equal(netOfTax(109, null, 'Inclusive'), null);
  });

  const invoice = {
    InvoiceID: 'inv-1', InvoiceNumber: 'INV-0042', Type: 'ACCREC', Status: 'AUTHORISED',
    Contact: { Name: 'Wholesale Customer Pte Ltd' }, DateString: '2026-09-29T00:00:00',
    LineAmountTypes: 'Inclusive', SubTotal: 1000, TotalTax: 90, Total: 1090,
    LineItems: [{ LineItemID: 'l1', Description: 'Sushi platters', Quantity: 10, UnitAmount: 109, LineAmount: 1090, TaxAmount: 90, AccountID: 'acc-sushi' }],
  };

  test('an invoice parses with its date, customer and net line', () => {
    const row = toSalesInvoiceRow(invoice)!;
    assert.equal(row.bill_date, '2026-09-29');
    assert.equal(row.supplier_name, 'Wholesale Customer Pte Ltd');
    assert.equal(row.line_amount_types, 'Inclusive');
    const [line] = toSalesInvoiceLineRows(invoice);
    assert.equal(line.line_amount, 1090);
    assert.equal(line.net_amount, 1000);
  });

  test('a customer credit note is stored NEGATIVE, so a refund reduces sales', () => {
    const cn = { ...invoice, InvoiceID: undefined, CreditNoteID: 'cn-1', CreditNoteNumber: 'CN-7' };
    const row = toCustomerCreditRow(cn)!;
    assert.equal(row.invoice_id, 'cn-1');
    assert.equal(row.total, -1090);
    const [line] = toCustomerCreditLineRows(cn);
    assert.equal(line.net_amount, -1000);
    assert.equal(line.quantity, 10, 'units credited, not minus units');
  });

  test('an undated invoice is dropped, not put in some other week', () => {
    assert.equal(toSalesInvoiceRow({ ...invoice, DateString: undefined, Date: undefined }), null);
  });
});
