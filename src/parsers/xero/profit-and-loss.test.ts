import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfitAndLoss, parseAmount, reconcileSections, type PlLine } from './profit-and-loss.js';

/** A report shaped like Xero's documented ProfitAndLoss response. */
const SAMPLE = {
  Reports: [{
    ReportID: 'ProfitAndLoss',
    ReportName: 'Profit and Loss',
    ReportTitles: ['Profit & Loss', 'POTUS PTE LTD', '1 July 2026 to 31 July 2026'],
    Rows: [
      { RowType: 'Header', Cells: [{ Value: '' }, { Value: '31 Jul 2026' }] },
      {
        RowType: 'Section',
        Title: 'Income',
        Rows: [
          { RowType: 'Row', Cells: [
            { Value: 'Food Sales', Attributes: [{ Value: '11111111-1111-1111-1111-111111111111', Id: 'account' }] },
            { Value: '80000.00' },
          ] },
          { RowType: 'Row', Cells: [
            { Value: 'Beverage Sales', Attributes: [{ Value: '22222222-2222-2222-2222-222222222222', Id: 'account' }] },
            { Value: '40000.00' },
          ] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Income' }, { Value: '120000.00' }] },
        ],
      },
      {
        RowType: 'Section',
        Title: 'Less Cost of Sales',
        Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Food Purchases' }, { Value: '26000.00' }] },
          { RowType: 'Row', Cells: [{ Value: 'Beverage Purchases' }, { Value: '10000.00' }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Cost of Sales' }, { Value: '36000.00' }] },
        ],
      },
      {
        RowType: 'Section',
        Title: 'Less Operating Expenses',
        Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Wages' }, { Value: '38000.00' }] },
          { RowType: 'Row', Cells: [{ Value: 'Rent' }, { Value: '22000.00' }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Operating Expenses' }, { Value: '60000.00' }] },
        ],
      },
    ],
  }],
};

describe('parseAmount', () => {
  test('plain and comma-grouped numbers', () => {
    assert.equal(parseAmount('120000.00'), 120000);
    assert.equal(parseAmount('1,234.56'), 1234.56);
  });

  test('negatives, both conventions', () => {
    assert.equal(parseAmount('-500.00'), -500);
    assert.equal(parseAmount('(500.00)'), -500);
  });

  test('a genuine zero is zero', () => {
    assert.equal(parseAmount('0.00'), 0);
  });

  test('a missing figure is null, NOT zero', () => {
    // Collapsing these would let a failed extraction read as a month with no
    // costs -- a very believable and very wrong P&L.
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount('   '), null);
    assert.equal(parseAmount(undefined), null);
    assert.equal(parseAmount('n/a'), null);
  });
});

describe('parseProfitAndLoss', () => {
  const report = parseProfitAndLoss(SAMPLE);

  test('keeps the report titles, which carry the org and the period', () => {
    assert.ok(report.titles.some(t => t.includes('POTUS')));
    assert.ok(report.titles.some(t => t.includes('July 2026')));
  });

  test('flattens every detail and summary line', () => {
    assert.equal(report.lines.length, 9); // 6 detail + 3 summary
  });

  test('carries the section each line belongs to', () => {
    const cogs = report.lines.filter(l => l.section === 'Less Cost of Sales' && !l.is_summary);
    assert.deepEqual(cogs.map(l => l.account_name), ['Food Purchases', 'Beverage Purchases']);
  });

  test('distinguishes a section total from a detail line', () => {
    const total = report.lines.find(l => l.account_name === 'Total Income');
    assert.equal(total?.is_summary, true);
    assert.equal(report.lines.find(l => l.account_name === 'Food Sales')?.is_summary, false);
  });

  test('captures the Xero account id where present', () => {
    assert.equal(
      report.lines.find(l => l.account_name === 'Food Sales')?.account_id,
      '11111111-1111-1111-1111-111111111111',
    );
    // Not every line carries one, and inventing an id would be worse.
    assert.equal(report.lines.find(l => l.account_name === 'Food Purchases')?.account_id, null);
  });

  test('stores amounts exactly as Xero reports them', () => {
    // Costs are positive under a "Less ..." heading. Re-deriving the sign here
    // would put a second, undocumented convention between the ledger and the
    // answer; the section name carries the meaning.
    assert.equal(report.lines.find(l => l.account_name === 'Wages')?.amount, 38000);
  });

  test('preserves report order', () => {
    const orders = report.lines.map(l => l.sort_order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });
});

describe('parseProfitAndLoss — failed extractions must be loud', () => {
  test('a response with no Reports entry throws', () => {
    assert.throws(() => parseProfitAndLoss({}), /no Reports entry/);
  });

  test('a report with no sections throws rather than returning empty', () => {
    // An empty P&L is indistinguishable from a month with no trading, and
    // returning it silently is the failure shape in BUILD_LOG section 1.
    assert.throws(
      () => parseProfitAndLoss({ Reports: [{ Rows: [{ RowType: 'Header', Cells: [] }] }] }),
      /no sections/,
    );
  });

  test('sections containing no readable rows throw', () => {
    assert.throws(
      () => parseProfitAndLoss({ Reports: [{ Rows: [{ RowType: 'Section', Title: 'Income', Rows: [] }] }] }),
      /zero lines/,
    );
  });
});

describe('reconcileSections — the gate before a figure is trusted', () => {
  test('a well-formed report reconciles in every section', () => {
    const checks = reconcileSections(parseProfitAndLoss(SAMPLE).lines);
    assert.equal(checks.length, 3);
    for (const check of checks) {
      assert.ok(check.passed, `${check.section} failed: detail ${check.detail_total} vs reported ${check.reported_total}`);
    }
  });

  test('a dropped line is caught', () => {
    // The failure this exists for: a partially read section still produces a
    // plausible P&L, just a wrong one.
    const lines = parseProfitAndLoss(SAMPLE).lines.filter(l => l.account_name !== 'Rent');
    const opex = reconcileSections(lines).find(c => c.section === 'Less Operating Expenses');
    assert.equal(opex?.passed, false);
    assert.equal(opex?.difference, -22000);
  });

  test('a sign read the wrong way is caught', () => {
    const lines = parseProfitAndLoss(SAMPLE).lines.map(l =>
      l.account_name === 'Beverage Sales' ? { ...l, amount: -l.amount } : l,
    );
    assert.equal(reconcileSections(lines).find(c => c.section === 'Income')?.passed, false);
  });

  test('rounding within a cent still passes', () => {
    const lines: PlLine[] = [
      { section: 'Income', account_name: 'A', account_id: null, amount: 33.33, is_summary: false, sort_order: 0 },
      { section: 'Income', account_name: 'B', account_id: null, amount: 33.34, is_summary: false, sort_order: 1 },
      { section: 'Income', account_name: 'Total Income', account_id: null, amount: 66.67, is_summary: true, sort_order: 2 },
    ];
    assert.equal(reconcileSections(lines)[0].passed, true);
  });

  test('a section with no total is skipped, not failed', () => {
    // Xero does not give every section a summary row.
    const lines: PlLine[] = [
      { section: 'Income', account_name: 'A', account_id: null, amount: 10, is_summary: false, sort_order: 0 },
    ];
    assert.deepEqual(reconcileSections(lines), []);
  });
});

/**
 * Neon Pigeon's August 2026 P&L was refused with "Uncategorised: lines sum to
 * -44,768.62, report says 20,705.02". Both numbers were real and neither had
 * anything to do with the other.
 *
 * Xero leaves several sections UNTITLED -- Gross Profit, Net Profit, spacers --
 * and the parser called every one of them "Uncategorised", merging them into
 * one bucket. Reconciliation then took the first summary row it found and
 * compared it against detail lines from unrelated sections.
 */
describe('untitled sections are not the same section', () => {
  const report = {
    Reports: [{
      ReportName: 'Profit and Loss',
      ReportTitles: ['Profit and Loss', 'Potus Pte Ltd'],
      Rows: [
        {
          RowType: 'Section',
          Title: 'Income',
          Rows: [
            { RowType: 'Row', Cells: [{ Value: 'Food Sales' }, { Value: '60000.00' }] },
            { RowType: 'Row', Cells: [{ Value: 'Beverage Sales' }, { Value: '40000.00' }] },
            { RowType: 'SummaryRow', Cells: [{ Value: 'Total Income' }, { Value: '100000.00' }] },
          ],
        },
        {
          RowType: 'Section',
          Title: 'Less Cost of Sales',
          Rows: [
            { RowType: 'Row', Cells: [{ Value: 'Food Purchases' }, { Value: '30000.00' }] },
            { RowType: 'SummaryRow', Cells: [{ Value: 'Total Cost of Sales' }, { Value: '30000.00' }] },
          ],
        },
        // Untitled, and a COMPUTED total: nothing beneath it to add up.
        {
          RowType: 'Section',
          Title: '',
          Rows: [
            { RowType: 'SummaryRow', Cells: [{ Value: 'Gross Profit' }, { Value: '70000.00' }] },
          ],
        },
        // A second untitled section. Merging this with the one above is the bug.
        {
          RowType: 'Section',
          Title: '',
          Rows: [
            { RowType: 'SummaryRow', Cells: [{ Value: 'Net Profit' }, { Value: '20705.02' }] },
          ],
        },
      ],
    }],
  };

  test('an untitled section is named by its own summary row', () => {
    const parsed = parseProfitAndLoss(report);
    const sections = [...new Set(parsed.lines.map(l => l.section))];
    assert.ok(sections.includes('Gross Profit'), `got ${sections.join(', ')}`);
    assert.ok(sections.includes('Net Profit'));
    assert.ok(!sections.includes('Uncategorised'), 'untitled sections were merged again');
  });

  test('two untitled sections stay apart', () => {
    const parsed = parseProfitAndLoss(report);
    const grossProfit = parsed.lines.filter(l => l.section === 'Gross Profit');
    const netProfit = parsed.lines.filter(l => l.section === 'Net Profit');
    assert.equal(grossProfit.length, 1);
    assert.equal(netProfit.length, 1);
  });

  test('a computed total is not reconciled against a sum of nothing', () => {
    // Gross Profit is derived from other sections. Comparing it to the sum of
    // its own (empty) detail lines compares 70,000 against 0 and refuses every
    // P&L Xero has ever produced.
    const checks = reconcileSections(parseProfitAndLoss(report).lines);
    assert.ok(!checks.some(c => c.section === 'Gross Profit'));
    assert.ok(!checks.some(c => c.section === 'Net Profit'));
  });

  test('the real sections still reconcile', () => {
    const checks = reconcileSections(parseProfitAndLoss(report).lines);
    assert.equal(checks.length, 2);
    assert.ok(checks.every(c => c.passed), JSON.stringify(checks));
  });

  test('an untitled section with no summary row falls back to its position', () => {
    const odd = {
      Reports: [{
        Rows: [{
          RowType: 'Section',
          Title: '',
          Rows: [{ RowType: 'Row', Cells: [{ Value: 'Something' }, { Value: '1.00' }] }],
        }],
      }],
    };
    // Ugly, but distinct. Two sections that cannot be told apart is worse than
    // one with an ugly name.
    assert.equal(parseProfitAndLoss(odd).lines[0].section, 'Section 1');
  });
});
