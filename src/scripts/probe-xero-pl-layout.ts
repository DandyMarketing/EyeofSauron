import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { getAccessToken } from '../ingest/xero.js';

/**
 * Does Xero's P&L API return the same breakdown the UI shows?
 *
 * On 2 Sep 2026 Neon Pigeon's stored June P&L carried COGS - Beverages at
 * 13,080 and no COGS - Alcohol line at all. Xero's own report for the same
 * month shows COGS - Alcohol 11,246.00 and COGS - Beverages 1,833.52 -- which
 * sum to 13,079.52. We are storing two accounts as one.
 *
 * Nothing in our code sums anything: the parser emits one line per row and the
 * ingest upserts one row per line. The reconciliation gate passed, because the
 * SECTION TOTAL was right -- 45,166.87 either way. A merge inside a section is
 * exactly the error that gate cannot see, and that is worth writing down: the
 * check proves the total, never the split.
 *
 * Which leaves the request itself. `Reports/ProfitAndLoss` takes a
 * `standardLayout` parameter and we pass neither value. Documented behaviour:
 * true returns the standard report as the UI renders it without customisation;
 * false returns the organisation's custom layout, with known gaps for layouts
 * built in Xero's post-2023 report styles. We take the default, and the default
 * is evidently not what the UI shows.
 *
 * So this asks all three ways and prints the Cost of Sales lines from each. It
 * WRITES NOTHING. The answer is whichever variant lists Alcohol and Beverages
 * separately -- and if none does, the API cannot express this venue's layout
 * and the split has to be rebuilt from bills instead.
 *
 * Account names and section totals only. A probe that prints a venue's full
 * cost base into a deploy log has put it somewhere it cannot be deleted from.
 */

const XERO_API = 'https://api.xero.com/api.xro/2.0';

const venueSlug = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1] ?? 'neon-pigeon';
const month = process.argv.find(a => a.startsWith('--month='))?.split('=')[1] ?? '2026-06';

const fromDate = `${month}-01`;
const toDate = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
  .toISOString()
  .slice(0, 10);

/** The three ways of asking, including the one we currently use. */
const VARIANTS: Array<{ label: string; query: string }> = [
  { label: 'as we ask today (parameter omitted)', query: '' },
  { label: 'standardLayout=true', query: '&standardLayout=true' },
  { label: 'standardLayout=false', query: '&standardLayout=false' },
];

async function fetchVariant(tenantId: string, query: string): Promise<any> {
  const accessToken = await getAccessToken(tenantId);
  const res = await fetch(
    `${XERO_API}/Reports/ProfitAndLoss?fromDate=${fromDate}&toDate=${toDate}${query}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json',
      },
    },
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Every named row under a section whose title mentions cost. */
function costLines(report: any): Array<{ name: string; amount: string }> {
  const rows = report?.Reports?.[0]?.Rows ?? [];
  const out: Array<{ name: string; amount: string }> = [];

  for (const section of rows) {
    const title = (section?.Title ?? '').toLowerCase();
    if (!title.includes('cost')) continue;
    for (const row of section?.Rows ?? []) {
      const name = (row?.Cells?.[0]?.Value ?? '').trim();
      const amount = (row?.Cells?.[1]?.Value ?? '').trim();
      if (name) out.push({ name, amount });
    }
  }
  return out;
}

const { data: conn } = await supabase
  .from('xero_connections')
  .select('tenant_id, tenant_name, venues(slug, name)')
  .limit(50);

const match = (conn ?? []).find((c: any) => c.venues?.slug === venueSlug);
if (!match) {
  console.error(`No Xero connection mapped to venue "${venueSlug}".`);
  console.error('Known:', (conn ?? []).map((c: any) => c.venues?.slug).filter(Boolean).join(', '));
  process.exit(1);
}

console.log(`P&L layout probe — ${(match as any).venues.name}, ${fromDate} to ${toDate}`);
console.log('Cost of Sales lines as each variant returns them. Nothing is written.\n');

for (const variant of VARIANTS) {
  console.log(`--- ${variant.label}`);
  try {
    const lines = costLines(await fetchVariant((match as any).tenant_id, variant.query));
    if (lines.length === 0) {
      console.log('  no cost section found');
    } else {
      for (const l of lines) console.log(`  ${l.name.padEnd(34)} ${l.amount}`);
      console.log(`  (${lines.length} line(s))`);
    }
  } catch (e: any) {
    // A rejected parameter is an answer too: it tells us the option is not
    // available to this connection rather than that the layout is unchanged.
    console.log(`  FAILED — ${e.message}`);
  }
  console.log('');
  // Xero rate-limits per organisation; three report calls is nothing, but the
  // pause keeps this consistent with every other script here.
  await new Promise(r => setTimeout(r, 1100));
}

console.log('Look for the variant listing COGS - Alcohol and COGS - Beverages SEPARATELY.');
console.log('If none does, the API cannot express this layout and the split must come from bills.');
