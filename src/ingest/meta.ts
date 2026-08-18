import { supabase } from '../lib/supabase.js';
import { normaliseInsights, missingDays, type InsightRow } from '../parsers/meta/insights.js';

/**
 * Meta (Instagram / Facebook) insights ingestion.
 *
 * Auth is a Business Manager System User token: it belongs to the business
 * rather than a person, and it does not expire. That is why there is no
 * refresh dance here and no encrypted token table -- unlike Xero, this is a
 * static secret, so it belongs in a Railway sealed variable. A user token
 * would die whenever the person who minted it left or lost Page access.
 */

const GRAPH_VERSION = 'v22.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Account-level daily metrics.
 *
 * Kept deliberately short. Meta retires and renames metrics on its own
 * schedule, and every extra metric requested is another thing that can fail
 * the whole call -- Graph rejects the entire request if one metric name is
 * invalid, rather than returning the ones it understood.
 */
export const IG_DAILY_METRICS = ['reach'];

/**
 * What to pull, per platform. Only metrics PROVEN to work go in here.
 *
 * `reach` is confirmed: it returned 30 days for all three Instagram accounts on
 * 17 Aug 2026. `profile_views` and `website_clicks` were refused by Graph with
 * "(#100) The value must be a valid insights metric" -- a name it no longer
 * accepts on this endpoint, not a permission problem. They are candidates now,
 * not defaults, and go back in the moment `probeMetrics` proves a working form.
 *
 * Facebook is deliberately EMPTY. Page insights use a completely different
 * metric vocabulary (`page_impressions`, not `reach`), and sending Instagram
 * names to a Page is what produced three red rows of "every metric failed" --
 * our error, dressed up as Meta's. An empty list means the account is skipped
 * cleanly and says so, rather than failing loudly about the wrong thing.
 */
export const PLATFORM_METRICS: Record<string, string[]> = {
  // Both confirmed as true daily series: Graph returns a dated value per day.
  //
  // `follower_count` is NEW followers gained that day, not the size of the
  // audience -- singular is a delta, plural (`followers_count`, a field on the
  // account rather than an insights metric) is the total. Reporting one as the
  // other turns "23 new followers" into "23 followers", so the tool description
  // spells it out for the model.
  instagram: ['reach', 'follower_count'],
  facebook: [],
};

/**
 * Metrics Meta only serves as an aggregate, one window at a time.
 *
 * Each needs its own call per day, so this list costs 12 calls per account per
 * day. Nightly that is 36 across three venues -- nothing. A 30-day backfill is
 * 1,080, which is why `maxTotalValueDays` exists.
 *
 * `online_followers` is absent on purpose: Meta answers "incompatible with the
 * metric type (total_value)" and it does not work as a daily series either.
 */
export const TOTAL_VALUE_METRICS: Record<string, string[]> = {
  instagram: [
    'views', 'profile_views', 'website_clicks', 'accounts_engaged',
    'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies',
    'follows_and_unfollows', 'profile_links_taps',
  ],
  facebook: [],
};

/**
 * A total_value window opened at `since` returns the figure for the day BEFORE
 * it. So to read business date B, the window opens at B + 1.
 *
 * Measured, not assumed -- calibrated on 17 Aug 2026 against `reach`, the one
 * metric Meta serves in both forms. Seven days compared: seven agreements one
 * day back, zero same-day. `calibrateDayAlignment` is the check, and it should
 * be re-run if Meta changes API version or an account changes timezone.
 *
 * Getting this wrong would have been invisible. Every figure real, every total
 * reconciling, every day's activity filed against its neighbour.
 */
export const TOTAL_VALUE_SINCE_OFFSET_DAYS = 1;

/**
 * Fields read from the account itself, not from insights.
 *
 * `followers_count` is the audience size RIGHT NOW. Meta keeps no history of
 * it, so unlike everything else here it cannot be backfilled -- every day we do
 * not capture it is a day that is gone for good. That is the argument for the
 * nightly job, not just for tidiness.
 *
 * Note the plural. `follower_count`, singular, is an insights metric meaning
 * new followers gained that day. One is a level, the other a change, and they
 * differ by a single letter.
 */
export const ACCOUNT_FIELDS: Record<string, string[]> = {
  instagram: ['followers_count'],
  facebook: [],
};

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Read plain fields off the account node. Not an insights call. */
export async function fetchAccountFields(
  accountId: string,
  fields: string[],
): Promise<Record<string, number>> {
  const params = new URLSearchParams({ fields: fields.join(','), access_token: token() });
  const res = await fetch(`${GRAPH}/${accountId}?${params}`);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Meta account fields request failed: ${res.status} ${redactTokens(text)}`);
  }
  const json = JSON.parse(text);
  const out: Record<string, number> = {};
  for (const f of fields) {
    if (typeof json[f] === 'number') out[f] = json[f];
  }
  return out;
}

/**
 * All the aggregate-only metrics for one day, in a single call.
 *
 * Twelve metrics asked for one at a time is twelve requests per day per
 * account -- 153 for a three-day run across three venues. That volume, from a
 * brand-new token on a container Meta had never seen, tripped its automated
 * security on the first night and blocked the app outright. Asking for them
 * together makes the same run about twenty calls.
 *
 * The one-at-a-time path still exists, as a FALLBACK. Graph rejects an entire
 * request when a single metric name is invalid, and Meta retires names on its
 * own schedule -- so when the combined call fails, each metric is retried alone
 * and the survivors are kept. Resilience when it is needed, rather than paid
 * for on every call of every night.
 */
export async function fetchTotalValuesForDay(
  accountId: string,
  metrics: string[],
  businessDate: string,
): Promise<{ values: Record<string, number>; failed: Record<string, string> }> {
  const values: Record<string, number> = {};
  const failed: Record<string, string> = {};
  if (metrics.length === 0) return { values, failed };

  const base = new Date(`${businessDate}T00:00:00Z`).getTime();
  const since = isoDay(base + TOTAL_VALUE_SINCE_OFFSET_DAYS * DAY_MS);
  const until = isoDay(base + (TOTAL_VALUE_SINCE_OFFSET_DAYS + 1) * DAY_MS);

  try {
    const raw = await fetchInsights(accountId, metrics, since, until, 'total_value');
    for (const entry of raw?.data ?? []) {
      const value = entry?.total_value?.value;
      // Keyed by the name Meta echoes back, not by our request order. A
      // response that omits or reorders a metric would otherwise be read
      // against the wrong one.
      if (typeof value === 'number' && typeof entry?.name === 'string') {
        values[entry.name] = value;
      }
    }
    return { values, failed };
  } catch {
    for (const metric of metrics) {
      try {
        const value = await fetchTotalValueForDay(accountId, metric, businessDate);
        if (value !== null) values[metric] = value;
      } catch (e: any) {
        failed[metric] = String(e?.message ?? e).slice(0, 300);
      }
    }
    return { values, failed };
  }
}

/** One day's figure for a metric Meta only aggregates. Null if it gave none. */
export async function fetchTotalValueForDay(
  accountId: string,
  metric: string,
  businessDate: string,
): Promise<number | null> {
  const base = new Date(`${businessDate}T00:00:00Z`).getTime();
  const raw = await fetchInsights(
    accountId,
    [metric],
    isoDay(base + TOTAL_VALUE_SINCE_OFFSET_DAYS * DAY_MS),
    isoDay(base + (TOTAL_VALUE_SINCE_OFFSET_DAYS + 1) * DAY_MS),
    'total_value',
  );
  const value = raw?.data?.[0]?.total_value?.value;
  return typeof value === 'number' ? value : null;
}

/**
 * Names worth trying. Meta retires and renames account metrics on its own
 * schedule, so which of these is live is a question for the API, not for
 * memory -- `probeMetrics` asks it and reports back.
 */
export const METRIC_CANDIDATES: Record<string, string[]> = {
  instagram: [
    'reach', 'views', 'profile_views', 'website_clicks',
    'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares',
    'saves', 'replies', 'follows_and_unfollows', 'profile_links_taps',
    // Named by Meta itself in the rejection message for `impressions`, which
    // helpfully enumerates what it will accept. Its error is a better source
    // than any documentation, so it is worth reading in full -- which is why
    // the recorded reason is no longer truncated to 220 characters.
    'follower_count', 'online_followers',
  ],
  facebook: [
    'page_impressions', 'page_impressions_unique', 'page_post_engagements',
    'page_views_total', 'page_fans', 'page_daily_follows',
    'page_actions_post_reactions_total',
  ],
};

export interface MetaIngestResult {
  venue_id: string;
  platform: string;
  account_id: string;
  from_date: string;
  to_date: string;
  rows: number;
  missing_days: string[];
  stored: boolean;
  /**
   * Metrics Graph refused, by name, with its reason. Present when SOME metrics
   * came back and others did not -- a partial pull that reports nothing would
   * look complete.
   */
  failed_metrics?: Record<string, string>;
  /**
   * Set when the aggregate-only metrics covered fewer days than asked for. A
   * shortened range that says nothing about it reads as a complete one.
   */
  total_value_days_capped?: number;
  error?: string;
}

function token(): string {
  const t = process.env.META_SYSTEM_USER_TOKEN;
  if (!t) {
    throw new Error(
      'META_SYSTEM_USER_TOKEN is not set. Create a System User in Meta Business Manager, ' +
      'assign it to each Page and Instagram account, and generate a permanent token.',
    );
  }
  return t;
}

export interface DiscoveredAccount {
  platform: 'facebook' | 'instagram';
  account_id: string;
  account_name: string | null;
  /** For an Instagram account, the Page it hangs off. */
  page_id: string | null;
  /** Venue name if this account is already mapped, else null. */
  mapped_venue: string | null;
  /**
   * Whether a real insights call actually succeeded. `null` when not probed.
   * Having an id is not the same as being able to read it -- a System User can
   * see a Page it has no insights permission on, and the difference only shows
   * up when you ask for data.
   */
  insights_readable: boolean | null;
  error: string | null;
}

/**
 * Turn Graph's `/me/accounts` payload into the list, given what is already
 * mapped. Split out from the call so it can be tested without a live token --
 * the shapes Graph returns are the part that surprises you, not the fetch.
 */
export function mapDiscovered(
  pages: any[],
  mappedBy: Map<string, string | null>,
): { accounts: DiscoveredAccount[]; errors: string[] } {
  const accounts: DiscoveredAccount[] = [];
  const errors: string[] = [];

  for (const page of pages ?? []) {
    if (!page?.id) continue;

    accounts.push({
      platform: 'facebook',
      account_id: page.id,
      account_name: page.name ?? null,
      page_id: null,
      mapped_venue: mappedBy.get(`facebook|${page.id}`) ?? null,
      insights_readable: null,
      error: null,
    });

    const ig = page.instagram_business_account;
    if (!ig?.id) {
      // Worth saying out loud. A Page with no linked Instagram account is the
      // single most common cause of "the handle exists but we cannot read it",
      // and it is indistinguishable from a permissions problem in the error.
      errors.push(`Page "${page.name ?? page.id}" (${page.id}) has no linked Instagram business account.`);
      continue;
    }

    accounts.push({
      platform: 'instagram',
      account_id: ig.id,
      account_name: ig.username ?? ig.name ?? null,
      page_id: page.id,
      mapped_venue: mappedBy.get(`instagram|${ig.id}`) ?? null,
      insights_readable: null,
      error: null,
    });
  }

  return { accounts, errors };
}

/**
 * List every Page and Instagram account this token can actually reach.
 *
 * Written because chasing one account's permission error in isolation is
 * guesswork: you cannot tell "the account is not linked", "the System User has
 * no access" and "the permission was never granted" apart from the error alone.
 * This turns the question into a list you can read.
 *
 * With `probe`, each Instagram account gets a real one-day insights call. That
 * is the only honest test -- Graph will happily return an account id and then
 * refuse to give you a number for it.
 */
export async function discoverAccounts(
  opts: { probe?: boolean } = {},
): Promise<{ accounts: DiscoveredAccount[]; errors: string[] }> {
  const errors: string[] = [];
  const accounts: DiscoveredAccount[] = [];

  const params = new URLSearchParams({
    fields: 'id,name,instagram_business_account{id,username,name}',
    limit: '100',
    access_token: token(),
  });

  const res = await fetch(`${GRAPH}/me/accounts?${params}`);
  const text = await res.text();
  if (!res.ok) {
    // Graph's body carries the reason; the status alone says only "no".
    return { accounts: [], errors: [`Listing Pages failed: ${res.status} ${text}`] };
  }

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return { accounts: [], errors: [`Listing Pages returned unparseable JSON: ${text.slice(0, 400)}`] };
  }

  // Existing mappings, so the list says what is already done rather than
  // making someone cross-reference two screens.
  const { data: mapped } = await supabase
    .from('social_accounts')
    .select('platform, account_id, venues(name)');
  const mappedBy = new Map<string, string | null>(
    (mapped ?? []).map((m: any) => [`${m.platform}|${m.account_id}`, m.venues?.name ?? null]),
  );

  const mappedResult = mapDiscovered(payload.data ?? [], mappedBy);
  accounts.push(...mappedResult.accounts);
  errors.push(...mappedResult.errors);

  if (opts.probe) {
    // Yesterday to today: the smallest window that returns anything, and small
    // enough that probing every account costs nothing.
    const today = new Date();
    const until = today.toISOString().slice(0, 10);
    const since = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);

    for (const a of accounts) {
      if (a.platform !== 'instagram') continue;
      try {
        await fetchInsights(a.account_id, ['reach'], since, until);
        a.insights_readable = true;
      } catch (e: any) {
        a.insights_readable = false;
        a.error = String(e?.message ?? e).slice(0, 500);
      }
    }
  }

  return { accounts, errors };
}

export async function fetchInsights(
  accountId: string,
  metrics: string[],
  since: string,
  until: string,
  metricType?: string,
): Promise<any> {
  const params = new URLSearchParams({
    metric: metrics.join(','),
    period: 'day',
    since,
    until,
    access_token: token(),
  });
  // Several Instagram metrics moved to a total_value form and stopped being
  // accepted as a plain daily series. Which ones is a question for the API.
  if (metricType) params.set('metric_type', metricType);

  const res = await fetch(`${GRAPH}/${accountId}/insights?${params}`);
  const text = await res.text();

  if (!res.ok) {
    // Graph puts the useful part in the body: an invalid metric name, a
    // missing permission, and an unlinked account all return 400 and are
    // indistinguishable from the status alone.
    // Redacted too: an error body can echo the request, and these messages are
    // stored in results and shown on screen.
    throw new Error(`Meta insights request failed: ${res.status} ${redactTokens(text)}`);
  }
  return JSON.parse(text);
}

/**
 * Strip access tokens out of anything before it leaves the server.
 *
 * Graph echoes the token back inside `paging.previous` and `paging.next` on
 * every successful insights call. A diagnostic endpoint that returned the
 * response verbatim therefore handed a permanent System User token to the
 * browser, and from there into a screenshot and a chat window. It happened.
 *
 * The token does not expire, so exposure means rotation, not waiting.
 * Anything derived from a Graph response goes through here first.
 */
export function redactTokens<T>(value: T): T {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  return JSON.parse(
    json.replace(/(access_token=)[^&"\\\s]+/gi, '$1REDACTED')
        .replace(/("access_token"\s*:\s*")[^"]+/gi, '$1REDACTED'),
  );
}

export interface MetricProbe {
  metric: string;
  /** 'day' = plain daily series, 'total_value' = the newer aggregate form. */
  form: 'day' | 'total_value' | null;
  ok: boolean;
  error: string | null;
}

/**
 * Ask the API which metric names it will actually accept for this account.
 *
 * Written after guessing cost us: `profile_views` and `website_clicks` were in
 * the default pull because they used to work, and Graph now answers "(#100) The
 * value must be a valid insights metric". No list in any document is as
 * reliable as asking the account in front of you, and Meta's vocabulary differs
 * between Instagram and Facebook Pages anyway.
 *
 * Each candidate is tried as a plain daily series, then as total_value, because
 * several metrics moved to that form rather than disappearing.
 */
export async function probeMetrics(
  platform: string,
  accountId: string,
  candidates: string[] = METRIC_CANDIDATES[platform] ?? [],
): Promise<MetricProbe[]> {
  const today = new Date();
  const until = today.toISOString().slice(0, 10);
  const since = new Date(today.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const out: MetricProbe[] = [];

  for (const metric of candidates) {
    let lastError = '';
    let settled = false;

    for (const form of ['day', 'total_value'] as const) {
      try {
        await fetchInsights(accountId, [metric], since, until, form === 'total_value' ? 'total_value' : undefined);
        out.push({ metric, form, ok: true, error: null });
        settled = true;
        break;
      } catch (e: any) {
        lastError = String(e?.message ?? e);
      }
    }

    if (!settled) {
      // Not truncated hard: Meta's rejection for an unknown Instagram metric
      // lists every name it WILL accept, which is the most authoritative source
      // we have. Cutting it at 220 characters threw that list away.
      out.push({ metric, form: null, ok: false, error: lastError.slice(0, 900) });
    }
  }

  return out;
}

/**
 * Work out which day a total_value figure belongs to, by measuring rather than
 * assuming.
 *
 * total_value returns one aggregate for the requested window and no dates at
 * all, so a per-day pull has to label each value from the `since` we asked for.
 * Whether that is right depends on whether Meta treats the window as
 * [since, until) or (since, until] -- and a sum check CANNOT tell them apart,
 * because both conventions make the days add up to the window. They differ only
 * in which day each figure is.
 *
 * An off-by-one here is the worst kind of wrong: every number is real, the
 * totals reconcile, and every day's activity is filed against its neighbour.
 * Marketing would be reading Saturday's engagement as Sunday's.
 *
 * `reach` settles it. It is the one metric available in BOTH forms, so we can
 * pull it as a dated daily series -- where `end_time` tells us the day outright
 * -- and again one day at a time as total_value, then see whether the two agree
 * on the same dates or sit one apart.
 */
export interface DayAlignment {
  daily_series: Record<string, number>;
  per_day_total_value: Record<string, number>;
  matches: number;
  matches_shifted_back: number;
  verdict: 'aligned' | 'off_by_one' | 'inconclusive';
  note: string;
}

export async function calibrateDayAlignment(accountId: string, days = 7): Promise<DayAlignment> {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  // The dated series. normaliseInsights already applies the end_time
  // correction, so these dates are the trustworthy side of the comparison.
  const series: Record<string, number> = {};
  for (const r of normaliseInsights(await fetchInsights(accountId, ['reach'], iso(since), iso(until)))) {
    if (r.metric === 'reach') series[r.business_date] = r.value;
  }

  // The same metric, one day at a time, laid out the way a total_value pull
  // would have to label it.
  const perDay: Record<string, number> = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86_400_000);
    const next = new Date(d.getTime() + 86_400_000);
    try {
      const raw = await fetchInsights(accountId, ['reach'], iso(d), iso(next), 'total_value');
      const value = raw?.data?.[0]?.total_value?.value;
      if (typeof value === 'number') perDay[iso(d)] = value;
    } catch {
      // A day Meta will not answer for is simply absent; the verdict below
      // needs agreement, not completeness.
    }
  }

  let matches = 0;
  let shifted = 0;
  for (const [date, value] of Object.entries(perDay)) {
    if (series[date] === value) matches++;
    const prev = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    if (series[prev] === value) shifted++;
  }

  const verdict: DayAlignment['verdict'] =
    matches >= 3 && matches > shifted ? 'aligned'
      : shifted >= 3 && shifted > matches ? 'off_by_one'
        : 'inconclusive';

  return {
    daily_series: series,
    per_day_total_value: perDay,
    matches,
    matches_shifted_back: shifted,
    verdict,
    note: verdict === 'aligned'
      ? 'A per-day total_value pull can be labelled with the `since` date. Safe to ingest the other metrics this way.'
      : verdict === 'off_by_one'
        ? 'Values belong to the day BEFORE the `since` used. The ingest must subtract a day, exactly as the daily series does with end_time.'
        : 'Not enough agreement either way. Do not ingest total_value metrics on a guess -- widen the window and run again.',
  };
}

/**
 * Ingest a date range for one mapped account.
 *
 * Refuses an unmapped account for the same reason the Xero pull does: a figure
 * filed against the wrong venue is a confident answer about a different
 * business, and an account handle is not a venue name.
 */
export async function ingestMetaInsights(
  platform: string,
  accountId: string,
  since: string,
  until: string,
  metrics: string[] = PLATFORM_METRICS[platform] ?? [],
  maxTotalValueDays = 7,
): Promise<MetaIngestResult> {
  if (
    metrics.length === 0 &&
    (TOTAL_VALUE_METRICS[platform] ?? []).length === 0 &&
    (ACCOUNT_FIELDS[platform] ?? []).length === 0
  ) {
    // Facebook Pages, today. Saying "nothing configured" is honest; running
    // Instagram metric names against a Page and reporting Graph's rejection
    // would blame Meta for our own mistake.
    return {
      venue_id: '', platform, account_id: accountId, from_date: since, to_date: until,
      rows: 0, missing_days: [], stored: false,
      error: `No metrics are configured for ${platform}. Run the metric probe to find names this platform accepts.`,
    };
  }
  const { data: account } = await supabase
    .from('social_accounts')
    .select('account_id, venue_id, is_active')
    .eq('platform', platform)
    .eq('account_id', accountId)
    .maybeSingle();

  if (!account) throw new Error(`No social account registered for ${platform}/${accountId}`);
  if (!account.venue_id) {
    throw new Error(
      `Social account ${platform}/${accountId} is not mapped to a venue. Map it first — ` +
      `an account handle is not a venue name and must not be guessed at.`,
    );
  }

  const base = {
    venue_id: account.venue_id as string,
    platform,
    account_id: accountId,
    from_date: since,
    to_date: until,
  };

  // One call per metric, not one call for all of them.
  //
  // Graph rejects the ENTIRE request if a single metric name is invalid, and it
  // retires and renames account metrics on its own schedule. Asking for three
  // together means the day a metric is retired we silently lose the other two
  // as well -- a whole feed going dark because of a name change somewhere else.
  // Three accounts times three metrics is nine cheap calls; robustness is worth
  // more than the round trips here.
  const rows: InsightRow[] = [];
  const failedMetrics: Record<string, string> = {};

  for (const metric of metrics) {
    try {
      rows.push(...normaliseInsights(await fetchInsights(accountId, [metric], since, until)));
    } catch (e: any) {
      failedMetrics[metric] = String(e?.message ?? e).slice(0, 300);
    }
  }

  // Aggregate-only metrics, one call per metric per day.
  //
  // Capped rather than unbounded: a 30-day pull of twelve metrics is 360 calls
  // per account, and a rate limit hit halfway through would leave a partial day
  // stored with no sign of it. The cap is REPORTED, never silent -- a truncated
  // range that says nothing reads as a complete one.
  const totalValueMetrics = TOTAL_VALUE_METRICS[platform] ?? [];
  let daysCapped: number | undefined;

  if (totalValueMetrics.length > 0) {
    const startMs = new Date(`${since}T00:00:00Z`).getTime();
    const endMs = new Date(`${until}T00:00:00Z`).getTime();
    const requested = Math.floor((endMs - startMs) / DAY_MS) + 1;
    const span = Math.min(requested, maxTotalValueDays);
    if (span < requested) daysCapped = span;

    // The newest business date these metrics can answer for is TWO days ago.
    //
    // Two facts compound. The window opens the day AFTER the date wanted, and
    // Meta will not accept a window opening later than yesterday -- it answers
    // "(#100) since param is not valid". So the latest window we may open is
    // yesterday, and that window reads the day before it.
    //
    // The calibration run said this plainly and I read it twice without seeing
    // it: on 17 August the newest window that worked opened on the 16th. Both
    // earlier attempts here were off by a day in the same direction, each time
    // failing every metric on a day Meta was never going to serve.
    const newestDay = Math.min(endMs, Date.now() - (TOTAL_VALUE_SINCE_OFFSET_DAYS + 1) * DAY_MS);

    // Most recent days first: if a rate limit does bite, the days that matter
    // most are already in.
    for (let i = 0; i < span; i++) {
      const day = isoDay(newestDay - i * DAY_MS);
      const { values, failed } = await fetchTotalValuesForDay(accountId, totalValueMetrics, day);
      for (const [metric, value] of Object.entries(values)) {
        rows.push({ business_date: day, metric, value });
      }
      Object.assign(failedMetrics, failed);
    }
  }

  // A metric that failed on one day but returned data on another is not
  // refused. `failedMetrics` accumulates across days, so a single bad day --
  // one Meta had no answer for, or one we should never have asked about --
  // marked all twelve as refused for the whole run even while their rows were
  // landing. Reported failure has to mean "we got nothing", or the report is
  // noise and stops being read.
  const metricsWithData = new Set(rows.map(r => r.metric));
  for (const metric of Object.keys(failedMetrics)) {
    if (metricsWithData.has(metric)) delete failedMetrics[metric];
  }

  // The audience size, as it stands now.
  //
  // Stamped with TODAY regardless of the range asked for, because that is the
  // only day it describes. Meta serves no history for it, so writing it against
  // an older date would invent a past reading -- a follower curve made of the
  // same number repeated, which looks like a flat audience rather than missing
  // data. One row per run; a second run the same day simply overwrites it.
  const accountFields = ACCOUNT_FIELDS[platform] ?? [];
  if (accountFields.length > 0) {
    try {
      const snapshot = await fetchAccountFields(accountId, accountFields);
      const today = isoDay(Date.now());
      for (const [metric, value] of Object.entries(snapshot)) {
        rows.push({ business_date: today, metric, value });
      }
    } catch (e: any) {
      failedMetrics[accountFields.join(',')] = String(e?.message ?? e).slice(0, 300);
    }
  }

  if (rows.length === 0) {
    return {
      ...base,
      rows: 0,
      missing_days: [],
      stored: false,
      failed_metrics: failedMetrics,
      error: Object.keys(failedMetrics).length
        ? `Every metric failed: ${Object.entries(failedMetrics).map(([m, e]) => `${m} — ${e}`).join(' | ')}`
        : 'Meta returned no rows for this range.',
    };
  }

  const gaps = missingDays(rows, since, until);

  const records = rows.map(r => ({
    venue_id: account.venue_id,
    platform,
    account_id: accountId,
    business_date: r.business_date,
    metric: r.metric,
    value: r.value,
    fetched_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('social_daily')
    .upsert(records, { onConflict: 'platform,account_id,business_date,metric' });

  if (error) throw new Error(`Social metrics upsert failed: ${error.message}`);

  return {
    ...base,
    rows: records.length,
    missing_days: gaps,
    stored: true,
    ...(daysCapped !== undefined ? { total_value_days_capped: daysCapped } : {}),
    // Carried even on success. A pull that stored two metrics out of three is
    // not a failure, but calling it a clean success is how a feed goes quietly
    // half-dark.
    ...(Object.keys(failedMetrics).length ? { failed_metrics: failedMetrics } : {}),
  };
}
