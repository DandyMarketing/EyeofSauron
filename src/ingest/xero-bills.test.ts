import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { allPlAccounts, type PlAccountRow } from './xero-bills.js';

/**
 * The payroll exclusion reads the P&L to learn which accounts hold personal
 * pay. A truncated read there is not a smaller answer — it is somebody's salary
 * reaching a queryable table.
 *
 * PostgREST caps a request at 1,000 rows and says nothing when it truncates.
 * Two years of P&L is roughly 43 to 55 lines a month, so 24 months is about
 * 1,030 to 1,090 rows per venue: just over the cap.
 */

const row = (id: string): PlAccountRow => ({ account_id: id, account_name: `Account ${id}` });

/** A fake table of `total` rows, served in pages of `pageSize`. */
const pagedTable = (total: number) =>
  async (_venue: string, from: number, to: number) => ({
    rows: Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => row(String(from + i))),
    error: null as string | null,
  });

test('a venue just over the page cap is read completely', () => {
  // The real shape: ~1,090 rows against a 1,000-row cap. A single request
  // would have returned 1,000 of them, unordered, with no error.
  return allPlAccounts('venue', pagedTable(1090), 1000).then(rows => {
    assert.equal(rows.length, 1090);
  });
});

test('an exact multiple of the page size does not stop one page early', () => {
  // The off-by-one that makes pagination look right and lose the tail.
  return allPlAccounts('venue', pagedTable(2000), 1000).then(rows => {
    assert.equal(rows.length, 2000);
  });
});

test('a single short page ends the loop', () => {
  return allPlAccounts('venue', pagedTable(12), 1000).then(rows => {
    assert.equal(rows.length, 12);
  });
});

test('a venue with no P&L returns nothing rather than looping', () => {
  return allPlAccounts('venue', pagedTable(0), 1000).then(rows => {
    assert.deepEqual(rows, []);
  });
});

test('a failed read THROWS rather than returning an empty list', async () => {
  // Returning [] would read as "this venue has no payroll accounts" and
  // silently disable the exclusion for the whole run — the exact failure the
  // exclusion exists to prevent.
  await assert.rejects(
    () => allPlAccounts('venue', async () => ({ rows: null, error: 'connection reset' }), 1000),
    /payroll lines would be stored/,
  );
});

test('a failure on a LATER page throws too', async () => {
  // A partial list is the dangerous case: it looks like a complete answer.
  let call = 0;
  await assert.rejects(
    () => allPlAccounts('venue', async (_v, from, to) => {
      if (call++ === 0) return { rows: Array.from({ length: 1000 }, (_, i) => row(String(i))), error: null };
      return { rows: null, error: 'timeout' };
    }, 1000),
    /Refusing to ingest bills/,
  );
});
