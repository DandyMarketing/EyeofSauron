import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { getAccessToken } from '../ingest/xero.js';

/**
 * What the general ledger actually looks like, before designing a table for it.
 *
 * The P&L answers "marketing cost 26,034 in June". It cannot answer "on what",
 * because Xero aggregates by account before the report reaches us. The Journals
 * endpoint is the level beneath: every posting, with its account, date, amount
 * and the source document behind it.
 *
 * TWO QUESTIONS, and only one is technical.
 *
 * The technical one is shape: what fields come back, how the source document is
 * referenced, whether a supplier name is reachable.
 *
 * The other is PAYROLL, and it is the reason this is a probe rather than an
 * ingestion. Journals carry every wage posting. The security model says the
 * strongest protection is not to ingest personal pay at all -- and whether
 * that is even a risk here depends entirely on how this bookkeeper posts
 * payroll: one summary journal per month, or a line per employee. Nobody can
 * answer that from documentation, and guessing wrong in the permissive
 * direction puts personal data in a warehouse it was never meant to reach.
 *
 * Reports SHAPE and account names only. No amounts against names, no
 * descriptions -- a probe that prints a payroll line into a deploy log has
 * already done the thing it was written to prevent.
 */

const XERO_API = 'https://api.xero.com/api.xro/2.0';

const venueSlug = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1] ?? 'neon-pigeon';
const sinceDate = process.argv.find(a => a.startsWith('--since='))?.split('=')[1] ?? '2026-06-01';

console.log(`Probing Xero journals — ${venueSlug}, from ${sinceDate}. Read-only, nothing is stored.\n`);

const { data: conn } = await supabase
  .from('xero_connections')
  .select('tenant_id, tenant_name, venue_id, venues(name, slug)')
  .not('venue_id', 'is', null);

const target = (conn ?? []).find((c: any) => c.venues?.slug === venueSlug);
if (!target) {
  console.error(`No mapped Xero connection for --venue=${venueSlug}.`);
  process.exit(1);
}

const t = target as any;
console.log(`${t.tenant_name} → ${t.venues?.name}\n`);

const accessToken = await getAccessToken(t.tenant_id);

/**
 * Journals page by journal NUMBER, not by date -- `offset` means "give me
 * journals after this number", and there is no date filter on the endpoint.
 * `If-Modified-Since` narrows by when a journal was last touched, which is not
 * the same as its accounting date, so a date-bounded pull has to page and
 * filter rather than ask.
 */
const res = await fetch(`${XERO_API}/Journals?offset=0`, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Xero-tenant-id': t.tenant_id,
    Accept: 'application/json',
    'If-Modified-Since': `${sinceDate}T00:00:00`,
  },
});

const text = await res.text();

if (!res.ok) {
  console.error(`Journals request failed: ${res.status}`);
  console.error(text.slice(0, 400));
  console.error('\nA 403 here usually means the accounting.journals.read scope was not granted.');
  console.error('That is a re-consent, not a code change: the OAuth scopes are fixed at connect time.');
  process.exit(1);
}

const journals = (JSON.parse(text)?.Journals ?? []) as any[];

if (journals.length === 0) {
  console.log('No journals returned. Either nothing posted since that date, or the scope is missing.');
  process.exit(0);
}

console.log(`${journals.length} journal(s) in the first page.\n`);

// Shape, from a real one. Field NAMES only -- the values are the ledger.
const sample = journals[0];
console.log('JOURNAL FIELDS:');
console.log(`  ${Object.keys(sample).join(', ')}\n`);

const sampleLine = (sample.JournalLines ?? [])[0] ?? {};
console.log('JOURNAL LINE FIELDS:');
console.log(`  ${Object.keys(sampleLine).join(', ')}\n`);

// Volume, because it decides whether this is a table or a rabbit hole.
const lineCount = journals.reduce((n, j) => n + (j.JournalLines?.length ?? 0), 0);
console.log(`  ${lineCount} line(s) across ${journals.length} journal(s) — about ${Math.round(lineCount / journals.length)} per journal.`);
console.log(`  Journal numbers ${journals[0]?.JournalNumber} → ${journals[journals.length - 1]?.JournalNumber}\n`);

// Source types tell us where postings come from: bills, invoices, manual
// journals, payroll runs. This is the field that decides how payroll can be
// excluded.
const sources = new Map<string, number>();
for (const j of journals) sources.set(j.SourceType ?? 'unknown', (sources.get(j.SourceType ?? 'unknown') ?? 0) + 1);
console.log('SOURCE TYPES:');
for (const [type, count] of [...sources].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(type).padEnd(24)} ${count}`);
}

/**
 * Account names only, with no amounts beside them.
 *
 * This is the payroll question, and it is answered by the SHAPE of the account
 * list rather than by any figure. If wages arrive as one "Wages and Salaries"
 * line, there is nothing personal here. If they arrive as a line per person,
 * the names will be visible in this list and the answer is that payroll
 * accounts must be excluded at ingest, before anything is written down.
 */
const accounts = new Map<string, number>();
for (const j of journals) {
  for (const line of j.JournalLines ?? []) {
    const name = line.AccountName ?? line.AccountCode ?? 'unnamed';
    accounts.set(name, (accounts.get(name) ?? 0) + 1);
  }
}

console.log(`\nACCOUNTS POSTED TO (${accounts.size}) — names and posting counts only, no amounts:`);
for (const [name, count] of [...accounts].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  console.log(`  ${String(name).padEnd(40)} ${count}`);
}

console.log(`
WHAT TO LOOK FOR

  Payroll accounts     -> if wages appear as ONE account ("Wages and Salaries"),
                          there is no personal data here. If a line per person
                          appears, payroll accounts must be excluded at ingest
                          and never written down.
  SourceType values    -> ACCPAY is a supplier bill and is the one that answers
                          "marketing cost 26,034 on what". A payroll source type
                          is what an exclusion rule can key on.
  Lines per journal    -> decides the size of the table. Two years at this rate
                          is the number that matters, not one page.
`);

process.exit(0);
