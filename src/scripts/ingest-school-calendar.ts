import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { parseMoeCalendar, INGESTED_CATEGORIES } from '../lib/school-calendar.js';

/**
 * The MOE school calendar, from the ministry rather than from a blog.
 *
 * WHY IT IS A JOB AND NOT A SEED, for everything from the current year on.
 * moe.gov.sg/calendar server-renders ONE year -- whichever one it is now, plus
 * next year behind a client-side tab this cannot reach. So the far end of this
 * table goes stale exactly like the holidays one, and for the same reason: a
 * query for a year nobody ingested returns nothing and reads as a year with no
 * school holidays. Run it when the year turns, and after MOE publishes the
 * following year (they say "by end August").
 *
 * The back years are seeded in migration 045 instead, because 2025 has already
 * dropped off the live page and a finished year cannot go stale.
 *
 * WHY THE HTML AND NOT AN API. There isn't one. No .ics, no JSON endpoint --
 * the page is a Next.js app that renders the listing view server-side. What it
 * does render is properly structured: every event is a table row carrying
 * `data-start` and `data-end` as ISO dates, so the parser never reads a prose
 * date. That distinction matters: the press-release tables carry ONLY prose
 * dates, with footnote markers glued to them ("Fri 19 Nov 2").
 */

const SOURCE_URL = 'https://www.moe.gov.sg/calendar';

const res = await fetch(SOURCE_URL, {
  headers: { 'user-agent': 'Sauron/1.0 (+internal analytics; contact via The Dandy Collection)' },
});

if (!res.ok) {
  console.error(`moe.gov.sg refused: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const { events, categories } = parseMoeCalendar(await res.text());

console.log(`MOE academic calendar — ${events.length} event(s) parsed from ${SOURCE_URL}`);
for (const [cat, n] of Object.entries(categories).sort()) {
  const taken = INGESTED_CATEGORIES.includes(cat);
  console.log(`  ${taken ? 'take' : 'skip'}  ${String(n).padStart(3)}  ${cat}`);
}

/**
 * A PARSE THAT FOUND NOTHING IS FATAL, and so is one that found events but none
 * of the categories we want.
 *
 * Those are the two shapes a silent failure takes here. MOE could restyle the
 * page tomorrow and this would go on succeeding with zero rows written, which
 * is the class of defect BUILD_LOG records most often: it worked, it looked
 * fine, it was doing nothing. An empty write is never a valid outcome for a
 * calendar that is published every year without fail.
 */
if (events.length === 0) {
  console.error('\nParsed ZERO events. The page structure has changed — fix the parser.');
  console.error('Expected rows of the form: <tr class="fc-list-item" data-start="YYYY-MM-DD" ...>');
  process.exit(1);
}

const wanted = events.filter(e => INGESTED_CATEGORIES.includes(e.category));

if (wanted.length === 0) {
  console.error(`\nParsed ${events.length} event(s) and NONE were ${INGESTED_CATEGORIES.join(' or ')}.`);
  console.error('Either MOE renamed its categories or the calendar is showing a filtered view.');
  process.exit(1);
}

const rows = wanted.map(e => ({
  start_date: e.start_date,
  end_date: e.end_date,
  name: e.name,
  category: e.category,
  // '' rather than null: the column is part of the key. See migration 045.
  level: e.level ?? '',
  source: 'Ministry of Education',
  source_url: SOURCE_URL,
  origin: 'fetched',
  fetched_at: new Date().toISOString(),
}));

const { error } = await supabase
  .from('school_calendar')
  .upsert(rows, { onConflict: 'start_date,name,level' });

if (error) {
  console.error(`Write failed: ${error.message}`);
  process.exit(1);
}

const years = [...new Set(rows.map(r => r.start_date.slice(0, 4)))].sort();
const holidays = rows.filter(r => r.category === 'School holidays').length;

console.log(`\nWrote ${rows.length} row(s) covering ${years.join(', ')}.`);
console.log(`${holidays} school holiday(s), ${rows.length - holidays} term(s).`);

/**
 * Say when the calendar runs out, against the WHOLE table rather than this run.
 *
 * This is the holidays script's warning and it is the only way this table can
 * be wrong. A missing year is invisible from the query side: it returns an
 * empty list, which reads as a period with no school holidays in it -- during
 * the June break, the single most wrong thing this table could say.
 */
const { data: newest } = await supabase
  .from('school_calendar')
  .select('end_date')
  .order('end_date', { ascending: false })
  .limit(1);

const coveredTo = newest?.[0]?.end_date ?? null;
console.log(`The warehouse calendar now runs to ${coveredTo ?? 'nothing'}.`);

const thisYear = new Date().getUTCFullYear();
if (coveredTo !== null && Number(coveredTo.slice(0, 4)) <= thisYear) {
  console.error(`\nNext year is NOT in here. A query for it would return nothing and read as`);
  console.error('a year with no school holidays. MOE publishes the following year by end August —');
  console.error('re-run this then, or the first briefing of January will be wrong and quiet about it.');
}
