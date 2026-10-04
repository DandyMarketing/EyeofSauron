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
import {
  dashboardWindow, daysSinceMonday, movement, sgtToday,
  periodWindow, defaultPeriod, isPeriodKind, weekendDays,
} from './dashboard-window.js';

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

/**
 * The four periods, and the comparison each one is paired with.
 *
 * Every one of them can be got wrong the same way: a part-period against a
 * whole one. Week to date against a whole previous week shows a fall every day
 * except Sunday; month to date against a whole previous month does it on a
 * bigger scale and for three weeks at a time.
 */
describe('period windows', () => {
  test('last week is the completed Mon-Sun, against the one before', () => {
    // Asked on Saturday 3 Oct. The completed week is 21-27 Sep.
    const w = periodWindow('last_week', '2026-10-03');
    assert.deepEqual(w.current, { start: '2026-09-21', end: '2026-09-27' });
    assert.deepEqual(w.prior, { start: '2026-09-14', end: '2026-09-20' });
    assert.equal(w.days, 7);
    assert.equal(w.thin, false);
  });

  test('last week on a Monday is the week that ended yesterday', () => {
    /**
     * The case the business actually runs on. Khai reviews the previous week on
     * a Tuesday, and on Monday or Tuesday "week to date" is one or two days.
     */
    const mon = periodWindow('last_week', '2026-10-05');     // a Monday
    assert.deepEqual(mon.current, { start: '2026-09-28', end: '2026-10-04' });
    const tue = periodWindow('last_week', '2026-10-06');
    assert.deepEqual(tue.current, mon.current, 'Tuesday must review the same week as Monday');
  });

  test('month to date compares the same dates of the previous month', () => {
    const w = periodWindow('mtd', '2026-10-12');
    assert.deepEqual(w.current, { start: '2026-10-01', end: '2026-10-12' });
    assert.deepEqual(w.prior, { start: '2026-09-01', end: '2026-09-12' });
    assert.equal(w.days, 12);
  });

  test('month to date on the 31st does not land in the next month', () => {
    // 31 March minus a month is 28 February, not 3 March. A naive setMonth
    // rolls over and compares the wrong fortnight.
    const w = periodWindow('mtd', '2026-03-31');
    assert.equal(w.prior.end, '2026-02-28');
    assert.equal(w.prior.start, '2026-02-01');
  });

  test('last month is the completed month against the one before', () => {
    const w = periodWindow('last_month', '2026-10-04');
    assert.deepEqual(w.current, { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(w.prior, { start: '2026-08-01', end: '2026-08-31' });
    assert.equal(w.days, 30);
  });

  test('a different weekend count is WARNED about, not buried', () => {
    /**
     * Months are not the same length and do not hold the same number of
     * weekends. In this business a Saturday is worth considerably more than a
     * Tuesday, so a month that is "down" can simply have one fewer Saturday —
     * and nothing in the figures says so.
     */
    const w = periodWindow('last_month', '2026-10-04');
    const sep = weekendDays('2026-09-01', '2026-09-30');
    const aug = weekendDays('2026-08-01', '2026-08-31');
    if (sep !== aug) {
      assert.ok(w.warnings.some(x => /weekend days/.test(x)), w.warnings.join(' | '));
    }
  });

  test('a complete week against a complete week needs no caveat', () => {
    assert.deepEqual(periodWindow('last_week', '2026-10-03').warnings, []);
    assert.deepEqual(periodWindow('wtd', '2026-10-03').warnings, []);
  });

  test('every period compares equal spans', () => {
    const span = (a: string, b: string) =>
      (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000;
    for (const kind of ['wtd', 'last_week', 'mtd', 'last_month'] as const) {
      for (const day of ['2026-10-01', '2026-10-05', '2026-10-12', '2026-03-31', '2027-01-01']) {
        const w = periodWindow(kind, day);
        /**
         * Months are genuinely different lengths, so last_month and a
         * month-to-date landing on a date the previous month does not have
         * CANNOT be equal-span. The requirement there is that it SAYS so —
         * asserted below rather than waived here.
         */
        if (kind === 'last_month') continue;
        const equal = span(w.current.start, w.current.end) === span(w.prior.start, w.prior.end);
        if (!equal) {
          assert.ok(kind === 'mtd', `${kind} on ${day} compares unequal spans`);
          assert.ok(w.warnings.some(x => /days against/.test(x)),
            `${kind} on ${day} compares unequal spans and says nothing: ${JSON.stringify(w.warnings)}`);
          continue;
        }
        assert.ok(equal, `${kind} on ${day}: ${JSON.stringify(w)}`);
      }
    }
  });
});

describe('which period the page opens on', () => {
  test('Monday and Tuesday open on the completed week', () => {
    // "we usually go through our previous week on Tuesday" — and week to date
    // on a Tuesday is two days of trade.
    assert.equal(defaultPeriod('2026-10-05'), 'last_week');   // Monday
    assert.equal(defaultPeriod('2026-10-06'), 'last_week');   // Tuesday
  });

  test('from Wednesday the week in progress takes over', () => {
    assert.equal(defaultPeriod('2026-10-07'), 'wtd');
    assert.equal(defaultPeriod('2026-10-04'), 'wtd');         // Sunday
  });
});

test('an unknown period string is rejected rather than defaulted', () => {
  // It arrives from a query parameter, so it is user input. Falling back
  // silently would show one period under another one's label.
  assert.equal(isPeriodKind('wtd'), true);
  assert.equal(isPeriodKind('last_week'), true);
  assert.equal(isPeriodKind('year'), false);
  assert.equal(isPeriodKind(undefined), false);
});

test('a month-end comparison against a shorter month says so in days', () => {
  /**
   * 31 March minus a month is 28 February, because February has no 31st. So
   * month to date on the 31st compares 31 days of trade against 28 — about 10%
   * more trading, which lands as growth and is purely the calendar.
   *
   * It cannot be fixed by truncating the current month: the reader asked for
   * month to date and hiding three days of it is the worse answer. So it is
   * stated, every time.
   */
  const w = periodWindow('mtd', '2026-03-31');
  assert.equal(w.prior.end, '2026-02-28');
  assert.ok(w.warnings.some(x => /31 days against 28/.test(x)), w.warnings.join(' | '));
});

test('February against January is flagged as a length difference', () => {
  const w = periodWindow('last_month', '2026-03-10');
  assert.deepEqual(w.current, { start: '2026-02-01', end: '2026-02-28' });
  assert.ok(w.warnings.some(x => /28 days against 31/.test(x)), w.warnings.join(' | '));
});
