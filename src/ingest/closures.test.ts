import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { weekdayOf, isExpectedClosure, isEmptyReportError, classifyIngestFailure } from './closures.js';

const SUNDAY = '2026-08-09';
const MONDAY = '2026-08-10';
const SUNDAYS_OFF = [6];

const EMPTY_PM = 'Product Mix CSV has no data rows';
const EMPTY_OPS =
  'Operations parse produced no sales-by-class rows and no gross/net sales — treating as a failed extraction, not a zero-sales day';

describe('weekdayOf', () => {
  test('Monday is 0 and Sunday is 6', () => {
    assert.equal(weekdayOf('2026-08-10'), 0);
    assert.equal(weekdayOf('2026-08-16'), 6);
  });

  test('derived in UTC, not the server’s local zone', () => {
    // 2026-08-09 is a Sunday. Parsed local on a server west of GMT it reads
    // back as Saturday, and Firangi's closure check silently stops matching.
    assert.equal(weekdayOf(SUNDAY), 6);
  });
});

describe('isExpectedClosure', () => {
  test('a shut weekday is an expected closure', () => {
    assert.equal(isExpectedClosure(SUNDAYS_OFF, SUNDAY), true);
  });

  test('a trading weekday is not', () => {
    assert.equal(isExpectedClosure(SUNDAYS_OFF, MONDAY), false);
  });

  test('a venue with no closures set trades every day', () => {
    // The default for every venue until someone confirms its trading days,
    // so it must fail towards the alarm rather than towards silence.
    assert.equal(isExpectedClosure([], SUNDAY), false);
    assert.equal(isExpectedClosure(null, SUNDAY), false);
    assert.equal(isExpectedClosure(undefined, SUNDAY), false);
  });
});

describe('isEmptyReportError', () => {
  test('recognises both empty-report messages the parsers throw', () => {
    assert.equal(isEmptyReportError(EMPTY_PM), true);
    assert.equal(isEmptyReportError(EMPTY_OPS), true);
  });

  test('does not match any other failure', () => {
    // Matched narrowly on purpose: a broader match would file a genuine
    // extraction failure as a closure and lose the day silently.
    assert.equal(isEmptyReportError('Operations upsert failed: connection timeout'), false);
    assert.equal(isEmptyReportError('Unknown venue key: "mystery"'), false);
    assert.equal(isEmptyReportError('Missing required column: Qty'), false);
  });
});

describe('classifyIngestFailure', () => {
  test('an empty report on a shut day is a closure', () => {
    assert.equal(classifyIngestFailure(EMPTY_PM, SUNDAYS_OFF, SUNDAY, 'parse_error'), 'closed');
    assert.equal(classifyIngestFailure(EMPTY_OPS, SUNDAYS_OFF, SUNDAY, 'ingestion_error'), 'closed');
  });

  test('an empty report on a TRADING day stays an error', () => {
    // This is the case the guard exists for: a venue that should have traded
    // and produced nothing is a failed extraction, and must stay loud.
    assert.equal(classifyIngestFailure(EMPTY_PM, SUNDAYS_OFF, MONDAY, 'parse_error'), 'parse_error');
  });

  test('any other failure on a shut day stays an error', () => {
    // Closed does not mean "ignore everything from this venue today".
    assert.equal(
      classifyIngestFailure('Operations upsert failed: timeout', SUNDAYS_OFF, SUNDAY, 'ingestion_error'),
      'ingestion_error',
    );
  });

  test('a venue with no trading days configured keeps every error', () => {
    assert.equal(classifyIngestFailure(EMPTY_PM, [], SUNDAY, 'parse_error'), 'parse_error');
  });
});
