import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { getAccessToken } from '../ingest/xero.js';

/**
 * Can we read supplier bills, and what do they carry?
 *
 * The P&L says "marketing cost 26,034 in June" and cannot say on what, because
 * Xero aggregates by account before the report reaches us. The general ledger
 * would have answered it and is closed to us: /Journals has no granular scope,
 * and an app created after 2 March 2026 can never have it.
 *
 * Bills are the way in, and arguably the better one. A bill carries a supplier,
 * a description and line items coded to an account; a journal line carries only
 * a code. In Xero's model a supplier bill is an invoice of type ACCPAY.
 *
 * THIS PROBE EXISTS TO CHECK ONE THING FIRST. Xero's consent screen listed only
 * "View your profit & loss reports" even with accounting.invoices.read in the
 * request, so whether the scope actually took is unproven. A 403 here means it
 * did not, whatever the consent screen implied.
 *
 * Reports SHAPE, counts and account names -- never a line description or an
 * amount against a supplier. A probe that prints a venue's spending into a
 * deploy log has put it somewhere it cannot be deleted from.
 */

const XERO_API = 'https://api.xero.com/api.xro/2.0';

const venueSlug = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1] ?? 'neon-pigeon';
const since = process.argv.find(a => a.startsWith('--since='))?.split('=')[1] ?? '2026-06-01';
const until = process.argv.find(a => a.startsWith('--until='))?.split('=')[1] ?? '2026-06-30';

console.log(`Probing Xero supplier bills — ${venueSlug}, ${since} to ${until}. Read-only, nothing is stored.\n`);

const { data: conns } = await supabase
  .from('xero_connections')
  .select('tenant_id, tenant_name, venue_id, venues(name, slug)')
  .not('venue_id', 'is', null);

const target = (conns ?? []).find((c: any) => c.venues?.slug === venueSlug) as any;
if (!target) {
  console.error(`No mapped Xero connection for --venue=${venueSlug}.`);
  process.exit(1);
}

console.log(`${target.tenant_name} → ${target.venues?.name}\n`);
const accessToken = await getAccessToken(target.tenant_id);

/**
 * ACCPAY is a bill owed to a supplier; ACCREC is a sales invoice. Only the
 * first is spending, and asking for both would double the volume to answer
 * half the question.
 *
 * The `where` filter is Xero's own syntax and dates go through its DateTime
 * helper. Getting this wrong returns everything ever rather than an error,
 * which is why the date range is printed back and the count is worth reading.
 */
const where = encodeURIComponent(
  `Type=="ACCPAY" AND Date>=DateTime(${since.replace(/-/g, ',')}) AND Date<=DateTime(${until.replace(/-/g, ',')})`,
);

const res = await fetch(`${XERO_API}/Invoices?where=${where}&page=1`, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Xero-tenant-id': target.tenant_id,
    Accept: 'application/json',
  },
});

const text = await res.text();

if (!res.ok) {
  console.error(`Invoices request failed: ${res.status}`);
  console.error(text.slice(0, 400));
  if (res.status === 401 || res.status === 403) {
    console.error('\nThat is the scope, not the code. accounting.invoices.read was requested but');
    console.error('the consent screen listed only the profit & loss report — so it may not have');
    console.error('been granted. Reconnect with XERO_SCOPES set, and check the Xero consent text.');
  }
  process.exit(1);
}

const invoices = (JSON.parse(text)?.Invoices ?? []) as any[];

if (invoices.length === 0) {
  console.log('No supplier bills in that range. Either none were entered, or the date filter is wrong.');
  console.log('Try a wider range before concluding the venue has no bills.');
  process.exit(0);
}

console.log(`${invoices.length} bill(s) in the range.\n`);

console.log('BILL FIELDS:');
console.log(`  ${Object.keys(invoices[0]).join(', ')}\n`);

const withLines = invoices.find(i => (i.LineItems ?? []).length > 0);
console.log('LINE ITEM FIELDS:');
console.log(`  ${Object.keys((withLines?.LineItems ?? [{}])[0] ?? {}).join(', ')}\n`);

// Does a line carry the account code? That is the whole question: without it a
// bill cannot be attributed to the P&L line it landed in.
const hasAccountCode = invoices.some(i => (i.LineItems ?? []).some((l: any) => l.AccountCode));
console.log(`  Line items carry AccountCode: ${hasAccountCode ? 'YES' : 'NO'}`);
console.log(`  Bills carry a Contact:        ${invoices.some(i => i.Contact?.Name) ? 'YES' : 'NO'}\n`);

const lineCount = invoices.reduce((n, i) => n + (i.LineItems?.length ?? 0), 0);
console.log(`VOLUME: ${lineCount} line(s) across ${invoices.length} bill(s) in one month.`);
console.log(`  Two years at this rate is roughly ${(lineCount * 24).toLocaleString()} rows per venue.\n`);

/**
 * Account codes and how many lines hit each -- no amounts, no descriptions.
 *
 * This answers whether the drill-down is worth building: if marketing spend
 * lands on a handful of coded lines, "26,034 on what" becomes answerable. If
 * everything lands on one uncoded catch-all, it does not.
 */
const byAccount = new Map<string, number>();
for (const inv of invoices) {
  for (const line of inv.LineItems ?? []) {
    const key = line.AccountCode ? String(line.AccountCode) : 'no account code';
    byAccount.set(key, (byAccount.get(key) ?? 0) + 1);
  }
}

console.log(`ACCOUNT CODES POSTED TO (${byAccount.size}) — codes and line counts only:`);
for (const [code, count] of [...byAccount].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${code.padEnd(20)} ${count}`);
}

console.log(`
WHAT TO LOOK FOR

  AccountCode present  -> a bill line can be attributed to the P&L account it
                          landed in, which is what makes "26,034 on what"
                          answerable. Without it this is a list of bills with
                          nowhere to put them.
  Contact present      -> supplier names. Business names, not personal data --
                          but a sole trader's bill carries a person's name, so
                          the same care applies as anywhere else.
  Volume               -> decides whether this is a table or a rabbit hole.
  'no account code'    -> lines Xero holds without a code. If that number is
                          large, attribution is partial and any total built from
                          it must say so.
`);

process.exit(0);
