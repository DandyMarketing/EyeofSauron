import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShutOn, closuresIn, indexClosures } from './venue-closures.js';
import { isExpectedClosure, classifyIngestFailure } from '../ingest/closures.js';
import { reportDay } from './daily-report.js';

/**
 * One-off closures (migration 067, Khai, 10 Nov 2026): Fat Prince was shut on
 * Deepavali, Mon 20 Oct 2025, which is not its closed weekday, so nothing could
 * tell the empty day from a missing file.
 */
const DEEPAVALI = new Map([['2025-10-20', 'Deepavali']]);

test('a listed date is shut whatever its weekday; the regular pattern still applies', () => {
  assert.equal(isShutOn('2025-10-20', [], DEEPAVALI), true);
  assert.equal(isShutOn('2025-10-21', [], DEEPAVALI), false);
  // Firangi's Sundays (Monday = 0, so Sunday = 6).
  assert.equal(isShutOn('2026-11-08', [6], null), true);
  assert.equal(isShutOn('2026-11-09', [6], undefined), false);
});

test('closures are indexed by venue and listed oldest first inside a range', () => {
  const idx = indexClosures([
    { venue_id: 'fp', closed_on: '2025-12-25', reason: 'Christmas' },
    { venue_id: 'fp', closed_on: '2025-10-20', reason: 'Deepavali' },
    { venue_id: 'np', closed_on: '2025-10-20', reason: 'Private event' },
  ]);
  assert.deepEqual(closuresIn(idx.get('fp'), '2025-10-01', '2025-12-31'), [
    { date: '2025-10-20', reason: 'Deepavali' }, { date: '2025-12-25', reason: 'Christmas' },
  ]);
  assert.deepEqual(closuresIn(idx.get('fp'), '2025-11-01', '2025-11-30'), []);
  assert.deepEqual(closuresIn(undefined, '2025-01-01', '2025-12-31'), []);
});

test('an empty Revel file on a listed date is a closure, not an ingest error', () => {
  assert.equal(isExpectedClosure([], '2025-10-20', DEEPAVALI), true);
  assert.equal(classifyIngestFailure('Operations report has no data rows', [], '2025-10-20', 'ingestion_error', DEEPAVALI), 'closed');
  // Without the listing it stays an error, as before.
  assert.equal(classifyIngestFailure('Operations report has no data rows', [], '2025-10-20', 'ingestion_error'), 'ingestion_error');
  // Any other failure on a closed day is still an error.
  assert.equal(classifyIngestFailure('timeout', [], '2025-10-20', 'ingestion_error', DEEPAVALI), 'ingestion_error');
});

test('the daily report steps over a listed closure instead of calling the file late', () => {
  // Morning of Tue 21 Oct 2025: Monday was Deepavali, data runs to Sunday.
  assert.deepEqual(reportDay('2025-10-20', '2025-10-19', [], DEEPAVALI), { day: '2025-10-20', status: 'closed' });
  assert.deepEqual(reportDay('2025-10-20', '2025-10-19', []), { day: '2025-10-19', status: 'late' });
});
