import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { getCovers, coversVariance } from '../lib/covers.js';

/**
 * Covers SOP check.
 *
 * SevenRooms is the system of record for covers. That only holds if the floor
 * team logs every walk-in and adjusts party sizes when fewer guests turn up.
 * This report compares SevenRooms covers against Revel's paid-guest count per
 * venue per day, so a venue drifting from the SOP is visible rather than
 * quietly wrong.
 *
 * A positive variance means SevenRooms is higher than Revel -- usually a
 * booked party size never reduced when the table came up short.
 * A negative variance means covers were served that never reached SevenRooms
 * -- usually an unlogged walk-in.
 */

const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 14;

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

const from = daysAgo(days);
const to = daysAgo(0);

console.log(`=== Covers SOP Check: ${from} .. ${to} ===\n`);
console.log('SevenRooms is the system of record for covers.');
console.log('Revel guest count is shown only to detect data-entry gaps.\n');

const { data: venues } = await supabase.from('venues').select('id, name, slug').order('name');
if (!venues || venues.length === 0) {
  console.error('No venues found.');
  process.exit(1);
}

let totalReview = 0, totalMinor = 0, totalOk = 0, totalMissing = 0;
const worst: Array<{ venue: string; date: string; variance: number }> = [];

for (const venue of venues) {
  const coversMap = await getCovers(venue.id, from, to);

  const { data: ops } = await supabase
    .from('daily_operations')
    .select('business_date, total_guests, gross_sales')
    .eq('venue_id', venue.id)
    .gte('business_date', from)
    .lte('business_date', to)
    .order('business_date', { ascending: false });

  if (!ops || ops.length === 0) continue;

  const lines: string[] = [];
  for (const o of ops as any[]) {
    const c = coversMap.get(o.business_date);
    const check = coversVariance(c?.covers ?? null, o.total_guests);

    if (check.status === 'ok') totalOk++;
    else if (check.status === 'minor') totalMinor++;
    else if (check.status === 'review') totalReview++;
    else totalMissing++;

    if (check.status === 'missing') {
      lines.push(`    ${o.business_date}  no SevenRooms data ingested`);
      continue;
    }

    if (check.variance !== null && check.status === 'review') {
      worst.push({ venue: venue.name, date: o.business_date, variance: check.variance });
    }

    const flag = check.status === 'review' ? ' <-- REVIEW' : check.status === 'minor' ? ' (minor)' : '';
    const v = check.variance!;
    const sign = v > 0 ? `+${v}` : String(v);
    const shifts = c ? Object.entries(c.by_shift).map(([k, n]) => `${k} ${n}`).join(', ') : '';
    lines.push(
      `    ${o.business_date}  covers ${String(check.sevenrooms_covers).padStart(4)}` +
      `  revel ${String(check.revel_guests).padStart(4)}  diff ${sign.padStart(4)}${flag}` +
      (shifts ? `   [${shifts}]` : '')
    );
  }

  if (lines.length > 0) {
    console.log(`  ${venue.name}:`);
    for (const l of lines) console.log(l);
    console.log('');
  }
}

console.log('--- Summary ---');
console.log(`  Exact match:     ${totalOk}`);
console.log(`  Within 2 covers: ${totalMinor}`);
console.log(`  Needs review:    ${totalReview}`);
console.log(`  No SevenRooms:   ${totalMissing}`);

if (worst.length > 0) {
  console.log('\nLARGEST GAPS (SevenRooms minus Revel):');
  worst.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  for (const w of worst.slice(0, 10)) {
    const cause = w.variance > 0
      ? 'party size not reduced when guests did not show'
      : 'covers served but never logged in SevenRooms (walk-ins)';
    console.log(`  ${w.venue} ${w.date}: ${w.variance > 0 ? '+' : ''}${w.variance} — likely ${cause}`);
  }
}
