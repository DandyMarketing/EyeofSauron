import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSchema, formatSchemaProblems, REQUIRED_SCHEMA,
  SOCIAL_SCHEMA, XERO_SCHEMA, RECOMMENDATION_SCHEMA, APP_SCHEMA,
  type SchemaExpectation,
} from './schema-check.js';

const expectations: SchemaExpectation[] = [
  { table: 'social_posts', columns: ['caption_length'], migration: '020_post_features.sql' },
  { table: 'venue_notes', columns: ['source_question'], migration: '015_note_source_question.sql' },
];

describe('checkSchema', () => {
  test('a database that meets every expectation reports nothing', async () => {
    const problems = await checkSchema(expectations, async () => null);
    assert.deepEqual(problems, []);
  });

  test('a missing column is reported with the migration that adds it', async () => {
    // Naming the migration is the whole value. "Column not found" sends someone
    // reading the schema; "run 020_post_features.sql" is the fix itself.
    const problems = await checkSchema(expectations, async table =>
      table === 'social_posts'
        ? "Could not find the 'caption_length' column of 'social_posts' in the schema cache"
        : null);

    assert.equal(problems.length, 1);
    assert.equal(problems[0].migration, '020_post_features.sql');
    assert.ok(problems[0].detail.includes('caption_length'));
  });

  test('every failing expectation is reported, not just the first', async () => {
    // A deploy behind by three migrations should say so once, not force three
    // rounds of run-it, hit-the-next-one.
    const problems = await checkSchema(expectations, async () => 'missing');
    assert.equal(problems.length, 2);
  });
});

describe('formatSchemaProblems', () => {
  test('names the table, the migration and what the database said', async () => {
    const problems = await checkSchema(expectations, async table =>
      table === 'venue_notes' ? "Could not find the 'source_question' column" : null);
    const message = formatSchemaProblems(problems);

    assert.ok(message.includes('venue_notes'));
    assert.ok(message.includes('015_note_source_question.sql'));
    assert.ok(message.includes('source_question'));
  });
});

describe('REQUIRED_SCHEMA', () => {
  test('every entry names a migration file that exists in the repo', async () => {
    // A manifest pointing at a migration nobody can find is worse than no
    // manifest: it sends someone looking for a file that was renamed or never
    // committed, at the moment they are already blocked.
    const { readdirSync } = await import('node:fs');
    const files = new Set(readdirSync(new URL('../../supabase/migrations', import.meta.url)));

    for (const expectation of REQUIRED_SCHEMA) {
      assert.ok(
        files.has(expectation.migration),
        `${expectation.migration} is referenced but not in supabase/migrations`,
      );
    }
  });

  test('no entry declares an empty column list', async () => {
    // An empty list probes nothing and always passes, which is a check that
    // reports healthy for a table it never looked at.
    for (const expectation of REQUIRED_SCHEMA) {
      assert.ok(expectation.columns.length > 0, `${expectation.table} declares no columns`);
    }
  });
});

describe('the groups keep one job\'s missing migration off another job\'s back', () => {
  test('a Meta job never checks a Xero table', () => {
    // 31 Aug 2026: migration 031 sat un-run and the Instagram post classifier
    // died on supplier_bills.document_type -- a column it does not read, write
    // or know exists. Two jobs down, one of them faultless.
    const tables = new Set(SOCIAL_SCHEMA.map(e => e.table));

    assert.ok(!tables.has('supplier_bills'), 'a Meta job must not depend on supplier_bills');
    assert.ok(!tables.has('profit_and_loss'));
    assert.ok(!tables.has('account_map'));
    assert.deepEqual([...tables], ['social_posts']);
  });

  test('a Xero job never checks social_posts', () => {
    // The same failure with the venues reversed: an un-run Meta migration
    // must not stop the ledger being ingested.
    assert.ok(!XERO_SCHEMA.some(e => e.table === 'social_posts'));
  });

  test('the weekly brief is gated on what it WRITES, not what it reads', () => {
    // It reads the P&L, bills and posts through query tools. A missing column
    // there is one tool returning an error inside a run that still works --
    // degraded, not dead. Only its own output table can stop it starting.
    assert.deepEqual([...new Set(RECOMMENDATION_SCHEMA.map(e => e.table))], ['recommendations']);
  });

  test('REQUIRED_SCHEMA is exactly the groups, so neither can drift', () => {
    // Composed rather than re-listed: an expectation added to a group and
    // forgotten in the full list would be unchecked by the server, which is
    // the only place that checks everything.
    assert.equal(
      REQUIRED_SCHEMA.length,
      SOCIAL_SCHEMA.length + RECOMMENDATION_SCHEMA.length + XERO_SCHEMA.length + APP_SCHEMA.length,
    );
  });

  test('every expectation belongs to exactly one group', () => {
    // An expectation in two groups gets checked twice and, worse, reported
    // twice -- and one nobody put in a group is silently never checked by any
    // job at all, which is this bug with the sign flipped.
    const key = (e: SchemaExpectation) => `${e.table}:${e.columns.join(',')}`;
    const grouped = [...SOCIAL_SCHEMA, ...RECOMMENDATION_SCHEMA, ...XERO_SCHEMA, ...APP_SCHEMA].map(key);

    assert.equal(new Set(grouped).size, grouped.length, 'an expectation appears in two groups');
    assert.deepEqual(new Set(REQUIRED_SCHEMA.map(key)), new Set(grouped));
  });
});
