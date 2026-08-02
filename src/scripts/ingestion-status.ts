import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { getCovers, coversVariance } from '../lib/covers.js';

/**
 * Single place to check every feed.
 *
 *   Monday.com  -> meal-period financials, reconciled and locked against Revel
 *   SevenRooms  -> reservations and covers, hourly during service
 *   Revel       -> revenue, still ingested manually via src/scripts/ingest.ts
 *
 * Run with --days N to widen the recent-dates window (default 7).
 */

const VENUE_NAMES: Record<string, string> = {
  '30f4ec07-afc6-4bb4-ba7c-10375b4f68c5': 'Neon Pigeon',
  'c0d03a78-7d28-4a4a-a908-d1719110e881': 'Fat Prince',
  'a0838494-04a6-4f04-8c1f-a8a2e01a3c07': 'Super Firangi',
};

function venueName(id: string): string {
  return VENUE_NAMES[id] ?? id;
}

function sgt(ts: string): string {
  return new Date(ts).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

const windowDays = Number(process.argv[process.argv.indexOf('--days') + 1]) || 7;

async function recentRuns(reportType: string, label: string, staleAfterHours: number, limit = 6) {
  const { data } = await supabase
    .from('ingestion_log')
    .select('*')
    .eq('report_type', reportType)
    .order('created_at', { ascending: false })
    .limit(limit);

  console.log(`\n${label}`);
  if (!data || data.length === 0) {
    console.log('  no runs recorded — the schedule may not have fired yet');
    return;
  }
  for (const r of data as any[]) {
    const status = r.status === 'success' ? 'OK  ' : 'FAIL';
    const err = r.error_message ? ` | ${r.error_message}` : '';
    console.log(`  [${status}] ${sgt(r.created_at).padEnd(22)} ${venueName(r.venue_id).padEnd(15)} ${String(r.row_count ?? 0).padStart(5)} rows${err}`);
  }

  // Silence is the failure mode that matters most: a cron that stopped firing
  // looks identical to one that has nothing to do. Flag it explicitly.
  const newest = (data as any[]).find(r => r.status === 'success');
  if (newest) {
    const hrs = (Date.now() - new Date(newest.created_at).getTime()) / 3_600_000;
    console.log(`  last success: ${hrs.toFixed(1)}h ago${hrs > staleAfterHours ? '   <-- STALE' : ''}`);
  } else {
    console.log('  no successful run in the recent history   <-- CHECK THIS');
  }
}

async function main() {
  console.log('=== Sauron Ingestion Status ===');
  console.log(`(now: ${sgt(new Date().toISOString())} SGT)`);

  await recentRuns('monday_meals', 'MONDAY.COM — meal periods, hourly 1pm-6pm SGT', 26);
  await recentRuns('sevenrooms', 'SEVENROOMS — reservations, hourly 11am-1am SGT', 4);
  await recentRuns('operations', 'REVEL OPERATIONS — manual, no schedule yet', 999);

  const { data: alerts } = await supabase
    .from('reconciliation_alerts')
    .select('*')
    .eq('resolved', false)
    .order('business_date', { ascending: false });

  console.log(`\nUNRESOLVED RECONCILIATION ALERTS: ${alerts?.length ?? 0}`);
  for (const a of (alerts ?? []) as any[]) {
    if (a.alert_type === 'post_lock_change') {
      console.log(`  [POST-LOCK] ${venueName(a.venue_id)} ${a.business_date}: data changed after lock`);
    } else {
      console.log(`  [MISMATCH]  ${venueName(a.venue_id)} ${a.business_date}: Monday $${a.monday_gross} vs Revel $${a.revel_gross} (diff $${a.difference})`);
    }
  }

  const from = daysAgo(windowDays);
  const to = daysAgo(0);

  const { data: venues } = await supabase.from('venues').select('id, name').order('name');
  console.log(`\nRECENT DATES (${from} .. ${to})`);
  console.log('  venue           date         revenue  lock       covers  revel  diff');

  for (const v of (venues ?? []) as any[]) {
    const coversMap = await getCovers(v.id, from, to);
    const { data: ops } = await supabase
      .from('daily_operations')
      .select('business_date, gross_sales, total_guests, locked_at')
      .eq('venue_id', v.id)
      .gte('business_date', from)
      .lte('business_date', to)
      .order('business_date', { ascending: false });

    for (const o of (ops ?? []) as any[]) {
      const c = coversMap.get(o.business_date);
      const chk = coversVariance(c?.covers ?? null, o.total_guests);
      const lock = o.locked_at ? 'LOCKED' : 'unlocked';
      const gross = o.gross_sales != null ? `$${Number(o.gross_sales).toLocaleString()}` : '-';
      const diff = chk.variance === null ? '-' : (chk.variance > 0 ? `+${chk.variance}` : String(chk.variance));
      const flag = chk.status === 'review' ? '  <-- covers review' : '';
      console.log(
        `  ${v.name.padEnd(15)} ${o.business_date} ${gross.padStart(9)}  ${lock.padEnd(9)}` +
        ` ${String(chk.sevenrooms_covers ?? '-').padStart(6)} ${String(chk.revel_guests ?? '-').padStart(6)} ${diff.padStart(5)}${flag}`
      );
    }
  }

  const { count: locked } = await supabase.from('daily_operations')
    .select('id', { count: 'exact', head: true }).not('locked_at', 'is', null);
  const { count: bothUnlocked } = await supabase.from('daily_operations')
    .select('id', { count: 'exact', head: true }).eq('data_source', 'both').is('locked_at', null);
  const { count: reservations } = await supabase.from('reservations')
    .select('id', { count: 'exact', head: true });

  console.log('\nOVERALL');
  console.log(`  Locked daily_operations rows:  ${locked ?? 0}`);
  console.log(`  Both sources but unlocked:     ${bothUnlocked ?? 0} (awaiting reconciliation)`);
  console.log(`  Reservations stored:           ${reservations ?? 0}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
