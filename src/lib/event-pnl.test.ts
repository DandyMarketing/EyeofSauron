/**
 * The event P&L, built from Khai's NYE 2026 template (12 Oct 2026). That file
 * showed a 75% profit because its product cost row had no formula; the first
 * test here is that product cost is never silently zero again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildEventPnlWorkbook, computePnl, withStandardLines, type EventPnlInput, type VenueRates } from './event-pnl.js';

const rates: VenueRates = {
  food_cost: { value: 0.2559, label: 'Food cost, Jun-Sep 2026 (Xero + Revel)', basis: 'our data' },
  drink_cost: { value: 0.2151, label: 'Drink cost, Jun-Sep 2026 (Xero + Revel)', basis: 'our data' },
  food_share: { value: 0.5, label: 'Food share of F&B sales', basis: 'our data' },
  group_fees: { value: 0.0506, label: 'Management + licensing fees, % of income', basis: 'our data' },
  card_fees: { value: null, label: 'Ticketing platform and card rate -- nobody has a quote yet', basis: 'to fill' },
};

// The template's own programming, first floor and sixth floor.
const nye: EventPnlInput = {
  name: 'Neon Pigeon NYE 2026',
  venues: ['Neon Pigeon'],
  dates: '31 Dec 2026',
  service_charge_pct: 10,
  programming: [
    { floor: '1st Floor', time: '5.30pm - 8pm', concept: 'Dinner', covers: 37, per_person: 128, cost_basis: 'food', target_market: 'Early diners', comments: '1.5 turns', basis: 'proposal' },
    { floor: '1st Floor', time: '8pm - 10pm', concept: 'Dinner', covers: 74, per_person: 128, cost_basis: 'food', basis: 'proposal' },
    { floor: '1st Floor', time: '10pm - 12am', concept: 'Dinner', covers: 37, per_person: 128, cost_basis: 'food', basis: 'proposal' },
    { floor: '1st Floor', time: '12am - 3am', concept: 'Hip Hop DJ', covers: 70, per_person: 40, cost_basis: 'none', basis: 'proposal' },
    { floor: '6th Floor', time: '5.30pm - 8pm', concept: 'Dinner', covers: 60, per_person: 128, cost_basis: 'food', basis: 'proposal' },
    { floor: '6th Floor', time: '10pm - 12am', concept: 'Free flow 2 hours', covers: 100, per_person: 108, cost_basis: 'drink', basis: 'proposal' },
    { floor: '6th Floor', time: '10pm - 12am', concept: 'VIP table', covers: 2, per_person: 2500, cost_basis: 'drink', basis: 'proposal' },
    { floor: '6th Floor', time: '12am - 3am', concept: 'Star DJ', covers: 120, per_person: 70, cost_basis: 'none', basis: 'proposal' },
  ],
  costs: [
    { section: 'furniture', item: 'DJ equipment rental', qty: 1, unit_price: 1200, basis: 'proposal' },
    { section: 'operating', item: 'Rental', qty: 1, unit_price: 2400, basis: 'proposal' },
    { section: 'entertainment', item: 'Opening DJ for Star DJ', qty: 1, unit_price: 1000, basis: 'proposal' },
    { section: 'entertainment', item: 'Hip Hop DJ', qty: 1, unit_price: 2000, basis: 'proposal' },
    { section: 'entertainment', item: 'Star house DJ', qty: 1, unit_price: 7500, basis: 'proposal' },
    { section: 'labour', item: 'Part-timers', qty: 8, hours: 16, unit_price: 14, note: '8 staff x 16 h x $14', basis: 'proposal' },
  ],
};

test('product cost is computed on every revenue line, never left at zero', () => {
  const p = computePnl(nye, rates);
  // $53,624. The template showed $45,944 because its 6th-floor 5.30pm dinner
  // (60 x $128 = $7,680) had no Total formula -- built here, every slot counts.
  assert.equal(p.gross, 45944 + 7680);
  // Food on the dinners, drink on free flow and tables, nothing on door entry.
  const food = (37 + 74 + 37 + 60) * 128 * 0.2559;
  const drink = (100 * 108 + 2 * 2500) * 0.2151;
  assert.equal(p.product_cost, Math.round((food + drink) * 100) / 100);
  assert.ok(p.product_cost > 9000, 'the template showed $0 here');
  assert.equal(p.group_fees, Math.round(53624 * 0.0506 * 100) / 100);
  // The template's 75% margin is gone.
  assert.ok(p.profit / p.nett < 0.6);
});

test('a missing standard cost is a visible blank, not an absence', () => {
  const lines = withStandardLines(nye.costs);
  for (const item of ['Paid ads', 'Promoter commission', 'Security']) {
    const l = lines.find(c => c.item.startsWith(item));
    assert.ok(l, `${item} missing`);
    assert.equal(l!.basis, 'to fill');
  }
  // Not duplicated when the conversation already priced it.
  const withAds = withStandardLines([{ section: 'marketing', item: 'Instagram ads', qty: 1, unit_price: 800, basis: 'proposal' }]);
  assert.equal(withAds.filter(c => c.section === 'marketing').length, 1);
});

test('scenarios scale revenue and product cost, not the fixed costs', () => {
  const p = computePnl(nye, rates);
  const full = p.scenarios.find(s => s.pct === 1)!;
  assert.equal(full.profit, p.profit);
  const sixty = p.scenarios.find(s => s.pct === 0.6)!;
  assert.equal(sixty.profit, Math.round((p.nett * 0.6 - p.variable * 0.6 - p.fixed) * 100) / 100);
});

test('the workbook carries live formulas with their results, and every line its basis', async () => {
  const wb = await buildEventPnlWorkbook(nye, rates, '12 Oct 2026');
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as any);
  const ws = back.getWorksheet('P&L')!;
  assert.ok(back.getWorksheet('Assumptions'));

  const p = computePnl(nye, rates);
  let profitCell: any = null, productCell: any = null;
  ws.eachRow(row => {
    const a = String(row.getCell(1).value ?? '');
    if (a === 'Profit & Loss') profitCell = row.getCell(5).value;
    if (a.startsWith('Food & drink cost')) productCell = row.getCell(5).value;
  });
  assert.ok(profitCell?.formula, 'profit is a formula');
  assert.equal(Number(profitCell.result), p.profit);
  assert.match(productCell.formula, /^P\d+$/, 'product cost reads the programming total');
  assert.equal(Number(productCell.result), p.product_cost);

  // A drink line's product cost references the drink rate on Assumptions.
  let freeFlow: any = null;
  ws.eachRow(row => { if (row.getCell(12).value === 'Free flow 2 hours') freeFlow = row.getCell(16).value; });
  assert.match(freeFlow.formula, /Assumptions!\$B\$5/);

  // The unpriced card-fee rate is marked, not hidden.
  const as = back.getWorksheet('Assumptions')!;
  assert.equal(as.getCell('C8').value, 'to fill');
});
