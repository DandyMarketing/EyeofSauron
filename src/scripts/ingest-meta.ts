import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import {
  ingestMetaInsights, ingestMetaPosts, ingestMetaStories, isMetaAuthError,
  PLATFORM_METRICS, TOTAL_VALUE_METRICS, ACCOUNT_FIELDS,
} from '../ingest/meta.js';
import { requireSchema, SOCIAL_SCHEMA } from '../lib/schema-check.js';
import { socialFreshness, describeStale } from '../lib/social-freshness.js';

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

// A nightly job that cannot write is a night of stories lost, and stories
// cannot be re-fetched. Better to fail before making the calls than after.
await requireSchema(SOCIAL_SCHEMA);

/**
 * How long since this job last wrote anything?
 *
 * Reported at the START, before any work, because the interesting case is a job
 * that has just come back from being dead. On 20 Aug 2026 this service crashed
 * on a missing module and stayed down for hours; when it recovered, its log
 * looked exactly like a healthy run and said nothing about the gap it had left
 * behind. Anything missed in that window is unrecoverable -- stories expire in
 * about 24 hours, and `followers_count` has no history at Meta at all.
 *
 * A finding, never a failure: refusing to run because the last run was too long
 * ago would turn one missed night into two.
 */
const freshness = await socialFreshness();
if (!freshness.ok) {
  console.warn(describeStale(freshness));
  console.warn('');
}

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

    // Posts and stories. Both are content-level rather than daily, and both
    // failing does not invalidate the daily metrics that just landed -- so they
    // are findings rather than execution errors.
    if ((ACCOUNT_FIELDS[a.platform] ?? []).length > 0) {
      try {
        const p = await ingestMetaPosts(a.platform, a.account_id);
        console.log(`${label}: ${p.seen} posts seen, ${p.fetched} refreshed, ${p.skipped_already_current} already current`);
        if (p.without_metrics > 0) {
          dataFindings.push(`${label}: ${p.without_metrics} post(s) stored without metrics — Meta said: ${p.metrics_error ?? 'no reason captured'}`);
        }
      } catch (e: any) {
        dataFindings.push(`${label}: posts failed — ${e?.message ?? e}`);
      }

      // Stories cannot be backfilled. Whatever this run does not see expires
      // and is gone for good, so a failure here is worth saying loudly even
      // though it does not fail the job.
      try {
        const st = await ingestMetaStories(a.platform, a.account_id);
        console.log(`${label}: ${st.seen} stories live`);
        if (st.without_metrics > 0) {
          // The reason, not a homework assignment. This used to say "check
          // STORY_METRICS names against what Meta accepts", which asked a human
          // to guess at something Meta had already explained and mediaMetrics
          // had thrown away. A story cannot be re-fetched once it expires.
          dataFindings.push(`${label}: ${st.without_metrics} story/stories stored without metrics — Meta said: ${st.metrics_error ?? 'no reason captured'}`);
        }
      } catch (e: any) {
        dataFindings.push(`${label}: STORIES FAILED — ${e?.message ?? e} (stories expire in ~24h and cannot be recovered)`);
      }
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

// Name the cure, not just the symptom. A rejected token looks identical to a
// network problem in the log above, and the two want opposite responses: one is
// waited out, the other needs someone to change a secret.
if ([...executionErrors, ...dataFindings].some(isMetaAuthError)) {
  console.error('\nMeta rejected the token. Update META_SYSTEM_USER_TOKEN in the Railway sealed variable.');
  console.error('Retrying will not help until it is changed, and every night it stays broken is a');
  console.error('permanent hole in the follower series and every story posted that day.');
}

/**
 * Storing nothing at all is a failure, however politely it was reported.
 *
 * On 18 Aug 2026 every call came back "API access blocked" — the token had
 * stopped working. `ingestMetaInsights` caught each one and returned
 * `stored: false` with the reason, so they were all counted as data findings
 * and this exited 0. A dead token reported as a successful run.
 *
 * That is the exact failure this file's comments claim to guard against, and
 * the guard only covered errors that were THROWN. What matters is the outcome,
 * not which path the news arrived by: if any account was configured to pull and
 * not one row landed, the job failed.
 */
const attempted = (accounts as any[]).some(a =>
  (PLATFORM_METRICS[a.platform] ?? []).length +
  (TOTAL_VALUE_METRICS[a.platform] ?? []).length +
  (ACCOUNT_FIELDS[a.platform] ?? []).length > 0);

const storedNothing = !dryRun && attempted && totalRows === 0;
if (storedNothing) {
  console.error('\nNothing was stored by any account. Treating this as a failed run, not a quiet day.');
}

process.exit(executionErrors.length > 0 || storedNothing ? 1 : 0);
