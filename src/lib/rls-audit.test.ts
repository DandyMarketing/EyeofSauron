// The module reads the catalogue through the shared client, which refuses to
// load without credentials. The pure half is what is tested here.
import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { classifyTables, describeAudit, type TableSecurity } from './rls-audit.js';

/**
 * These pin the one distinction the check turns on: a table with no RLS is a
 * hole, and a table with RLS and no policy is a locked door. Collapsing them
 * either way ruins the check -- one direction hides the hole, the other paints
 * the panel permanently red until nobody reads it.
 */

const t = (table_name: string, rls_enabled: boolean, policy_count: number): TableSecurity =>
  ({ table_name, rls_enabled, policy_count });

test('the measured case: two tables with RLS off, one of them holding revenue', () => {
  // reconciliation_alerts and ingestion_log, as they stood before migration
  // 034. A vendor's scan found this; nothing of ours did.
  const audit = classifyTables([
    t('product_mix', true, 2),
    t('reconciliation_alerts', false, 0),
    t('ingestion_log', false, 0),
  ]);

  assert.equal(audit.ok, false);
  assert.equal(audit.checked, 3);
  assert.deepEqual(audit.exposed.map(f => f.table), ['reconciliation_alerts', 'ingestion_log']);
  assert.match(audit.exposed[0].detail, /anon key/);
});

test('a deny-all table is not a fault', () => {
  // xero_connections: RLS on, no policy, encrypted OAuth tokens inside. That is
  // the correct configuration and adding a policy to quieten a report would be
  // a regression.
  const audit = classifyTables([t('xero_connections', true, 0)]);

  assert.equal(audit.ok, true);
  assert.equal(audit.exposed.length, 0);
  assert.deepEqual(audit.deny_all.map(f => f.table), ['xero_connections']);
});

test('RLS off with policies attached is still exposed', () => {
  // The trap. Policies can exist on a table whose RLS was never enabled, and
  // they do nothing at all -- so counting policies instead of reading
  // relrowsecurity would report this table as the best protected one here.
  const audit = classifyTables([t('half_done', false, 3)]);

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.exposed.map(f => f.table), ['half_done']);
  assert.equal(audit.deny_all.length, 0);
});

test('a protected table produces no finding of either kind', () => {
  const audit = classifyTables([t('venues', true, 1), t('product_mix', true, 4)]);

  assert.equal(audit.ok, true);
  assert.equal(audit.exposed.length, 0);
  assert.equal(audit.deny_all.length, 0);
  assert.match(describeAudit(audit), /all protected/);
});

test('an empty schema is not a pass to celebrate', () => {
  // Zero tables means the catalogue read returned nothing, which is far more
  // likely to be a broken query than a schema with no tables in it. ok stays
  // true because nothing is exposed, and the count is what gives it away.
  const audit = classifyTables([]);
  assert.equal(audit.checked, 0);
});

test('exposure is named before deny-all in the description', () => {
  // Ordering is the message. A fault listed under a paragraph of informational
  // notices is a fault somebody scrolls past.
  const text = describeAudit(classifyTables([
    t('xero_connections', true, 0),
    t('ingestion_log', false, 0),
  ]));

  assert.ok(text.indexOf('ingestion_log') < text.indexOf('xero_connections'));
  assert.match(text, /are OPEN/);
});

test('the description tells somebody what to actually do', () => {
  // A security warning that does not name the fix gets read once and deferred.
  const text = describeAudit(classifyTables([t('ingestion_log', false, 0)]));
  assert.match(text, /enable row level security/);
});
