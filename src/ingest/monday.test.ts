import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from './monday.js';

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
