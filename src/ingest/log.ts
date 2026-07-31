import { supabase } from '../lib/supabase.js';

export type IngestionStatus = 'success' | 'parse_error' | 'validation_error' | 'reconciliation_failed' | 'ingestion_error' | 'unknown_venue';

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
}> {
  const { data: venues } = await supabase.from('venues').select('id, name, slug');
  if (!venues) return { missing: [], recent_errors: [] };

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

      if (gaps.length > 0) {
        missing.push({ venue: venue.name, slug: venue.slug, date, missing: gaps });
      }
    }
  }

  const { data: errors } = await supabase
    .from('ingestion_log')
    .select('filename, status, error_message, created_at')
    .neq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(10);

  return {
    missing,
    recent_errors: (errors ?? []).map(e => ({
      filename: e.filename,
      status: e.status,
      error: e.error_message ?? '',
      created_at: e.created_at,
    })),
  };
}
