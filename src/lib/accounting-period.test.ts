import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDateFor, isPeriodClosed, isSettled, latestClosedMonth,
  CLOSE_DAY_OF_FOLLOWING_MONTH, SETTLING_WORKING_DAYS,
} from './accounting-period.js';

/**
 * BUILD_LOG 2.5. The lock used to fire the moment the Monday board first
 * matched Revel, which froze whatever we held and rejected every later
 * correction. The board would be right and the warehouse permanently wrong.
 *
 * The real rule is a monthly close: final from the middle of the following
 * month. Everything before that is open and corrections belong in the
 * warehouse, not in an alert.
 */

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('closeDateFor — the month after, mid-month', () => {
  test('July closes in August', () => {
    assert.equal(closeDateFor('2026-07-16'), '2026-08-15');
    assert.equal(closeDateFor('2026-07-01'), '2026-08-15');
    assert.equal(closeDateFor('2026-07-31'), '2026-08-15');
  });

  test('every day of a month shares one close date', () => {
    // The rule is about the month, not the day. A late-month trading day is
    // not given less time to settle than an early one.
    const closes = new Set(
      Array.from({ length: 28 }, (_, i) => closeDateFor(`2026-02-${String(i + 1).padStart(2, '0')}`)),
    );
    assert.deepEqual([...closes], ['2026-03-15']);
  });

  test('December rolls into the next year', () => {
    assert.equal(closeDateFor('2026-12-31'), '2027-01-15');
  });

  test('the close day is the one constant to change', () => {
    assert.equal(closeDateFor('2026-07-16').slice(-2), String(CLOSE_DAY_OF_FOLLOWING_MONTH));
  });

  test('refuses a date it cannot read rather than guessing', () => {
    // A guessed close date decides whether real figures are frozen.
    assert.throws(() => closeDateFor('16/07/2026'), /expected YYYY-MM-DD/);
    assert.throws(() => closeDateFor(''), /expected YYYY-MM-DD/);
    assert.throws(() => closeDateFor('2026-13-01'), /month out of range/);
  });
});

describe('isPeriodClosed — open until the close date arrives', () => {
  test('a July day is open through to 14 August', () => {
    assert.equal(isPeriodClosed('2026-07-16', at('2026-08-14')), false);
  });

  test('and closed on the 15th itself', () => {
    // The close date is inclusive: on the 15th, July is done.
    assert.equal(isPeriodClosed('2026-07-16', at('2026-08-15')), true);
    assert.equal(isPeriodClosed('2026-07-16', at('2026-08-16')), true);
  });

  test('the current month is always open', () => {
    assert.equal(isPeriodClosed('2026-08-04', at('2026-08-17')), false);
  });

  test('the Fat Prince days that went stale were all still open', () => {
    // Every one of these was frozen by the old rule and reported to Finance as
    // a discrepancy, while the venue had already corrected the board. Under the
    // close rule none of them were locked and the corrections would have landed.
    for (const d of ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-13']) {
      assert.equal(isPeriodClosed(d, at('2026-08-17')), false, d);
    }
  });

  test('last year stays closed', () => {
    assert.equal(isPeriodClosed('2025-11-26', at('2026-08-17')), true);
  });

  test('December closes in the new year, not the old one', () => {
    assert.equal(isPeriodClosed('2026-12-20', at('2027-01-14')), false);
    assert.equal(isPeriodClosed('2026-12-20', at('2027-01-15')), true);
  });
});

/**
 * Finance does not reconcile daily and does not work weekends. Friday's sales
 * are not touched until Monday, so anything comparing Friday against Revel on
 * Saturday disagrees with work nobody has started. Those days must not alert.
 */
describe('isSettled — has Finance had time to look at it?', () => {
  // 2026-08-07 is a Friday. 8th Sat, 9th Sun, 10th Mon, 11th Tue.
  const friday = '2026-08-07';

  test('the weekend does not count', () => {
    assert.equal(isSettled(friday, at('2026-08-08')), false, 'Saturday');
    assert.equal(isSettled(friday, at('2026-08-09')), false, 'Sunday');
  });

  test('one or two working days is not enough on its own', () => {
    assert.equal(isSettled(friday, at('2026-08-10')), false, 'Monday');
    assert.equal(isSettled(friday, at('2026-08-11')), false, 'Tuesday');
  });

  test('Friday settles on Wednesday', () => {
    assert.equal(isSettled(friday, at('2026-08-12')), true);
  });

  test('a Monday settles on Thursday', () => {
    // 2026-08-03 is a Monday: Tue 4, Wed 5 and Thu 6 are the three working days.
    assert.equal(isSettled('2026-08-03', at('2026-08-05')), false);
    assert.equal(isSettled('2026-08-03', at('2026-08-06')), true);
  });

  test('today is never settled', () => {
    assert.equal(isSettled('2026-08-17', at('2026-08-17')), false);
  });

  test('a long-past date is settled without spinning', () => {
    assert.equal(isSettled('2022-06-07', at('2026-08-17')), true);
  });

  test('the window is one constant to change', () => {
    assert.equal(SETTLING_WORKING_DAYS, 3);
  });

  test('refuses a date it cannot read', () => {
    assert.throws(() => isSettled('7 Aug 2026', at('2026-08-17')), /expected YYYY-MM-DD/);
  });
});

// --- latestClosedMonth -----------------------------------------------------

/**
 * The engine reported July's operating profit as fact and was right only by
 * luck of the calendar — the run fell after 15 August. A fortnight earlier it
 * would have said the same about a month still being worked on.
 */
test('after the 15th, last month is settled', () => {
  assert.equal(latestClosedMonth(new Date('2026-08-26T00:00:00Z')), '2026-07-01');
  assert.equal(latestClosedMonth(new Date('2026-08-15T00:00:00Z')), '2026-07-01');
});

test('before the 15th it is the month BEFORE last', () => {
  // The trap: on 1 September, August has not closed and July is the newest
  // month anyone may draw a conclusion from.
  assert.equal(latestClosedMonth(new Date('2026-09-01T00:00:00Z')), '2026-07-01');
  assert.equal(latestClosedMonth(new Date('2026-08-14T00:00:00Z')), '2026-06-01');
});

test('the current month is never settled', () => {
  for (const day of ['2026-08-01', '2026-08-15', '2026-08-31']) {
    assert.notEqual(latestClosedMonth(new Date(`${day}T00:00:00Z`)), '2026-08-01');
  }
});

test('January looks back into the previous year', () => {
  assert.equal(latestClosedMonth(new Date('2027-01-20T00:00:00Z')), '2026-12-01');
  assert.equal(latestClosedMonth(new Date('2027-01-05T00:00:00Z')), '2026-11-01');
});

test('it agrees with isPeriodClosed, which is the rule of record', () => {
  const asOf = new Date('2026-09-01T00:00:00Z');
  const latest = latestClosedMonth(asOf);

  assert.ok(isPeriodClosed(latest, asOf), 'the month it returns must be closed');

  const next = new Date(`${latest}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  assert.ok(!isPeriodClosed(next.toISOString().slice(0, 10), asOf), 'the month after must be open');
});
