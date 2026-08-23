import { supabase } from './supabase.js';

/**
 * Does the database actually have the columns this code writes?
 *
 * Nothing in the system knew. Migrations live in the repo, get applied by hand,
 * and the two drift silently -- so a deploy carrying code for a column nobody
 * has added looks completely healthy until someone triggers the write.
 *
 * That happened three times in one day, 18 Aug 2026:
 *
 *   015 missing -- every "Save for review" a user clicked was discarded, and
 *        the note was gone. Found weeks later by accident.
 *   018 missing -- would have taken stories down, which cannot be re-fetched.
 *   020 missing -- crashed a post backfill twice, twenty minutes into a run.
 *
 * All three had the same shape: the code was right, the migration had not been
 * run, and the failure surfaced in front of a person doing something else.
 *
 * The check is a SELECT of the expected columns. PostgREST answers a missing
 * one with "Could not find the 'x' column of 'y' in the schema cache" -- the
 * exact error the writes were failing with -- so this exercises the same path
 * the app does, including the schema cache itself. A stale cache is a real
 * cause of this and an information_schema query would sail straight past it.
 */

export interface SchemaExpectation {
  table: string;
  columns: string[];
  /** Which migration file adds these, so the report says what to run. */
  migration: string;
}

/**
 * What the code depends on.
 *
 * Deliberately NOT every column in the schema. A manifest that mirrors the
 * whole database is a second schema to maintain, and it would drift from the
 * first -- which is the problem this exists to solve, reintroduced one level up.
 * What belongs here is what a RECENT migration added, because that is what
 * production has not caught up with. Old columns are proven by the fact that
 * everything has been working for months.
 */
export const REQUIRED_SCHEMA: SchemaExpectation[] = [
  {
    table: 'social_posts',
    columns: ['content_type'],
    migration: '018_social_stories.sql',
  },
  {
    table: 'social_posts',
    columns: ['hashtags', 'mentions', 'caption_length', 'has_question', 'posted_hour'],
    migration: '020_post_features.sql',
  },
  {
    table: 'social_posts',
    columns: ['media_product_type', 'collaborator_count', 'children_count'],
    migration: '021_post_distribution.sql',
  },
  {
    table: 'social_posts',
    columns: ['category', 'category_confidence', 'shows_people', 'has_call_to_action', 'is_repost', 'is_trend', 'classified_at', 'classifier_model', 'classified_from'],
    migration: '025_post_classification.sql',
  },
  {
    table: 'venue_notes',
    columns: ['source_question'],
    migration: '015_note_source_question.sql',
  },
  {
    table: 'profit_and_loss',
    columns: ['venue_id', 'tenant_id', 'period_start', 'period_end', 'section', 'amount', 'is_summary'],
    migration: '013_profit_and_loss.sql',
  },
  {
    table: 'supplier_bills',
    columns: ['venue_id', 'tenant_id', 'invoice_id', 'supplier_name', 'bill_date', 'status', 'total'],
    migration: '022_supplier_bills.sql',
  },
  {
    table: 'supplier_bill_lines',
    columns: ['bill_id', 'venue_id', 'line_item_id', 'description', 'line_amount', 'account_code', 'account_id'],
    migration: '022_supplier_bills.sql',
  },
  {
    // The constraint, not a column -- but this manifest is what a job checks
    // before it writes, and an upsert naming a key that does not exist fails
    // at write time with a confusing PostgREST error rather than here.
    table: 'profit_and_loss',
    columns: ['account_id', 'account_name', 'is_summary'],
    migration: '023_pl_unique_without_is_summary.sql',
  },
  {
    table: 'account_map',
    columns: ['venue_id', 'account_name', 'canonical_account', 'business_line'],
    migration: '024_account_map.sql',
  },
  {
    table: 'xero_connections',
    columns: ['tenant_id', 'tenant_name', 'venue_id'],
    migration: '012_xero_connections.sql',
  },
  {
    table: 'daily_operations',
    columns: ['finance_notes'],
    migration: '016_finance_notes.sql',
  },
];

export interface SchemaProblem {
  table: string;
  migration: string;
  detail: string;
}

/** Asks PostgREST for the columns and reports what it could not find. */
async function probeColumns(table: string, columns: string[]): Promise<string | null> {
  const { error } = await supabase.from(table).select(columns.join(',')).limit(1);
  return error ? error.message : null;
}

/**
 * Every expectation the database does not meet. Empty means all is well.
 *
 * `probe` is injectable so the reporting can be tested without a database --
 * the part worth testing is what it says, not that PostgREST works.
 */
export async function checkSchema(
  expectations: SchemaExpectation[] = REQUIRED_SCHEMA,
  probe: (table: string, columns: string[]) => Promise<string | null> = probeColumns,
): Promise<SchemaProblem[]> {
  const problems: SchemaProblem[] = [];
  for (const expectation of expectations) {
    const detail = await probe(expectation.table, expectation.columns);
    if (detail) {
      problems.push({ table: expectation.table, migration: expectation.migration, detail });
    }
  }
  return problems;
}

/** The message a human reads. Names the migration, because that is the fix. */
export function formatSchemaProblems(problems: SchemaProblem[]): string {
  const lines = [
    `SCHEMA OUT OF DATE — ${problems.length} expectation(s) the database does not meet:`,
    '',
  ];
  for (const p of problems) {
    lines.push(`  ${p.table} — run supabase/migrations/${p.migration}`);
    lines.push(`    ${p.detail}`);
  }
  lines.push('');
  lines.push('The code in this deploy writes columns the database does not have.');
  lines.push('Run the migration(s) above in the Supabase SQL editor, then try again.');
  return lines.join('\n');
}

/**
 * The check as a job should use it: say what is wrong and stop.
 *
 * Stopping is right HERE and wrong in the server, which is why this is a
 * separate function rather than the check itself deciding. A backfill that
 * cannot write should not spend twenty minutes discovering that; but a web
 * server refusing to boot because one column is missing takes down every
 * feature that does not use it, and a degraded app beats a dead one.
 */
export async function requireSchema(): Promise<void> {
  const problems = await checkSchema();
  if (problems.length === 0) return;
  console.error(formatSchemaProblems(problems));
  process.exit(1);
}

/** The check as the server should use it: say what is wrong and carry on. */
export async function warnSchema(): Promise<void> {
  const problems = await checkSchema();
  if (problems.length === 0) return;
  console.error(formatSchemaProblems(problems));
  console.error('Continuing to serve — features not touching these columns still work.');
}
