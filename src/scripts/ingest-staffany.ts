import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { staffAnyKey, fetchSections, fetchWorkHours } from '../lib/staffany-client.js';
import { aggregateWorkHours, DAY_ENDS_AT_HOUR, type SectionMapping } from '../ingest/staffany.js';

/**
 * Pull clocked labour from StaffAny and store it aggregated.
 *
 * WINDOW. Defaults to the last 14 days, because a timesheet is edited after the
 * fact -- a manager fixes a missed clock-out days later -- so re-reading a
 * closed fortnight every night is how the corrections arrive. `--days=` widens
 * it and `--start=`/`--end=` set it outright for a backfill.
 *
 * WHAT IT REPORTS AND WHY. Unmapped sections, skipped rows and costless rows
 * are printed on every run and counted toward the exit code. An exclusion
 * nobody can see is indistinguishable from one that stopped working, which is
 * the rule the Xero payroll exclusion already follows.
 */

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];

const DAYS = Number(arg('days') ?? 14);
const today = new Date();
const END = arg('end') ?? today.toISOString().slice(0, 10);
const START = arg('start') ?? new Date(Date.parse(`${END}T00:00:00Z`) - (DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

/**
 * The window is widened by a day at each end before it is sent.
 *
 * `startTime` is UTC and the business date is Singapore-local with a 6am cut,
 * so a shift belonging to the first day of the window can carry a UTC timestamp
 * before it, and one belonging to the last day can carry a timestamp after it.
 * Asking for exactly the window would clip both ends -- quietly, and only on
 * the late shifts, which are the expensive ones.
 */
const fromMs = Date.parse(`${START}T00:00:00Z`) - 86_400_000;
const toMs = Date.parse(`${END}T00:00:00Z`) + 2 * 86_400_000 - 1000;

console.log(`StaffAny labour ingest — business dates ${START} to ${END}`);
console.log(`Day ends at ${DAY_ENDS_AT_HOUR}:00 Singapore time; a later shift belongs to the night it started.\n`);

const key = staffAnyKey();

// --- keep the section list current ------------------------------------------
//
// Recorded on every run so a NEW section appears in the admin console the day
// it is created, rather than the day somebody notices labour is missing. It is
// inserted UNMAPPED: venue and area are left null for a person to confirm.
const sections = await fetchSections(key);
console.log(`${sections.length} section(s) in StaffAny`);

for (const s of sections) {
  // Section name and tag are refreshed; venue_id and area are NOT touched, so a
  // rename in StaffAny can never silently unmap a confirmed section.
  const { error } = await supabase
    .from('staffany_sections')
    .upsert(
      { staffany_section_id: s.id, section_name: s.name, section_tag: s.tag },
      { onConflict: 'staffany_section_id', ignoreDuplicates: false },
    );
  if (error) console.error(`  could not record section ${s.name}: ${error.message}`);
}

/**
 * A section is MAPPED when somebody has decided what it is, which is not the
 * same as it having a venue.
 *
 * The group section is confirmed by being marked GROUP and having no venue at
 * all -- those hours are worked across every venue and are never allocated to
 * one here. Filtering on venue_id being present would leave the one section we
 * HAVE decided about sitting in the unmapped list for ever, looking exactly
 * like the one nobody had touched.
 */
const { data: mapRows, error: mapErr } = await supabase
  .from('staffany_sections')
  .select('staffany_section_id, section_name, venue_id, area')
  .not('area', 'is', null);

if (mapErr) {
  console.error(`Could not read the section mapping: ${mapErr.message}`);
  process.exit(1);
}

const mappings = (mapRows ?? []) as Array<SectionMapping & { section_name: string }>;
const groupSections = mappings.filter(m => m.venue_id === null).length;
console.log(`${mappings.length} of ${sections.length} section(s) are mapped (${groupSections} to no venue, as group staff)\n`);

if (mappings.length === 0) {
  // Not a crash, and not a success either. Nothing can be ingested until
  // somebody maps a section, and saying so beats writing zero rows quietly.
  console.error('NO SECTIONS ARE MAPPED. Open the admin console, give each StaffAny section');
  console.error('an area -- BOH or FOH with a venue, or GROUP with none -- then run this again.');
  process.exit(1);
}

// --- fetch and aggregate -----------------------------------------------------
//
// sectionIds is named EXPLICITLY. Omit it and the API narrows silently to the
// caller's own sections and returns 200 with zero rows -- BUILD_LOG 1.5, three
// days lost, and an ingest that would have run green every night writing
// nothing.
const allSectionIds = sections.map(s => s.id);
const page = await fetchWorkHours(key, allSectionIds, fromMs, toMs);

if (!page.first.ok) {
  console.error(`StaffAny refused: ${page.first.status} ${JSON.stringify(page.first.body).slice(0, 300)}`);
  process.exit(1);
}

console.log(`${page.rows.length} work-hour row(s) over ${page.pages} page(s)`);
if (page.truncated) {
  // Our ceiling, not the end of the data. Treating it as complete is the
  // failure this whole file guards against.
  console.error('TRUNCATED at the page ceiling — this window is INCOMPLETE. Narrow it and re-run.');
  process.exit(1);
}

const result = aggregateWorkHours(page.rows, mappings);

// Rows outside the requested business dates come from the widened fetch window
// and belong to days we are not writing.
const rows = result.rows.filter(r => r.business_date >= START && r.business_date <= END);

console.log(`${rows.length} venue-section-day row(s) to write`);
console.log(`${result.skipped_rows} row(s) skipped, ${result.costless_rows} row(s) carried no cost`);

if (result.unmapped_sections.length > 0) {
  const names = result.unmapped_sections
    .map(id => sections.find(s => s.id === id)?.name ?? id)
    .join(', ');
  console.error(`\nUNMAPPED SECTIONS carrying labour, NOT ingested: ${names}`);
  console.error('Map them in the admin console and re-run — timesheets can be re-fetched, so nothing is lost.');
}

// --- write -------------------------------------------------------------------

const fetchedAt = new Date().toISOString();
let written = 0;

for (let i = 0; i < rows.length; i += 200) {
  const batch = rows.slice(i, i + 200).map(r => ({ ...r, fetched_at: fetchedAt }));
  const { error } = await supabase
    .from('labour_daily')
    .upsert(batch, { onConflict: 'staffany_section_id,business_date' });

  if (error) {
    // Named and fatal. A failed batch that logs and continues is BUILD_LOG 1.4.
    console.error(`\nWrite failed on rows ${i}-${i + batch.length}: ${error.message}`);
    process.exit(1);
  }
  written += batch.length;
}

console.log(`\nWrote ${written} row(s).`);

const totals = rows.reduce(
  (a, r) => ({
    hours: a.hours + r.actual_hours,
    cost: a.cost + r.total_cost,
    overtime: a.overtime + r.overtime_cost,
  }),
  { hours: 0, cost: 0, overtime: 0 },
);

console.log(`Rostered labour: ${totals.hours.toFixed(1)} hours, ${totals.cost.toFixed(2)} cost, of which ${totals.overtime.toFixed(2)} overtime.`);

// Reported separately, because it is deliberately absent from every venue's
// labour percentage and a reader comparing this against the P&L needs to know
// it is sitting outside.
const groupRows = rows.filter(r => r.venue_id === null);
if (groupRows.length > 0) {
  const groupCost = groupRows.reduce((n, r) => n + r.total_cost, 0);
  console.log(`Of that, ${groupCost.toFixed(2)} is GROUP staff belonging to no venue — stored unallocated,`);
  console.log('so it is excluded from every venue labour percentage until somebody allocates it.');
}
console.log('This is ROSTERED labour cost, not total employment cost — it excludes employer');
console.log('CPF, SDL and leave accrual, so it should sit BELOW the Xero Wages and Salaries line.');

// An unmapped section carrying real labour is a configuration fault somebody
// has to fix, so it fails the run rather than being a line in a log nobody
// reads. Everything that COULD be written already has been.
if (result.unmapped_sections.length > 0) process.exit(1);
