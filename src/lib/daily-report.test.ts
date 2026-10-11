/**
 * The morning report compares three spans, and each has a way to be wrong
 * while every number in it is real: a week to date against a whole week, a
 * month against the same dates with a Saturday fewer, and a closed Sunday
 * reported as a Revel file that never came.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  reportWindows, reportDay, spanFigures, composeVenueReport, dayLabel, spanLabel, type SalesDay,
} from './daily-report.js';
import type { CoversSummary } from './covers.js';
import { weekdayOf } from '../ingest/closures.js';

const row = (date: string, gross: number, net: number, bills = 10): SalesDay => ({
  business_date: date, gross_sales: gross, net_sales: net, item_discounts: 0, order_discounts: 0, total_transactions: bills,
});

const coversMap = (entries: Array<[string, number, number?]>) => new Map<string, CoversSummary>(
  entries.map(([d, c, expected]) => [d, {
    business_date: d, covers: c, booked_covers: c, walk_in_covers: 0, cancelled_covers: 0, no_show_covers: 0,
    by_shift: {}, bookings: 1, expected_covers: expected ?? c, expected_by_shift: {}, expected_bookings: 1,
  }]),
);

const venue = { id: 'v1', name: 'Firangi Superstar', slug: 'firangi' };

describe('the three windows are like for like by weekday', () => {
  test('a Saturday: same day last week, Mon–Sat, and month to date four weeks back', () => {
    const w = reportWindows('2026-10-10');
    assert.deepEqual(w.day, { current: { start: '2026-10-10', end: '2026-10-10' }, prior: { start: '2026-10-03', end: '2026-10-03' }, days: 1 });
    assert.deepEqual(w.wtd.current, { start: '2026-10-05', end: '2026-10-10' });
    assert.deepEqual(w.wtd.prior, { start: '2026-09-28', end: '2026-10-03' });
    assert.equal(w.wtd.days, 6);
    // Khai, 11 Oct 2026: four weeks earlier, not the same dates last month.
    assert.deepEqual(w.mtd.current, { start: '2026-10-01', end: '2026-10-10' });
    assert.deepEqual(w.mtd.prior, { start: '2026-09-03', end: '2026-09-12' });
    assert.equal(w.mtd.days, 10);
  });

  test('the month comparison keeps every weekday paired', () => {
    for (const day of ['2026-10-10', '2026-10-28', '2026-10-29', '2026-10-31', '2026-02-28']) {
      const m = reportWindows(day).mtd;
      assert.equal(weekdayOf(m.prior.start), weekdayOf(m.current.start), day);
      assert.equal(weekdayOf(m.prior.end), weekdayOf(m.current.end), day);
    }
  });

  test('past the 28th it shifts five weeks, so the comparison never overlaps the month', () => {
    const m = reportWindows('2026-10-31').mtd;
    assert.equal(m.days, 31);
    assert.ok(m.prior.end < m.current.start, `${m.prior.end} overlaps ${m.current.start}`);
    assert.deepEqual(m.prior, { start: '2026-08-27', end: '2026-09-26' });
  });
});

describe('which day the report runs to', () => {
  test('yesterday is in: report on it', () => {
    assert.deepEqual(reportDay('2026-10-10', '2026-10-10', []), { day: '2026-10-10', status: 'ok' });
  });

  test('a closed Sunday has no row, and is closed rather than late', () => {
    // Monday 12 Oct: Firangi shut Sunday, so Saturday is the newest row.
    assert.deepEqual(reportDay('2026-10-11', '2026-10-10', [6]), { day: '2026-10-11', status: 'closed' });
  });

  test('a missing file cuts the report to the last day there is', () => {
    assert.deepEqual(reportDay('2026-10-10', '2026-10-09', []), { day: '2026-10-09', status: 'late' });
    // Closed Sunday AND a missing Saturday is still late, not closed.
    assert.deepEqual(reportDay('2026-10-11', '2026-10-09', [6]), { day: '2026-10-09', status: 'late' });
  });

  test('a venue with no sales at all says so', () => {
    assert.deepEqual(reportDay('2026-10-10', null, []), { day: null, status: 'no_data' });
  });
});

describe('span figures', () => {
  test('a closed day is neither trade nor zero, and spend per head is F&B over covers', () => {
    const rows = [row('2026-10-05', 1000, 1100), row('2026-10-06', 0, 0, 0), row('2026-10-07', 2000, 2200)];
    const f = spanFigures(rows, coversMap([['2026-10-05', 20], ['2026-10-07', 40]]), { start: '2026-10-05', end: '2026-10-07' });
    assert.equal(f.net_sales, 3300);
    assert.equal(f.trading_days, 2);
    assert.equal(f.covers, 60);
    assert.equal(f.spend_per_head, 50);
  });

  test('nothing traded is null, and no SevenRooms is null covers -- never zero', () => {
    const f = spanFigures([row('2026-10-06', 0, 0, 0)], new Map(), { start: '2026-10-05', end: '2026-10-07' });
    assert.equal(f.net_sales, null);
    assert.equal(f.covers, null);
    assert.equal(f.spend_per_head, null);
  });
});

describe('the composed report', () => {
  const rows = [
    row('2026-09-03', 900, 1000), row('2026-09-12', 900, 1000),
    row('2026-09-28', 900, 1000), row('2026-10-03', 900, 1000),
    row('2026-10-01', 990, 1100), row('2026-10-05', 990, 1100), row('2026-10-10', 990, 1100),
  ];

  test('a Sunday morning reads yesterday, week to date, month to date and tonight', () => {
    const r = composeVenueReport({
      venue, today: '2026-10-11', closedWeekdays: [], rows,
      covers: coversMap([['2026-10-10', 30], ['2026-10-03', 25], ['2026-10-11', 0, 118]]), lastDataDate: '2026-10-10',
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.day?.now.net_sales, 1100);
    assert.equal(r.day?.net_sales_change_pct, 10);
    assert.equal(r.tonight.booked, 118);
    assert.match(r.text, /\*Yesterday\* \(Sat 10 Oct\): \$1,100 \(\+10% vs Sat 3 Oct\) · 30 covers \(\+20%\)/);
    assert.match(r.text, /\*Week to date\* \(5–10 Oct\): \$2,200 \(−29% vs 28 Sep–3 Oct\)/);
    assert.match(r.text, /\*Month to date\* \(1–10 Oct\): \$4,300 \(\+115% vs 3–12 Sep\) · 55 covers\n/);
    assert.match(r.text, /\*Tonight\*: 118 covers booked/);
  });

  test('a one-day week is not printed twice', () => {
    const r = composeVenueReport({
      venue, today: '2026-10-06', closedWeekdays: [], rows, covers: new Map(), lastDataDate: '2026-10-05',
    });
    assert.equal(r.wtd, null);
    assert.ok(r.mtd);
    assert.doesNotMatch(r.text, /Week to date/);
  });

  test('closed tonight and closed yesterday are said, not shown as zero', () => {
    const r = composeVenueReport({
      venue, today: '2026-10-12', closedWeekdays: [6, 0], rows, covers: coversMap([['2026-10-10', 30]]), lastDataDate: '2026-10-10',
    });
    assert.equal(r.status, 'closed');
    assert.equal(r.tonight.closed, true);
    assert.match(r.text, /\*Yesterday\* \(Sun 11 Oct\): closed/);
    assert.match(r.text, /\*Tonight\*: closed/);
  });

  test('a late file is named in the message', () => {
    const r = composeVenueReport({
      venue, today: '2026-10-11', closedWeekdays: [], rows, covers: new Map(), lastDataDate: '2026-10-05',
    });
    assert.equal(r.status, 'late');
    assert.match(r.text, /Revel's file for Sat 10 Oct has not arrived\. Figures run to Mon 5 Oct\./);
    assert.match(r.text, /\*Tonight\*: no SevenRooms data/);
  });
});

test('labels', () => {
  assert.equal(dayLabel('2026-10-10'), 'Sat 10 Oct');
  assert.equal(spanLabel({ start: '2026-10-05', end: '2026-10-10' }), '5–10 Oct');
  assert.equal(spanLabel({ start: '2026-09-28', end: '2026-10-03' }), '28 Sep–3 Oct');
});
