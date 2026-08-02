import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

const VENUE_NAMES: Record<string, string> = {
  '30f4ec07-afc6-4bb4-ba7c-10375b4f68c5': 'Neon Pigeon',
  'c0d03a78-7d28-4a4a-a908-d1719110e881': 'Fat Prince',
  'a0838494-04a6-4f04-8c1f-a8a2e01a3c07': 'Super Firangi',
};

function venueName(id: string): string {
  return VENUE_NAMES[id] ?? id;
}

async function main() {
  console.log('=== Monday.com Ingestion Status ===\n');

  // 1. Recent ingestion runs
  const { data: runs } = await supabase
    .from('ingestion_log')
    .select('*')
    .eq('report_type', 'monday_meals')
    .order('created_at', { ascending: false })
    .limit(20);

  if (runs && runs.length > 0) {
    console.log('RECENT RUNS:');
    for (const r of runs) {
      const time = new Date(r.created_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
      const status = r.status === 'success' ? 'OK' : 'FAIL';
      console.log(`  [${status}] ${venueName(r.venue_id)} | ${time} | ${r.row_count ?? 0} rows | ${r.error_message ?? ''}`);
    }
  } else {
    console.log('RECENT RUNS: none found — cron may not have fired yet.');
  }

  // 2. Unresolved reconciliation alerts
  const { data: alerts } = await supabase
    .from('reconciliation_alerts')
    .select('*')
    .eq('resolved', false)
    .order('business_date', { ascending: false });

  console.log(`\nUNRESOLVED ALERTS: ${alerts?.length ?? 0}`);
  if (alerts && alerts.length > 0) {
    for (const a of alerts) {
      const venue = venueName(a.venue_id);
      if (a.alert_type === 'reconciliation_failed') {
        console.log(`  [MISMATCH] ${venue} ${a.business_date}: Monday $${a.monday_gross} vs Revel $${a.revel_gross} (diff $${a.difference})`);
      } else if (a.alert_type === 'post_lock_change') {
        console.log(`  [POST-LOCK] ${venue} ${a.business_date}: data changed after lock`);
      }
    }
  }

  // 3. Lock status for recent dates (last 14 days)
  const today = new Date();
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const startDate = twoWeeksAgo.toISOString().split('T')[0];

  const { data: recentOps } = await supabase
    .from('daily_operations')
    .select('venue_id, business_date, data_source, locked_at, gross_sales')
    .gte('business_date', startDate)
    .order('business_date', { ascending: false });

  if (recentOps && recentOps.length > 0) {
    console.log('\nRECENT DATES (last 14 days):');

    const byDate = new Map<string, typeof recentOps>();
    for (const row of recentOps) {
      const arr = byDate.get(row.business_date) ?? [];
      arr.push(row);
      byDate.set(row.business_date, arr);
    }

    for (const [date, rows] of [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      console.log(`  ${date}:`);
      for (const r of rows.sort((a, b) => venueName(a.venue_id).localeCompare(venueName(b.venue_id)))) {
        const lock = r.locked_at ? 'LOCKED' : 'UNLOCKED';
        const src = r.data_source.toUpperCase();
        const gross = r.gross_sales ? `$${Number(r.gross_sales).toLocaleString()}` : 'no data';
        console.log(`    ${venueName(r.venue_id).padEnd(15)} ${src.padEnd(8)} ${lock.padEnd(10)} ${gross}`);
      }
    }
  }

  // 4. Summary counts
  const { count: totalLocked } = await supabase
    .from('daily_operations')
    .select('id', { count: 'exact', head: true })
    .not('locked_at', 'is', null);

  const { count: totalBoth } = await supabase
    .from('daily_operations')
    .select('id', { count: 'exact', head: true })
    .eq('data_source', 'both');

  const { count: totalUnlocked } = await supabase
    .from('daily_operations')
    .select('id', { count: 'exact', head: true })
    .eq('data_source', 'both')
    .is('locked_at', null);

  console.log('\nOVERALL:');
  console.log(`  Total locked rows:           ${totalLocked ?? 0}`);
  console.log(`  Rows with both sources:      ${totalBoth ?? 0}`);
  console.log(`  Both sources but UNLOCKED:   ${totalUnlocked ?? 0} (need reconciliation)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
