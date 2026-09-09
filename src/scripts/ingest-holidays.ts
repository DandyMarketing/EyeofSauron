import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

/**
 * Singapore public holidays, from the authority rather than from a blog.
 *
 * WHY IT IS A JOB AND NOT A SEEDED MIGRATION. Holidays are gazetted a year or
 * so ahead, so the far end of this table goes stale on a schedule. A seed would
 * be correct on the day it was written and quietly wrong the following January,
 * which is the shape of failure this codebase keeps finding. Run it yearly, or
 * whenever somebody asks a question about a year that is not in here.
 *
 * THE SOURCE IS THE MINISTRY OF MANPOWER, published through data.gov.sg. MOM
 * gazettes these days, so this is the source rather than a report of it. That
 * distinction is the whole argument for the table: the weekly run was reading
 * two dozen holiday blogs per venue and quoting none of them.
 */

const DATASET = 'd_8ef23381f9417e4d4254ee8b4dcdb176';
const SOURCE_URL = `https://data.gov.sg/datasets/${DATASET}/view`;

/**
 * PostgREST is not the only thing with a page cap.
 *
 * datastore_search defaults to a handful of rows and the whole consolidated set
 * is barely a hundred, so one generous page covers every year they publish --
 * but the total is checked against what came back rather than assumed, because
 * "the first page" and "all of it" looking identical is BUILD_LOG section 1 in
 * five places already.
 */
const LIMIT = 1000;

interface HolidayRecord { date?: string; day?: string; holiday?: string }

const res = await fetch(
  `https://data.gov.sg/api/action/datastore_search?resource_id=${DATASET}&limit=${LIMIT}`,
);

if (!res.ok) {
  console.error(`data.gov.sg refused: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const body: any = await res.json();
const result = body?.result ?? {};
const records: HolidayRecord[] = Array.isArray(result.records) ? result.records : [];
const total = Number(result.total);

console.log(`Singapore public holidays — ${records.length} row(s) of ${total} reported by data.gov.sg`);

if (records.length === 0) {
  console.error('No records returned. Nothing written.');
  process.exit(1);
}

if (Number.isFinite(total) && records.length < total) {
  // Named and fatal: a partial calendar is worse than none, because a missing
  // holiday reads as an ordinary day and nothing would ever say otherwise.
  console.error(`INCOMPLETE — got ${records.length} of ${total}. Raise the limit and re-run.`);
  process.exit(1);
}

const rows = records
  .filter(r => typeof r.date === 'string' && typeof r.holiday === 'string')
  .map(r => ({
    holiday_date: r.date!,
    name: r.holiday!,
    weekday: r.day ?? '',
    /**
     * A gazetted day-in-lieu, which the source marks in the NAME.
     *
     * Read into its own column so a query can ask for one without matching on
     * a string, and kept as a separate row rather than folded into the holiday
     * it follows: when National Day falls on a Sunday, the Monday after is the
     * day that actually changes a restaurant's covers.
     */
    is_observed: /observed/i.test(r.holiday!),
    source: 'Ministry of Manpower via data.gov.sg',
    source_url: SOURCE_URL,
    fetched_at: new Date().toISOString(),
  }));

const { error } = await supabase
  .from('public_holidays')
  .upsert(rows, { onConflict: 'holiday_date' });

if (error) {
  console.error(`Write failed: ${error.message}`);
  process.exit(1);
}

const years = [...new Set(rows.map(r => r.holiday_date.slice(0, 4)))].sort();
const observed = rows.filter(r => r.is_observed).length;

console.log(`Wrote ${rows.length} holiday(s) covering ${years[0]} to ${years[years.length - 1]}.`);
console.log(`${observed} of them are gazetted days-in-lieu.`);

/**
 * Say when the calendar runs out.
 *
 * The far end going stale is the ONLY way this table can be wrong, and a
 * missing year is invisible: a query for 2028 would return nothing and read as
 * a year with no public holidays.
 */
const thisYear = new Date().getUTCFullYear();
const lastYear = Number(years[years.length - 1]);
if (lastYear <= thisYear) {
  console.error(`\nThe calendar ends in ${lastYear}. Next year is NOT in here — a query for it would`);
  console.error('return nothing and read as a year with no holidays. Re-run once MOM gazettes it.');
}
