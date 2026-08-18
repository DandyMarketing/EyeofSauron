import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { ingestMetaInsights, PLATFORM_METRICS, TOTAL_VALUE_METRICS, ACCOUNT_FIELDS } from '../ingest/meta.js';

/**
 * Nightly social ingestion.
 *
 * Run after midnight Singapore time so yesterday is complete.
 *
 * The default window is deliberately a few days rather than one. Insight
 * figures settle for a while after the day closes -- Meta revises them -- and a
 * job that only ever looks at yesterday can never correct what it already
 * stored. Re-reading a short tail costs a handful of calls and means the
 * warehouse converges on Meta's final numbers instead of freezing the first
 * answer it happened to get. That is the same mistake the Monday lock made
 * (BUILD_LOG 2.5), in a different costume.
 *
 * One metric here is perishable in a way the others are not: `followers_count`
 * has NO history at Meta. A night this job does not run is a hole in the
 * follower series that can never be filled. That is why a failure is loud.
 */

const days = Number(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? 3);
const dryRun = process.argv.includes('--dry-run');

if (dryRun) console.log('=== DRY RUN — no database writes ===\n');

const until = new Date().toISOString().slice(0, 10);
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

console.log(`Meta social ingestion — ${since} to ${until}\n`);

const { data: accounts, error } = await supabase
  .from('social_accounts')
  .select('platform, account_id, account_name, venue_id, venues(name)')
  .not('venue_id', 'is', null)
  .eq('is_active', true);

if (error) {
  console.error(`Could not read social_accounts: ${error.message}`);
  process.exit(1);
}

// Nothing mapped is a configuration problem, not a quiet night. Exiting 0 here
// would let the job report success forever while storing nothing at all.
if (!accounts || accounts.length === 0) {
  console.error('No Meta accounts are mapped to a venue. Nothing to ingest.');
  console.error('Map them on the admin page — an account handle is not a venue name.');
  process.exit(1);
}

let totalRows = 0;
const executionErrors: string[] = [];
const dataFindings: string[] = [];

for (const a of accounts as any[]) {
  const venue = a.venues?.name ?? a.venue_id;
  const label = `${a.account_name ?? a.account_id} (${venue})`;

  const configured =
    (PLATFORM_METRICS[a.platform] ?? []).length +
    (TOTAL_VALUE_METRICS[a.platform] ?? []).length +
    (ACCOUNT_FIELDS[a.platform] ?? []).length;

  if (configured === 0) {
    // Facebook today. Not an error — we have no working metric names for it,
    // and saying so every night is better than a silent skip.
    console.log(`${label}: skipped, no metrics configured for ${a.platform}`);
    continue;
  }

  if (dryRun) {
    console.log(`${label}: would pull ${configured} metrics`);
    continue;
  }

  try {
    const r = await ingestMetaInsights(a.platform, a.account_id, since, until);
    totalRows += r.rows;

    if (r.stored) {
      console.log(`${label}: ${r.rows} rows`);
    } else {
      console.log(`${label}: nothing stored — ${r.error ?? 'no reason given'}`);
      dataFindings.push(`${label}: ${r.error ?? 'nothing stored'}`);
    }

    // A partial pull that reports nothing looks complete. Name what Meta
    // refused, so a metric quietly disappearing is visible the first night
    // rather than the first time someone asks for a chart of it.
    for (const [metric, reason] of Object.entries(r.failed_metrics ?? {})) {
      dataFindings.push(`${label}: ${metric} refused — ${reason}`);
    }
    if (r.total_value_days_capped !== undefined) {
      dataFindings.push(`${label}: aggregate metrics covered only ${r.total_value_days_capped} of ${days} days`);
    }
    if (r.missing_days.length > 0) {
      dataFindings.push(`${label}: no data on ${r.missing_days.length} day(s) — ${r.missing_days.join(', ')}`);
    }
  } catch (e: any) {
    // The account could not be pulled at all: a dead token, a revoked
    // permission, an unmapped account. That is an execution failure.
    console.error(`${label}: FAILED — ${e?.message ?? e}`);
    executionErrors.push(`${label}: ${e?.message ?? e}`);
  }
}

console.log(`\n${totalRows} rows stored.`);

if (dataFindings.length > 0) {
  console.log(`\nFINDINGS (${dataFindings.length}) — the job ran, these are about the data:`);
  for (const f of dataFindings) console.log(`  - ${f}`);
}

if (executionErrors.length > 0) {
  console.error(`\nEXECUTION ERRORS (${executionErrors.length}):`);
  for (const e of executionErrors) console.error(`  - ${e}`);
}

/**
 * Exit non-zero ONLY for an execution error.
 *
 * A metric Meta refused is a finding about the data; the job did its work and
 * said what happened. Exiting 1 for that is what made the Monday cron show as
 * failed for four days while working perfectly (BUILD_LOG 6.1), and a service
 * that is always red is one nobody reads — so the night it genuinely breaks,
 * the red looks exactly the same.
 *
 * Every account failing IS an execution error even if each one was caught
 * individually: a token that has died fails per-account and would otherwise
 * exit 0 with an empty warehouse.
 */
const allFailed = executionErrors.length > 0 && executionErrors.length === accounts.length;
if (allFailed) console.error('\nEvery account failed — this is a token or permission problem, not bad luck.');

process.exit(executionErrors.length > 0 ? 1 : 0);
