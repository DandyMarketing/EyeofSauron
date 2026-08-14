import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { autoGranularity, bucketOf, isClosedDay, isPartialStart, isPartialEnd } from './charts.js';

/**
 * The pure chart functions. Each one below is where a defect in
 * docs/BUILD_LOG.md section 3 actually lived, and each is invisible when it
 * goes wrong — the chart still renders, it just means something else.
 */

describe('autoGranularity', () => {
  test('short ranges stay daily', () => {
    assert.equal(autoGranularity('2026-01-01', '2026-01-15'), 'day');
  });

  // The boundaries are the whole point: one day either side changes the shape
  // of every chart the model asks for without naming a granularity.
  test('35 days is still daily, 36 becomes weekly', () => {
    assert.equal(autoGranularity('2026-01-01', '2026-02-05'), 'day');
    assert.equal(autoGranularity('2026-01-01', '2026-02-06'), 'week');
  });

  test('120 days is still weekly, 121 becomes monthly', () => {
    assert.equal(autoGranularity('2026-01-01', '2026-05-01'), 'week');
    assert.equal(autoGranularity('2026-01-01', '2026-05-02'), 'month');
  });

  test('never chooses day_of_week on its own', () => {
    // It answers a different question, so it must only ever be asked for.
    const spans = ['2026-01-08', '2026-02-20', '2026-06-30', '2027-01-01'];
    for (const to of spans) {
      assert.notEqual(autoGranularity('2026-01-01', to), 'day_of_week');
    }
  });
});

describe('isClosedDay', () => {
  test('no money and no transactions means shut', () => {
    assert.equal(isClosedDay({ gross_sales: 0, total_transactions: 0 }), true);
  });

  test('a genuinely terrible day that still took a transaction is open', () => {
    // This is the distinction that matters: excluded from averages if shut,
    // included — and worth a recommendation — if open and selling nothing.
    assert.equal(isClosedDay({ gross_sales: 0, total_transactions: 3 }), false);
  });

  test('a trading day is open', () => {
    assert.equal(isClosedDay({ gross_sales: 5974, total_transactions: 283 }), false);
  });

  test('missing fields are treated as zero, not as trading', () => {
    assert.equal(isClosedDay({}), true);
    assert.equal(isClosedDay({ gross_sales: null, total_transactions: null }), true);
  });

  test('numeric strings from the warehouse are compared as numbers', () => {
    // Postgres numerics arrive as strings through PostgREST; '0' == 0 only
    // because of the Number() coercion, and '0.00' would be true under it too.
    assert.equal(isClosedDay({ gross_sales: '0', total_transactions: '0' }), true);
    assert.equal(isClosedDay({ gross_sales: '0.00', total_transactions: '0' }), true);
    assert.equal(isClosedDay({ gross_sales: '120.50', total_transactions: '4' }), false);
  });
});

describe('bucketOf', () => {
  test('month and day buckets are prefixes of the date', () => {
    assert.equal(bucketOf('2026-07-16', 'month'), '2026-07');
    assert.equal(bucketOf('2026-07-16', 'day'), '2026-07-16');
  });

  test('weekday is derived in UTC, not in the server’s local zone', () => {
    // 2026-07-16 is a Thursday. Parsed in a zone west of GMT it reads back as
    // Wednesday, which files a day's takings under the wrong weekday and is
    // undetectable in the output.
    assert.equal(bucketOf('2026-07-16', 'day_of_week'), 'Thursday');
  });

  test('a Monday is labelled Monday, not the Sunday before it', () => {
    assert.equal(bucketOf('2026-07-13', 'day_of_week'), 'Monday');
  });

  test('a Sunday is labelled Sunday', () => {
    assert.equal(bucketOf('2026-07-19', 'day_of_week'), 'Sunday');
  });

  test('weeks are labelled by their Monday', () => {
    assert.equal(bucketOf('2026-07-16', 'week'), '2026-07-13'); // Thursday
    assert.equal(bucketOf('2026-07-13', 'week'), '2026-07-13'); // the Monday itself
    assert.equal(bucketOf('2026-07-19', 'week'), '2026-07-13'); // the Sunday
  });
});

describe('partial bucket flags', () => {
  /**
   * BUILD_LOG 3.1: a range ending today leaves a stub final bucket, and two
   * days of August compared against full months reported −95.1% when the real
   * movement was +22%.
   */
  test('daily and weekday ranges are never partial', () => {
    for (const g of ['day', 'day_of_week'] as const) {
      assert.equal(isPartialStart('2026-07-16', g), false);
      assert.equal(isPartialEnd('2026-07-16', g), false);
    }
  });

  test('a month range starting mid-month is partial at the start', () => {
    assert.equal(isPartialStart('2026-07-16', 'month'), true);
    assert.equal(isPartialStart('2026-07-01', 'month'), false);
  });

  test('a month range stopping mid-month is partial at the end', () => {
    assert.equal(isPartialEnd('2026-08-02', 'month'), true);
    assert.equal(isPartialEnd('2026-07-31', 'month'), false);
  });

  test('month-end is checked against the real length of that month', () => {
    assert.equal(isPartialEnd('2026-02-28', 'month'), false); // 2026 is not a leap year
    assert.equal(isPartialEnd('2024-02-28', 'month'), true);  // 2024 is
    assert.equal(isPartialEnd('2024-02-29', 'month'), false);
  });

  test('a week range is partial unless it runs Monday to Sunday', () => {
    assert.equal(isPartialStart('2026-07-13', 'week'), false); // Monday
    assert.equal(isPartialStart('2026-07-16', 'week'), true);  // Thursday
    assert.equal(isPartialEnd('2026-07-19', 'week'), false);   // Sunday
    assert.equal(isPartialEnd('2026-07-16', 'week'), true);    // Thursday
  });
});
