import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildDashboardWorkbook } from './dashboard-export.js';

const move = (pct: number | null) => ({ delta: null, pct, direction: pct === null ? 'unknown' : 'up' });
const venue = (name: string, slug: string, net: number) => ({
  venue_id: slug, venue: name, slug, gross_sales: net * 0.9, food_bev_sales: net * 0.9, food_sales: net * 0.5, beverage_sales: net * 0.4,
  food_pct: 55.6, net_sales: net, service_charge: net * 0.09, total_discounts: 120, discount_rate_pct: 1.5,
  covers: 300, transactions: 90, avg_spend_per_head: 61.2, avg_check: 180.5, trading_days: 6, closed_days: ['2026-10-11'],
  prior: { net_sales: net - 1000, covers: 280, avg_spend_per_head: 60 },
  change: { net_sales: move(5.2), covers: move(7.1), avg_spend_per_head: move(null) },
  daily: [{ date: '2026-10-05', net_sales: 3000, gross_sales: 2700, food_sales: 1500, beverage_sales: 1200, covers: 50 },
          { date: '2026-10-11', net_sales: null, gross_sales: null, food_sales: null, beverage_sales: null, covers: null }],
});

test('the export carries the page\'s own figures, per venue and for the group, by day, with definitions', async () => {
  const np = venue('Neon Pigeon', 'neon-pigeon', 20000);
  const fp = venue('Fat Prince', 'fat-prince', 30000);
  const group = { ...venue('Group', 'group', 50000) };
  const payload: any = {
    window: { kind: 'wtd', label: 'Week to date', current: { start: '2026-10-05', end: '2026-10-11' }, prior: { start: '2025-09-28', end: '2026-10-04' }, warnings: ['Runs to 2026-10-11.'] },
    venues: [np, fp], group, period_costs: null, costs: null,
  };
  const wb = await buildDashboardWorkbook(payload, '12 Oct 2026');
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(await wb.xlsx.writeBuffer() as any);
  assert.deepEqual(back.worksheets.map(w => w.name), ['Summary', 'Daily', 'Costs']);

  const s = back.getWorksheet('Summary')!;
  const names: string[] = [];
  s.eachRow(r => { names.push(String(r.getCell(1).value ?? '')); });
  assert.ok(names.includes('Group') && names.includes('Neon Pigeon') && names.includes('Fat Prince'));
  let npNet: unknown = null;
  s.eachRow(r => { if (r.getCell(1).value === 'Neon Pigeon') npNet = r.getCell(2).value; });
  assert.equal(npNet, 20000);
  assert.ok(names.some(n => n.startsWith('Net sales:')), 'definitions travel with the figures');

  // A closed day is a blank, never a zero.
  const d = back.getWorksheet('Daily')!;
  let closed: unknown = 'unset';
  d.eachRow(r => { if (r.getCell(2).value === '2026-10-11' && r.getCell(1).value === 'Neon Pigeon') closed = r.getCell(3).value; });
  assert.equal(closed, null);
});
