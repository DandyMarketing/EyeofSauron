import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { ingestProfitAndLoss } from '../ingest/xero-pl.js';
import { ingestSupplierBills } from '../ingest/xero-bills.js';
import { monthsBack, isStoredPeriodFinal } from '../lib/accounting-months.js';
import { requireSchema } from '../lib/schema-check.js';

/**
 * Monthly Profit & Loss for every connected Xero organisation.
 *
 * Safe to run on a schedule, unlike the Meta backfills. Two years of months
 * across three venues is 72 calls against Xero's 5,000-a-day limit, so there is
 * no reason to separate "backfill" from "keep up to date" -- the same run does
 * both, and running it nightly is what keeps the current month honest.
 *
 * MONTHLY, not daily. A P&L is accrual-based: rent, depreciation and accruals
 * are posted as monthly entries, so a single day's P&L is not a smaller version
 * of a month's, it is meaningless. Sales stay daily from Revel; margin is
 * monthly, and anything joining them has to aggregate sales to the month.
 *
 * RE-PULLING IS THE POINT. A P&L is not fixed when the month ends -- finance
 * keeps posting for weeks -- so a month is re-fetched until it has closed AND
 * we have fetched it since it closed. Skipping any month we already hold would
 * freeze whichever draft we captured first: the Monday lock again, with a
 * ledger instead of a board.
 *
 * Nothing is stored that fails reconciliation. `ingestProfitAndLoss` checks
 * that detail lines sum to the section totals Xero reports, and refuses the
 * period otherwise -- because a plausible wrong P&L is worse than none. Nobody
 * questions a number that looks reasonable, and every margin and food-cost
 * percentage built on it inherits the error silently.
 */

const arg = (name: string, fallback: number) => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

const months = Math.min(Math.max(arg('months', 24), 1), 120);
// Xero allows 60 calls a minute per tenant. One second between calls keeps us
// comfortably inside it without needing to think about it again.
const paceMs = Math.max(arg('pace', 1100), 200);
const onlySlug = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1];
const force = process.argv.includes('--force');

/**
 * One specific month, e.g. --month=2026-06.
 *
 * For testing against a CLOSED period. An open month can fail reconciliation
 * for accounting reasons -- an unposted journal, a bill half entered -- which
 * looks identical to the parser being wrong. A closed month is settled, so a
 * failure there is ours and a pass there means the parser reads Xero correctly.
 */
const onlyMonth = process.argv.find(a => a.startsWith('--month='))?.split('=')[1];

if (onlyMonth && !/^\d{4}-\d{2}$/.test(onlyMonth)) {
  console.error(`--month=${onlyMonth} is not a YYYY-MM month.`);
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');

/**
 * Pull supplier bills alongside the P&L.
 *
 * Off by default because it is the expensive half: the P&L is one call per
 * month, bills are one call per hundred bills plus a write per bill. Neon
 * Pigeon posts about a hundred bills a month, so two years is a different order
 * of work from the report -- worth running deliberately rather than nightly by
 * accident.
 */
const withBills = process.argv.includes('--bills');

console.log(`Xero P&L — ${months} month(s) back, ${paceMs}ms between calls`);
console.log(force
  ? 'FORCE — every month re-fetched, including ones already final.\n'
  : 'Months already closed AND fetched since they closed are skipped.\n');
if (withBills) console.log('Also pulling supplier bills. Paginated — Xero returns 100 per page and says nothing when there are more.\n');

await requireSchema();

const { data: connections, error } = await supabase
  .from('xero_connections')
  .select('tenant_id, tenant_name, venue_id, venues(name, slug)')
  .not('venue_id', 'is', null);

if (error) {
  console.error(`Could not read xero_connections: ${error.message}`);
  process.exit(1);
}

const targets = (connections ?? []).filter((c: any) => !onlySlug || c.venues?.slug === onlySlug);

if (targets.length === 0) {
  // An unmapped organisation is a configuration problem, not a quiet night.
  // And the mapping cannot be guessed: "Potus" and "20 Craig Road" name no
  // venue a human or a model would recognise.
  console.error(onlySlug
    ? `No mapped Xero connection matched --venue=${onlySlug}.`
    : 'No Xero organisations are mapped to a venue. Map them on the admin page first.');
  process.exit(1);
}

let periods = monthsBack(onlyMonth ? 120 : months);

if (onlyMonth) {
  periods = periods.filter(p => p.label === onlyMonth);
  if (periods.length === 0) {
    console.error(`--month=${onlyMonth} is outside the last 120 months.`);
    process.exit(1);
  }
  // A targeted month is being examined on purpose, so never skip it as final.
  console.log(`Single month: ${onlyMonth}. Fetched regardless of whether it is already stored.\n`);
}
console.log(`${periods[0].label} → ${periods[periods.length - 1].label}, ${targets.length} organisation(s)\n`);

if (dryRun) {
  console.log('=== DRY RUN — no calls, no writes ===');
  for (const t of targets as any[]) {
    console.log(`  ${t.tenant_name} → ${t.venues?.name}: ${periods.length} month(s)`);
  }
  process.exit(0);
}

let stored = 0;
let skipped = 0;
let billLines = 0;
const findings: string[] = [];
const refused: string[] = [];
const errors: string[] = [];

for (const t of targets as any[]) {
  const label = `${t.tenant_name} → ${t.venues?.name ?? t.venue_id}`;
  console.log(`\n${label}`);

  // What we already hold, and when we fetched it. One query per venue rather
  // than one per month.
  const { data: held } = await supabase
    .from('profit_and_loss')
    .select('period_start, period_end, fetched_at')
    .eq('venue_id', t.venue_id);

  const heldBy = new Map<string, string>();
  for (const row of held ?? []) {
    heldBy.set(`${row.period_start}|${row.period_end}`, row.fetched_at);
  }

  for (const period of periods) {
    const fetchedAt = heldBy.get(`${period.start}|${period.end}`);

    if (!force && !onlyMonth && isStoredPeriodFinal(period.end, fetchedAt)) {
      skipped++;
      continue;
    }

    try {
      const r = await ingestProfitAndLoss(t.tenant_id, period.start, period.end);

      if (r.stored) {
        stored++;
        console.log(`  ${period.label}: ${r.lines} line(s)`);

        if (withBills) {
          const b = await ingestSupplierBills(t.tenant_id, period.start, period.end, paceMs);
          billLines += b.lines;
          console.log(
            `  ${period.label}: ${b.bills} bill(s), ${b.lines} bill line(s)` +
            `${b.pages > 1 ? `, ${b.pages} pages` : ''}`,
          );
          // Both are findings rather than failures, and both are invisible
          // unless said: a voided bill is real but is not spend, and a bill
          // with no readable date is a gap somebody should be able to see.
          if (b.non_spend > 0) {
            findings.push(`${label} ${period.label}: ${b.non_spend} bill(s) voided or deleted — stored, but NOT spend`);
          }
          // Said out loud every time. An exclusion nobody can see is
          // indistinguishable from an exclusion that stopped working.
          if (b.payroll_lines_excluded > 0) {
            findings.push(`${label} ${period.label}: ${b.payroll_lines_excluded} payroll bill line(s) EXCLUDED — personal pay is never stored`);
          }
          if (b.unusable > 0) {
            findings.push(`${label} ${period.label}: ${b.unusable} bill(s) had no id or no readable date and were skipped`);
          }
        }
      } else {
        // Reconciliation refused it. This is a FINDING about the ledger, not a
        // failed run -- and the whole reason the gate exists.
        console.log(`  ${period.label}: REFUSED — ${r.error ?? 'did not reconcile'}`);
        refused.push(`${label} ${period.label}: ${r.error ?? 'did not reconcile'}`);
      }
    } catch (e: any) {
      const message = String(e?.message ?? e);
      console.error(`  ${period.label}: FAILED — ${message.slice(0, 200)}`);
      errors.push(`${label} ${period.label}: ${message.slice(0, 200)}`);
    }

    await new Promise(r => setTimeout(r, paceMs));
  }
}

console.log(`\n${stored} period(s) stored, ${skipped} already final and skipped.`);
if (withBills) console.log(`${billLines} supplier bill line(s) stored.`);

if (findings.length > 0) {
  console.log(`\nFINDINGS (${findings.length}) — the run worked, these are about the data:`);
  for (const f of findings) console.log(`  - ${f}`);
}

if (refused.length > 0) {
  console.log(`\nREFUSED BY RECONCILIATION (${refused.length}) — the run worked, these periods did not add up:`);
  for (const r of refused) console.log(`  - ${r}`);
  console.log('  A P&L whose detail lines do not sum to its own totals is not stored.');
  console.log('  Check the period in Xero: it usually means an unposted journal or a report we parse wrongly.');
}

if (errors.length > 0) {
  console.error(`\nERRORS (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
}

/**
 * A period Xero refused to reconcile is a finding, not a failed run -- the same
 * distinction the Meta jobs draw. Exiting 1 for it would make this red whenever
 * one month of one venue had an odd journal, and a job that is always red is
 * one nobody reads.
 *
 * Storing NOTHING at all is different, and is a failure however politely it was
 * reported.
 */
const storedNothing = stored === 0 && skipped === 0;
if (storedNothing) {
  console.error('\nNothing was stored and nothing was skipped — no period succeeded. Treating as a failed run.');
}

process.exit(errors.length > 0 || storedNothing ? 1 : 0);
