import { supabase } from './supabase.js';

/**
 * Has the Meta ingest actually been running?
 *
 * WHY A HEARTBEAT AND NOT A TRY/CATCH. On 20 Aug 2026 the Ingest-Meta service
 * crashed on startup -- `Cannot find module '/app/dist/scripts/ingest-meta.js'`
 * -- so no code of ours ran at all. An error handler inside the job cannot
 * report a job that never started, and nothing else was watching: Railway knew,
 * the dashboard knew, and nobody was told. It was found by chance, hours later.
 *
 * WHY IT MATTERS MORE HERE THAN ANYWHERE ELSE. Almost everything in this
 * warehouse can be re-fetched -- a missed Xero month, a missed Revel day, a
 * missed reach figure all come back on the next run. Two things do not:
 *
 *   - STORIES expire after about 24 hours and are gone.
 *   - `followers_count` has NO history at Meta at all, so the audience size for
 *     a day nobody captured is unrecoverable for ever.
 *
 * So a silent outage here does not delay data, it destroys it. That is the
 * whole argument for checking freshness rather than trusting the job to
 * complain.
 *
 * MEASURED ON `fetched_at`, NOT ON `business_date`. A business date can be
 * legitimately absent -- Meta lags, an account posts nothing -- so "no row for
 * yesterday" is ambiguous. "Nothing has been WRITTEN for 30 hours" is not: the
 * job either ran or it did not.
 */

/**
 * How old the newest write may be before it is a problem.
 *
 * The job runs twice a day, so in normal operation the newest row is at most
 * ~12 hours old. Eighteen leaves six hours of slack -- enough that a late run
 * or a slow night does not cry wolf, tight enough to catch a single missed run
 * before a second one compounds it. A story lives about 24 hours, so a single
 * missed run is already the point at which data starts being lost.
 */
export const MAX_SOCIAL_AGE_HOURS = 18;

export interface AccountWrite {
  venue: string;
  platform: string;
  account_id: string;
  /** Newest social_daily row for this account, or null if it has never been written. */
  last_fetched_at: string | null;
}

export interface StaleAccount extends AccountWrite {
  /** Null when the account has never been written at all. */
  hours_stale: number | null;
}

export interface SocialFreshness {
  ok: boolean;
  max_age_hours: number;
  stale: StaleAccount[];
  checked: number;
}

/**
 * Which accounts have not been written recently enough.
 *
 * Pure, so the thresholds can be tested without a database and without waiting
 * eighteen hours. `nowMs` is passed in for the same reason.
 */
export function classifyFreshness(
  writes: AccountWrite[],
  nowMs: number,
  maxAgeHours: number = MAX_SOCIAL_AGE_HOURS,
): SocialFreshness {
  const stale: StaleAccount[] = [];

  for (const write of writes) {
    if (write.last_fetched_at === null) {
      // Never written. Counted as stale rather than skipped: an account mapped
      // but never ingested is a configuration problem, and silence is exactly
      // how it would otherwise stay one.
      stale.push({ ...write, hours_stale: null });
      continue;
    }

    const written = Date.parse(write.last_fetched_at);
    // An unparseable timestamp is a problem in its own right, and treating it
    // as fresh would hide it.
    if (Number.isNaN(written)) {
      stale.push({ ...write, hours_stale: null });
      continue;
    }

    const hours = (nowMs - written) / 3_600_000;
    if (hours > maxAgeHours) {
      stale.push({ ...write, hours_stale: Math.round(hours * 10) / 10 });
    }
  }

  return {
    ok: stale.length === 0,
    max_age_hours: maxAgeHours,
    stale,
    checked: writes.length,
  };
}

/** The human-readable version, for a log line or an alert. */
export function describeStale(freshness: SocialFreshness): string {
  if (freshness.ok) return '';
  const lines = freshness.stale.map(s =>
    s.hours_stale === null
      ? `  - ${s.venue} (${s.platform}): NEVER ingested`
      : `  - ${s.venue} (${s.platform}): last written ${s.hours_stale}h ago`,
  );
  return [
    `SOCIAL INGEST STALE — ${freshness.stale.length} account(s) not written in ${freshness.max_age_hours}h:`,
    ...lines,
    'Stories expire after ~24h and followers_count has no history at Meta — both are lost, not delayed.',
    'Check the Ingest-Meta service on Railway.',
  ].join('\n');
}

/**
 * Read the newest write per mapped account.
 *
 * One query per account rather than a grouped aggregate: PostgREST has no clean
 * max()-per-group, there are three accounts, and this runs on a watchdog
 * endpoint nobody polls in a loop. Clarity beats cleverness at this size.
 */
/**
 * Platforms this system ingests, and therefore the only ones that can be stale.
 *
 * Instagram alone today. Facebook accounts exist in social_accounts because
 * account discovery finds them; nothing fetches them.
 */
export const INGESTED_PLATFORMS = ['instagram'];

export async function socialFreshness(
  maxAgeHours: number = MAX_SOCIAL_AGE_HOURS,
  nowMs: number = Date.now(),
): Promise<SocialFreshness> {
  const { data: accounts, error } = await supabase
    .from('social_accounts')
    .select('platform, account_id, venues(name)')
    .not('venue_id', 'is', null)
    .eq('is_active', true)
    /**
     * Only platforms we actually PULL.
     *
     * discoverAccounts() records every account the Meta token can see, which
     * includes the Facebook page behind each Instagram account. Nothing ingests
     * Facebook -- its proven-metric list in meta.ts is deliberately empty, and
     * CLAUDE.md is explicit that the Meta source is our own Instagram. So the
     * watchdog was reporting three feeds as NEVER INGESTED, in red, forever,
     * for something nobody intends to ingest.
     *
     * That is the Firangi Sunday lesson (BUILD_LOG 3.2 and
     * classifyIngestFailure) in a second place: a monitor that is permanently
     * red is one nobody reads, and it takes the real alarm down with it. Three
     * of the six lines on this panel were noise.
     *
     * Listed rather than derived from PROVEN_METRICS, because "which platforms
     * should be fresh" is a question about what we promise to ingest, not about
     * which metric list happens to be populated today. Adding Facebook here
     * should be a deliberate act by whoever makes it actually ingest.
     */
    .in('platform', INGESTED_PLATFORMS);

  // A failed read must not read as "everything is fresh". Same rule as
  // fetchNotes: returning ok on an error is how a broken check becomes
  // indistinguishable from a healthy system.
  if (error) {
    return {
      ok: false,
      max_age_hours: maxAgeHours,
      stale: [{
        venue: 'unknown',
        platform: 'unknown',
        account_id: 'unknown',
        last_fetched_at: null,
        hours_stale: null,
      }],
      checked: 0,
    };
  }

  const writes: AccountWrite[] = [];

  for (const account of (accounts ?? []) as any[]) {
    const { data: newest } = await supabase
      .from('social_daily')
      .select('fetched_at')
      .eq('platform', account.platform)
      .eq('account_id', account.account_id)
      .order('fetched_at', { ascending: false })
      .limit(1);

    writes.push({
      venue: account.venues?.name ?? account.account_id,
      platform: account.platform,
      account_id: account.account_id,
      last_fetched_at: newest?.[0]?.fetched_at ?? null,
    });
  }

  return classifyFreshness(writes, nowMs, maxAgeHours);
}
