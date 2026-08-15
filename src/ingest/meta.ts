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
