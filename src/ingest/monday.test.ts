import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, summarisePostLockChange, cleanFinanceNote } from './monday.js';

/**
 * BUILD_LOG 2.1. A Monday.com item was literally named "2925-12-30 Tuesday".
 * The parser checked the date was syntactically valid — which it is — and
 * accepted it, landing a row a thousand years in the future.
 *
 * The general rule these cover: syntactic validity is not correctness. Any
 * hand-entered field needs a plausibility bound, not just a format check.
 */

describe('parseDate — the formats staff actually type', () => {
  test('ISO', () => {
    assert.equal(parseDate('2026-07-16'), '2026-07-16');
  });

  test('day/month/year, not month/day/year', () => {
    // Singapore writes 16/07/2026. Read the American way this becomes an
    // invalid month and silently disappears.
    assert.equal(parseDate('16/07/2026'), '2026-07-16');
    assert.equal(parseDate('16/07/26'), '2026-07-16');
  });

  test('spelled-out months, long and short', () => {
    assert.equal(parseDate('16 Jul 2026'), '2026-07-16');
    assert.equal(parseDate('16 July 2026'), '2026-07-16');
    assert.equal(parseDate('16-Jul-2026'), '2026-07-16');
  });

  test('a trailing weekday is stripped', () => {
    assert.equal(parseDate('2026-07-16 Thursday'), '2026-07-16');
    assert.equal(parseDate('16 Jul 2026 Thu'), '2026-07-16');
  });
});

describe('parseDate — plausibility, not just syntax', () => {
  test('rejects the typo that caused the defect', () => {
    // "2925-12-30" is a perfectly valid date. It is not a plausible one.
    assert.equal(parseDate('2925-12-30'), null);
    assert.equal(parseDate('2925-12-30 Tuesday'), null);
  });

  test('rejects years before the business existed', () => {
    assert.equal(parseDate('2014-12-31'), null);
    assert.equal(parseDate('2015-01-01'), '2015-01-01');
  });

  test('allows next year but not the one after', () => {
    // Forward bookings are real; a decade out is a typo.
    const nextYear = new Date().getFullYear() + 1;
    assert.equal(parseDate(`${nextYear}-01-01`), `${nextYear}-01-01`);
    assert.equal(parseDate(`${nextYear + 1}-01-01`), null);
  });

  test('rejects a day that does not exist in that month', () => {
    assert.equal(parseDate('2026-02-30'), null);
    assert.equal(parseDate('2026-02-29'), null); // 2026 is not a leap year
    assert.equal(parseDate('2024-02-29'), '2024-02-29');
  });

  test('returns null for anything it cannot read, rather than guessing', () => {
    // The caller falls back to the item's created_at. A wrong guess here
    // would file a day's takings against the wrong date.
    assert.equal(parseDate('bluesheets_21feb_lunch'), null);
    assert.equal(parseDate('new item'), null);
    assert.equal(parseDate(''), null);
  });
});

/**
 * "Notes for Finance" is where the venues explain a day. We were not reading
 * it, and it cost us: Neon Pigeon wrote "Extra Items $84.00 For beverage" on
 * 1 Aug 2026, which was exactly the $84 we had written up as unexplained and
 * put in front of the finance department.
 *
 * Most days say "NA". Storing that makes every row look like it carries an
 * explanation and buries the few that do.
 */
describe('cleanFinanceNote', () => {
  test('keeps what the venue actually wrote', () => {
    assert.equal(cleanFinanceNote('Extra Items $84.00 For beverage'), 'Extra Items $84.00 For beverage');
    assert.equal(cleanFinanceNote('$699 Wrongly closed under cash'), '$699 Wrongly closed under cash');
    assert.equal(
      cleanFinanceNote('  François (LANDLORD) - $168.00 (ORDER #364787 - F&B CREDIT)  '),
      'François (LANDLORD) - $168.00 (ORDER #364787 - F&B CREDIT)',
    );
  });

  test('drops the placeholders staff type when there is nothing to say', () => {
    for (const empty of ['NA', 'na', 'N/A', 'n/a', 'N.A.', 'nil', 'None', 'no', '-', '--', '.', '   ', '']) {
      assert.equal(cleanFinanceNote(empty), null, JSON.stringify(empty));
    }
  });

  test('missing is null, not the string "null"', () => {
    assert.equal(cleanFinanceNote(null), null);
    assert.equal(cleanFinanceNote(undefined), null);
  });

  test('a note that merely starts with "no" is kept', () => {
    // "No show for the 8pm booking" is a note. Matching a prefix rather than
    // the whole string would have thrown it away.
    assert.equal(cleanFinanceNote('No show for the 8pm booking'), 'No show for the 8pm booking');
    assert.equal(cleanFinanceNote('Nil stock of the special'), 'Nil stock of the special');
  });
});

/**
 * Post-lock changes are the alert that has actually fired in production:
 * someone edited Monday.com for three dates after they had been reconciled to
 * the cent against Revel and locked. The alert has to say WHAT changed, or a
 * person has to diff two boards by eye to find out whether it mattered.
 */
describe('summarisePostLockChange', () => {
  const locked = {
    dinner: { food_sales: 4000, bev_sales: 2000, covers: 80, service_charge: 600 },
  };

  test('reports a changed field with both values', () => {
    const changed = { dinner: { ...locked.dinner, food_sales: 4500 } };
    assert.deepEqual(summarisePostLockChange(locked, changed), [
      { period: 'dinner', field: 'food_sales', from: 4000, to: 4500 },
    ]);
  });

  test('reports nothing when nothing moved', () => {
    assert.deepEqual(summarisePostLockChange(locked, { dinner: { ...locked.dinner } }), []);
  });

  test('largest movement first', () => {
    // The change worth investigating is rarely the alphabetically first one.
    const changed = { dinner: { ...locked.dinner, service_charge: 610, food_sales: 8000 } };
    assert.deepEqual(
      summarisePostLockChange(locked, changed).map(c => c.field),
      ['food_sales', 'service_charge'],
    );
  });

  test('a meal period that appeared is reported against zero', () => {
    const changed = { ...locked, lunch: { food_sales: 900, covers: 20 } };
    const out = summarisePostLockChange(locked, changed);
    assert.ok(out.some(c => c.period === 'lunch' && c.field === 'food_sales' && c.from === 0 && c.to === 900));
  });

  test('a meal period that disappeared is reported too', () => {
    // Deleting a service is a bigger event than editing one, and would
    // otherwise be silent.
    const out = summarisePostLockChange(locked, {});
    assert.ok(out.some(c => c.period === 'dinner' && c.field === 'food_sales' && c.from === 4000 && c.to === 0));
  });

  test('sub-cent differences are ignored', () => {
    // Floating point, not an edit.
    const changed = { dinner: { ...locked.dinner, food_sales: 4000.001 } };
    assert.deepEqual(summarisePostLockChange(locked, changed), []);
  });

  test('a one-cent correction is still reported', () => {
    // Small but real, and the distinction from a $4,000 edit is the point.
    const changed = { dinner: { ...locked.dinner, food_sales: 4000.01 } };
    assert.equal(summarisePostLockChange(locked, changed).length, 1);
  });

  test('missing snapshots do not throw', () => {
    // Older alert rows may have been written without them.
    assert.deepEqual(summarisePostLockChange(null, null), []);
    assert.deepEqual(summarisePostLockChange(undefined, undefined), []);
    assert.equal(summarisePostLockChange(null, locked).length, 4);
  });
});
