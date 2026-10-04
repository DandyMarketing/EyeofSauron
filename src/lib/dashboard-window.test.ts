/**
 * The comparison a week-to-date dashboard gets wrong if nobody writes it down.
 *
 * Monday-to-Saturday against the WHOLE of last week is six days against seven,
 * and it shows a fall every day of every week except Sunday. That is the same
 * defect `lastCompleteWeek()` was written to avoid, approached from the other
 * side, and it would have been invisible: every number is real, the arithmetic
 * is right, and the answer is wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardWindow, daysSinceMonday, movement, sgtToday } from './dashboard-window.js';

describe('the window is like-for-like by weekday', () => {
  test('on a Saturday it is Mon-Sat against Mon-Sat', () => {
    // 2026-10-03 is a Saturday.
    const w = dashboardWindow('2026-10-03');
    assert.deepEqual(w.current, { start: '2026-09-28', end: '2026-10-03' });
    assert.deepEqual(w.prior, { start: '2026-09-21', end: '2026-09-26' });
    assert.equal(w.days, 6);
    assert.equal(w.thin, false);
  });

  test('both sides always span the same number of days', () => {
    // The single property that matters. Any date, any weekday.
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
      const w = dashboardWindow(d);
      const span = (a: string, b: string) =>
        (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000;
      assert.equal(
        span(w.current.start, w.current.end),
        span(w.prior.start, w.prior.end),
        `${d}: ${JSON.stringify(w)}`,
      );
    }
  });

  test('the prior window lands on the same weekdays, not merely the same length', () => {
    // Seven days back on both ends. Comparing Mon-Sat against Sun-Fri would be
    // the same length and still wrong — a Saturday against a Friday is not a
    // comparison in this business.
    const w = dashboardWindow('2026-10-03');
    const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    assert.equal(weekday(w.current.start), weekday(w.prior.start));
    assert.equal(weekday(w.current.end), weekday(w.prior.end));
  });

  test('on a Monday it is one day against one day, and says so', () => {
    // 2026-10-05 is a Monday. A single day against a single day is a coin toss
    // and the page must not draw an arrow on it.
    const w = dashboardWindow('2026-10-05');
    assert.deepEqual(w.current, { start: '2026-10-05', end: '2026-10-05' });
    assert.deepEqual(w.prior, { start: '2026-09-28', end: '2026-09-28' });
    assert.equal(w.days, 1);
    assert.equal(w.thin, true);
  });

  test('on a Sunday it is the full week against the full week', () => {
    // 2026-10-04 is a Sunday — the one day where week-to-date is a whole week.
    const w = dashboardWindow('2026-10-04');
    assert.equal(w.days, 7);
    assert.deepEqual(w.current, { start: '2026-09-28', end: '2026-10-04' });
    assert.deepEqual(w.prior, { start: '2026-09-21', end: '2026-09-27' });
  });

  test('a week spanning a month end is still seven days back', () => {
    const w = dashboardWindow('2026-11-03');     // Tuesday
    assert.deepEqual(w.prior, { start: '2026-10-26', end: '2026-10-27' });
  });

  test('daysSinceMonday counts from Monday', () => {
    assert.equal(daysSinceMonday('2026-10-05'), 0);   // Monday
    assert.equal(daysSinceMonday('2026-10-04'), 6);   // Sunday
    assert.throws(() => daysSinceMonday('not-a-date'));
  });
});

describe('the business date is Singapore\'s, not the server\'s', () => {
  test('a UTC evening is already tomorrow in Singapore', () => {
    /**
     * Railway runs in UTC. At 23:00 UTC it is 07:00 the next day in Singapore,
     * and the warehouse stores a business DATE. Using the server's calendar day
     * would show an empty current week every evening, Singapore time — which
     * reads as a venue that has stopped trading.
     */
    assert.equal(sgtToday(new Date('2026-10-03T23:30:00Z')), '2026-10-04');
    assert.equal(sgtToday(new Date('2026-10-03T15:59:00Z')), '2026-10-03');
    // 16:00 UTC is midnight SGT — the boundary itself.
    assert.equal(sgtToday(new Date('2026-10-03T16:00:00Z')), '2026-10-04');
  });
});

describe('movement', () => {
  test('reports the change and its direction', () => {
    assert.deepEqual(movement(110, 100), { delta: 10, pct: 10, direction: 'up' });
    assert.deepEqual(movement(90, 100), { delta: -10, pct: -10, direction: 'down' });
    assert.equal(movement(100.01, 100).direction, 'flat');
  });

  test('an absent prior period is unknown, never zero change', () => {
    // Zero means "no change", which is a measurement. A venue with no data last
    // week has not stayed flat.
    assert.equal(movement(100, null).direction, 'unknown');
    assert.equal(movement(null, 100).pct, null);
  });

  test('a rise from zero is unknown, not infinite', () => {
    // A venue closed all last week has not grown by an infinite percentage, and
    // printing one makes every other figure in the row look untrustworthy.
    assert.equal(movement(5000, 0).direction, 'unknown');
    assert.equal(movement(5000, 0).pct, null);
  });
});
