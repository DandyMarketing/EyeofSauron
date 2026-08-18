import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSchema, formatSchemaProblems, REQUIRED_SCHEMA, type SchemaExpectation,
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
