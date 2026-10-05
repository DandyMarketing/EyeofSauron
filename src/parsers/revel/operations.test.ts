/**
 * The operations report had no tests at all, and the defect that made it
 * obvious lost a day of trade in silence.
 *
 * NEON PIGEON, 29 SEP 2026. Somebody typed a discount reason with line breaks
 * in it. The report was valid CSV — RFC 4180 allows a newline inside a quoted
 * field — and the parser split the file into sections on blank lines BEFORE any
 * CSV parsing, so it cut the DISCOUNT REASON table in half and handed csv-parse
 * an unclosed quote. The whole file was rejected with "Quote Not Closed ... at
 * line 4", which is line four OF THAT SECTION and therefore looked unrelated to
 * anything in the file. Nothing was ingested and the error blamed the file.
 *
 * RECURS AT EVERY CUSTOMER: any free-text field somebody can type a newline
 * into does this — a discount reason, a void reason, a product name — and it
 * costs the day's entire report rather than one row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOperationsReport, splitSections, paymentsReconcile } from './operations.js';

/**
 * The real file's shape, trimmed to the sections that matter here. CRLF line
 * endings and the single-space separator lines are Revel's, not a typo — both
 * are what the parser actually has to cope with.
 */
const REPORT = [
  'SALES BY CLASS,Raw Qty,Raw Sales,Voids/Returns Qty,Voids/Returns,Comps Qty,Comps,Gross Sales,Item Disc,Order Disc,Net Totals',
  'Beverage,85,1837.00,3,84.00,0,0.00,1753.00,113.75,3.00,1636.25',
  'Food,85,1886.00,0,0.00,0,0.00,1886.00,65.75,39.00,1781.25',
  'Total,170,3723.00,3,84.00,0,0.00,3639.00,179.50,42.00,3417.50',
  ' ',
  'GROSS PRODUCT SALES,Amount',
  'Taxed Gross Sales,3639.00',
  'Untaxed Gross Sales,0.00',
  'Total,3980.76',
  ' ',
  'PAYMENTS,Qty,Sales,Deposits,House Accounts,Refunds,Tips,Total',
  'Cash,0,0.00,0.00,0.00,0.00,0.00,0.00',
  'Credit,14.0,3165.97,0.00,0.00,0.00,0.00,3165.97',
  'American Express,1,80.33,0.00,0.00,0.00,0.00,80.33',
  'MasterCard,2,548.67,0.00,0.00,0.00,0.00,548.67',
  'Visa,11,2536.97,0.00,0.00,0.00,0.00,2536.97',
  'Debit,4.0,931.63,0.00,0.00,0.00,0.00,931.63',
  'House Account,0.0,0.0,0.0,-,0.0,0.0,0.0',
  'NETS,0,0.00,0.00,0.00,0.00,0.00,0.00',
  'Custom Payment,0,0.00,0.00,0.00,0.00,0.00,0.00',
  'Grand Total,18,4097.60,0.00,0.00,0.00,0.00,4097.60',
  ' ',
  'SERVICE PERFORMANCE,Amount',
  'Total Transactions,23.0',
  'Average Check,163.45',
  'Total Guests,34.0',
  'Average Sale Per Guest,110.57',
  ' ',
  'DISCOUNT REASON,Qty,Total',
  'Corbin,2,42.00',
  'Dandy Family,5,65.50',
  '"Josh',            // <- the field opens here
  '',                 // <- a BLANK LINE, inside the quotes
  'Runaway",1,42.00', // <- and closes here
  'Khai,4,62.00',
  'Standard,13,221.50',
  'TOTAL,,221.50',
  ' ',
  '"VOIDS, RETURNS AND COMPS REASON",T,Qty,Total',
  'Double Order,V,3,84.00',
  '',
].join('\r\n');

test('a blank line inside a quoted field does not end a section', () => {
  const sections = splitSections(REPORT);
  const names = sections.map(s => s[0].split(',')[0].replace(/^"/, ''));

  // The bug produced an extra section starting at `Runaway"` and left the
  // discount table truncated. Every section must be present exactly once.
  assert.deepEqual(names, [
    'SALES BY CLASS',
    'GROSS PRODUCT SALES',
    'PAYMENTS',
    'SERVICE PERFORMANCE',
    'DISCOUNT REASON',
    'VOIDS',   // the section name itself is quoted and contains a comma
  ]);

  const discounts = sections[4];
  // header + 5 reasons + TOTAL. The broken version stopped at `"Josh`.
  assert.equal(discounts.length, 7, `discount section was cut: ${JSON.stringify(discounts)}`);
});

test('the whole report still parses, and the multi-line reason survives', () => {
  const data = parseOperationsReport(REPORT);

  // The failure mode was total: nothing parsed at all.
  assert.equal(data.grossProductSales.taxedGrossSales, 3639);
  assert.equal(data.servicePerformance.totalGuests, 34);
  assert.equal(data.salesByClass.length, 2);

  const reasons = data.discountReasons.map(r => r.reason);
  assert.deepEqual(reasons, ['Corbin', 'Dandy Family', 'Josh Runaway', 'Khai', 'Standard']);

  // Collapsed, not preserved: a newline inside a cell ends a markdown table,
  // and the line break carries no information.
  const josh = data.discountReasons.find(r => r.reason.startsWith('Josh'));
  assert.ok(josh, 'the multi-line reason was dropped');
  assert.equal(josh!.total, 42);
  assert.ok(!/[\r\n]/.test(josh!.reason), 'the reason still contains a line break');

  // And the section whose own NAME is quoted and contains a comma.
  assert.deepEqual(data.voidCompReasons, [{ reason: 'Double Order', type: 'V', qty: 3, total: 84 }]);
});

test('an escaped quote inside a field does not flip quote state', () => {
  // `""` is one literal quote character, not two delimiters. Getting this wrong
  // leaves the scanner inside a field for the rest of the file, so every later
  // blank line stops being a section break and the whole report becomes one
  // section — a silent, total failure rather than a loud one.
  const content = [
    'DISCOUNT REASON,Qty,Total',
    '"Sam ""The Chef""",1,10.00',
    ' ',
    'NEXT SECTION,Amount',
    'Thing,1.00',
  ].join('\n');

  const sections = splitSections(content);
  assert.equal(sections.length, 2, `quote state leaked: ${JSON.stringify(sections)}`);
  assert.equal(sections[1][0], 'NEXT SECTION,Amount');
});

test('NETS is a payment method, not a sub-type of House Account', () => {
  /**
   * The report carries no indentation, so the hierarchy comes from a hardcoded
   * list and NETS was missing from it — which made Singapore's most common
   * debit rail a child of `House Account`. It was $0 at Neon Pigeon, so nothing
   * complained; at a venue that takes NETS, anything summing `!isSubType`
   * would have dropped the lot.
   */
  const { payments } = parseOperationsReport(REPORT);
  const byType = new Map(payments.map(p => [p.type, p]));

  assert.equal(byType.get('NETS')!.isSubType, false);
  assert.equal(byType.get('NETS')!.parentType, null);

  // And the brands really are children, or the list has gone the other way.
  for (const brand of ['American Express', 'MasterCard', 'Visa']) {
    assert.equal(byType.get(brand)!.isSubType, true, `${brand} should sit under Credit`);
    assert.equal(byType.get(brand)!.parentType, 'Credit');
  }
});

test('the payment methods reconcile to the stated Grand Total', () => {
  // This is the guard against the NEXT payment method missing from the list:
  // one wrongly demoted vanishes from the sum, one wrongly promoted
  // double-counts, and both show up here.
  const { payments } = parseOperationsReport(REPORT);
  const check = paymentsReconcile(payments);

  assert.ok(check, 'no Grand Total row was found');
  assert.equal(check!.grandTotal, 4097.6);
  assert.ok(check!.passed, `methods summed to ${check!.methodsTotal} against ${check!.grandTotal}`);
});

test('a missing Grand Total reports no check rather than a passing one', () => {
  // An absent check and a passing check must not look the same.
  assert.equal(
    paymentsReconcile([
      { type: 'Cash', qty: 1, sales: 10, deposits: 0, houseAccounts: 0, refunds: 0, tips: 0, total: 10, isSubType: false, parentType: null },
    ]),
    null,
  );
});

test('a double-counted sub-type is caught', () => {
  // The failure the check exists for: a card brand promoted to a method adds
  // its amount a second time.
  const check = paymentsReconcile([
    { type: 'Credit', qty: 1, sales: 100, deposits: 0, houseAccounts: 0, refunds: 0, tips: 0, total: 100, isSubType: false, parentType: null },
    { type: 'Visa', qty: 1, sales: 100, deposits: 0, houseAccounts: 0, refunds: 0, tips: 0, total: 100, isSubType: false, parentType: null },
    { type: 'Grand Total', qty: 1, sales: 100, deposits: 0, houseAccounts: 0, refunds: 0, tips: 0, total: 100, isSubType: false, parentType: null },
  ]);
  assert.equal(check!.passed, false);
  assert.equal(check!.difference, 100);
});

test('a file with no trailing newline keeps its last row', () => {
  // The scan accumulates into a buffer and flushes on a line ending; a file
  // that simply stops would otherwise lose whatever was in the buffer.
  const sections = splitSections('DISCOUNT REASON,Qty,Total\nCorbin,2,42.00');
  assert.deepEqual(sections, [['DISCOUNT REASON,Qty,Total', 'Corbin,2,42.00']]);
});

/**
 * Neon Pigeon, 4 Oct 2026 — the real PAYMENTS section, verbatim.
 *
 * Revel listed a card brand called `Other` under Credit. `Other` is also a
 * payment METHOD name, so the list promoted it and $502.38 was counted twice:
 * methods summed to $4,696.13 against a Grand Total of $4,193.75. The brands
 * sum to Credit exactly, which is what the parser now reads.
 */
const PAYMENTS_4_OCT = [
  'PAYMENTS,Qty,Sales,Deposits,House Accounts,Refunds,Tips,Total',
  'Cash,0,0.00,0.00,0.00,0.00,0.00,0.00',
  'Credit,14.0,3137.42,0.00,0.00,0.00,0.00,3137.42',
  'MasterCard,2,794.94,0.00,0.00,0.00,0.00,794.94',
  'Other,2,502.38,0.00,0.00,0.00,0.00,502.38',
  'UnionPay,1,202.63,0.00,0.00,0.00,0.00,202.63',
  'Visa,9,1637.47,0.00,0.00,0.00,0.00,1637.47',
  'Debit,5.0,1056.33,0.00,0.00,0.00,0.00,1056.33',
  'House Account,0.0,0.0,0.0,-,0.0,0.0,0.0',
  'NETS,0,0.00,0.00,0.00,0.00,0.00,0.00',
  'Custom Payment,0,0.00,0.00,0.00,0.00,0.00,0.00',
  'Grand Total,19,4193.75,0.00,0.00,0.00,0.00,4193.75',
].join('\n');

test('a card brand that shares a method\'s name sits under its card, by arithmetic', () => {
  const { payments } = parseOperationsReport(PAYMENTS_4_OCT);
  const other = payments.find(p => p.type === 'Other')!;
  assert.equal(other.isSubType, true, '"Other" was promoted to a method and counted twice');
  assert.equal(other.parentType, 'Credit');

  // And the methods are exactly what they were: Debit still starts its own.
  const debit = payments.find(p => p.type === 'Debit')!;
  assert.equal(debit.isSubType, false);

  const check = paymentsReconcile(payments)!;
  assert.ok(check.passed, `methods summed to ${check.methodsTotal} against ${check.grandTotal}`);
  assert.equal(check.grandTotal, 4193.75);
});

test('a card total a few dollars short cannot swallow the next method', () => {
  /**
   * The guard on the arithmetic. If the brands under Credit fall short of it —
   * a rounding gap, a brand Revel left out — Credit stays "open", and without
   * the size check NETS would be read as a card brand and vanish from the sum.
   * A row bigger than what is left cannot be a brand.
   */
  const report = [
    'PAYMENTS,Qty,Sales,Deposits,House Accounts,Refunds,Tips,Total',
    'Credit,3,300.00,0,0,0,0,300.00',
    'Visa,2,295.00,0,0,0,0,295.00',
    'NETS,4,400.00,0,0,0,0,400.00',
    'Grand Total,7,700.00,0,0,0,0,700.00',
  ].join('\n');
  const { payments } = parseOperationsReport(report);
  assert.equal(payments.find(p => p.type === 'NETS')!.isSubType, false, 'NETS was swallowed by an open Credit');
  assert.ok(paymentsReconcile(payments)!.passed);
});

test('a method with no brands cannot swallow the next method', () => {
  // Debit carries no card brands beneath it, so its whole total is "open". A
  // running-balance rule read NETS as a Debit brand; proof by exact sum does not.
  const report = [
    'PAYMENTS,Qty,Sales,Deposits,House Accounts,Refunds,Tips,Total',
    'Debit,5,1056.33,0,0,0,0,1056.33',
    'NETS,3,400.00,0,0,0,0,400.00',
    'House Account,0,0,0,-,0,0,0',
    'Grand Total,8,1456.33,0,0,0,0,1456.33',
  ].join('\n');
  const { payments } = parseOperationsReport(report);
  assert.equal(payments.find(p => p.type === 'NETS')!.isSubType, false);
  // And a zero row is never "proven" to be anything — it stays on the list.
  assert.equal(payments.find(p => p.type === 'House Account')!.isSubType, false);
  assert.ok(paymentsReconcile(payments)!.passed);
});
