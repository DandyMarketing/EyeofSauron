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
export const IG_DAILY_METRICS = ['reach', 'profile_views', 'website_clicks'];

export interface MetaIngestResult {
  venue_id: string;
  platform: string;
  account_id: string;
  from_date: string;
  to_date: string;
  rows: number;
  missing_days: string[];
  stored: boolean;
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

  for (const page of payload.data ?? []) {
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
    if (!ig) {
      // Worth saying out loud. A Page with no linked Instagram account is the
      // single most common cause of "the handle exists but we cannot read it".
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
): Promise<any> {
  const params = new URLSearchParams({
    metric: metrics.join(','),
    period: 'day',
    since,
    until,
    access_token: token(),
  });

  const res = await fetch(`${GRAPH}/${accountId}/insights?${params}`);
  const text = await res.text();

  if (!res.ok) {
    // Graph puts the useful part in the body: an invalid metric name, a
    // missing permission, and an unlinked account all return 400 and are
    // indistinguishable from the status alone.
    throw new Error(`Meta insights request failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
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
  metrics: string[] = IG_DAILY_METRICS,
): Promise<MetaIngestResult> {
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

  let rows: InsightRow[];
  try {
    rows = normaliseInsights(await fetchInsights(accountId, metrics, since, until));
  } catch (e: any) {
    return { ...base, rows: 0, missing_days: [], stored: false, error: e.message };
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

  return { ...base, rows: records.length, missing_days: gaps, stored: true };
}
