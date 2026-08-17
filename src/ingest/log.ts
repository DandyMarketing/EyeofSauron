import { supabase } from '../lib/supabase.js';
import { isExpectedClosure } from './closures.js';

/** How far back a failure keeps showing in the watchdog before it is history. */
const ERROR_WINDOW_DAYS = 7;

export type IngestionStatus = 'success' | 'parse_error' | 'validation_error' | 'reconciliation_failed' | 'ingestion_error' | 'unknown_venue' | 'closed';

interface LogEntry {
  venue_id?: string;
  venue_key?: string;
  business_date?: string;
  report_type: 'product_mix' | 'operations' | 'hourly_sales';
  filename: string;
  status: IngestionStatus;
  row_count?: number;
  error_message?: string;
}

export async function logIngestion(entry: LogEntry): Promise<void> {
  await supabase.from('ingestion_log').insert(entry);
}

export async function checkDataGaps(lookbackDays: number = 3): Promise<{
  missing: Array<{ venue: string; slug: string; date: string; missing: string[] }>;
  recent_errors: Array<{ filename: string; status: string; error: string; created_at: string }>;
  open_alerts: Array<{ venue: string; date: string; type: string; detail: string; since: string }>;
}> {
  const { data: venues } = await supabase.from('venues').select('id, name, slug, closed_weekdays');
  if (!venues) return { missing: [], recent_errors: [], open_alerts: [] };

  const today = new Date();
  const dates: string[] = [];
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const missing: Array<{ venue: string; slug: string; date: string; missing: string[] }> = [];

  for (const venue of venues) {
    for (const date of dates) {
      // A venue that is shut has no data to be missing. Reporting it as a gap
      // every week is the same noise as logging the empty file as an error.
      if (isExpectedClosure(venue.closed_weekdays as number[] | null, date)) continue;

      const gaps: string[] = [];

      const { data: ops } = await supabase
        .from('daily_operations')
        .select('id')
        .eq('venue_id', venue.id)
        .eq('business_date', date)
        .maybeSingle();
      if (!ops) gaps.push('operations');

      const { count } = await supabase
        .from('product_mix')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venue.id)
        .eq('business_date', date);
      if (!count || count === 0) gaps.push('product_mix');

      const { count: hsCount } = await supabase
        .from('hourly_sales')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venue.id)
        .eq('business_date', date);
      if (!hsCount || hsCount === 0) gaps.push('hourly_sales');

      if (gaps.length > 0) {
        missing.push({ venue: venue.name, slug: venue.slug, date, missing: gaps });
      }
    }
  }

  // Errors were previously "the last 10 failures, ever" -- no time bound at
  // all, while `lookbackDays` applied only to `missing`. So problems fixed
  // weeks ago kept the watchdog red, and a red watchdog is one nobody checks.
  // Bound them to a window wide enough that a failure has to be genuinely
  // stale to drop off, but not so wide it shows history.
  const errorWindowDays = Math.max(lookbackDays, ERROR_WINDOW_DAYS);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - errorWindowDays);

  const { data: errors } = await supabase
    .from('ingestion_log')
    .select('filename, status, error_message, created_at')
    // 'closed' is a normal outcome for a venue that does not trade that day.
    .not('status', 'in', '(success,closed)')
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: false })
    .limit(10);

  // Unresolved reconciliation alerts -- data problems, as distinct from the
  // job failures above. These have no time bound on purpose: an unreconciled
  // day does not stop being wrong because it is old, and unlike an ingestion
  // error there is a way to clear it. A human resolves it when it is dealt
  // with, which is what stops this becoming another permanently-red signal.
  const venueName = new Map(venues.map(v => [v.id, v.name]));
  const { data: alerts } = await supabase
    .from('reconciliation_alerts')
    .select('venue_id, business_date, alert_type, difference, monday_gross, revel_gross, created_at')
    .eq('resolved', false)
    .order('business_date', { ascending: false })
    .limit(50);

  const open_alerts = (alerts ?? []).map(a => ({
    venue: venueName.get(a.venue_id) ?? a.venue_id,
    date: a.business_date,
    type: a.alert_type,
    detail: a.alert_type === 'post_lock_change'
      ? 'Data changed on Monday.com after this day was reconciled and locked. The change was rejected, so Monday and the warehouse now disagree.'
      : `Monday $${a.monday_gross ?? '?'} vs Revel $${a.revel_gross ?? '?'} (out by $${a.difference ?? '?'})`,
    since: a.created_at,
  }));

  return {
    missing,
    open_alerts,
    recent_errors: (errors ?? []).map(e => ({
      filename: e.filename,
      status: e.status,
      error: e.error_message ?? '',
      created_at: e.created_at,
    })),
  };
}
