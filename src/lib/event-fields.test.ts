import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNumber, cleanEventNumbers, cleanDraft } from './event-fields.js';

test('a sentence in a number field is dropped and named, not stored and not fatal', () => {
  // 13 Oct 2026: break_even_covers = "NA - break-even expressed as revenue: ..."
  const r = cleanEventNumbers({
    break_even_covers: 'NA - break-even expressed as revenue: $24,000 cost envelope',
    target_net_sales: '$30,000',
    target_covers: 279.6,
    price: 128,
    ad_budget: null,
  });
  assert.equal(r.values.break_even_covers, null);
  assert.equal(r.values.target_net_sales, 30000);
  assert.equal(r.values.target_covers, 280);
  assert.equal(r.values.price, 128);
  assert.equal(r.values.ad_budget, null);
  assert.deepEqual(r.dropped, ['break-even covers']);
});

test('numbers read plainly, everything else is nothing', () => {
  assert.deepEqual(toNumber('1,200', true), { value: 1200, dropped: false });
  assert.deepEqual(toNumber(' -5.5 ', false), { value: -5.5, dropped: false });
  assert.deepEqual(toNumber('about 200', true), { value: null, dropped: true });
  assert.deepEqual(toNumber(undefined, false), { value: null, dropped: false });
  assert.deepEqual(toNumber(NaN, false), { value: null, dropped: true });
});

test('every field of a draft is checked against its kind of cell, and what is cleared is named', () => {
  const { draft, notes } = cleanDraft({
    name: 'Goodbye 2026', start_date: '2026-12-31', end_date: '31 Dec',
    venue_slugs: ['neon-pigeon', 7],
    break_even_covers: 'NA - break-even expressed as revenue',
    target_net_sales: '$30,000',
    tasks: [
      { description: 'Book the DJ', t_minus_days: 'about ten weeks', owner_name: 'Khai', kind: 'whatever' },
      { description: 'Roster', t_minus_days: '59', owner_name: 'Corbin' },
      { t_minus_days: 3 },
    ],
    other_spaces: [{ name: 'Barter rooftop', access: 'hired', cost: '$1,800', capacity: 'about 100' }],
    pnl: {
      service_charge_pct: '10',
      programming: [{ floor: 'Roof', covers: '180', per_person: 'TBC', cost_basis: 'drinks' }],
      costs: [{ item: 'DJ', unit_price: '8,000', section: 'talent' }],
    },
  });
  assert.equal(draft.end_date, undefined);
  assert.equal(draft.break_even_covers, undefined);
  assert.equal(draft.target_net_sales, 30000);
  assert.deepEqual(draft.venue_slugs, ['neon-pigeon']);
  assert.equal(draft.tasks.length, 2, 'a task with no description is not a task');
  assert.equal(draft.tasks[0].t_minus_days, undefined);
  assert.equal(draft.tasks[0].kind, 'other');
  assert.equal(draft.tasks[1].t_minus_days, 59);
  assert.equal(draft.other_spaces[0].access, 'rented');
  assert.equal(draft.other_spaces[0].cost, 1800);
  assert.equal(draft.other_spaces[0].capacity, undefined);
  assert.equal(draft.pnl.service_charge_pct, 10);
  assert.equal(draft.pnl.programming[0].covers, 180);
  assert.equal(draft.pnl.programming[0].per_person, undefined);
  assert.equal(draft.pnl.programming[0].cost_basis, 'none');
  assert.equal(draft.pnl.costs[0].unit_price, 8000);
  assert.equal(draft.pnl.costs[0].section, 'additional');
  for (const n of [/End date: "31 Dec" is not a date/, /Break-even covers: the draft wrote words/, /Tasks \(days before\): 1 value was words/,
    /Other spaces: 1 value was words/, /P&L revenue lines: 1 value was words/]) {
    assert.ok(notes.some(x => n.test(x)), `missing note ${n}`);
  }
});
