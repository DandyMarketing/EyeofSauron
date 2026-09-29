import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { parseMoeCalendar, INGESTED_CATEGORIES } from '../lib/school-calendar.js';

/**
 * The MOE school calendar, from the ministry rather than from a blog.
 *
 * RUN IT BY HAND, ONCE A YEAR. It is a one-off that exits when it is done, so
 * it must never be a service's start command: Railway treats an exited process
 * as a crash and restarts it, which turns a yearly job into an endless one. On
 * 24 Sep 2026 this ran successfully as the Recommend service's command, was
 * left there, and re-fetched moe.gov.sg on every restart for five days -- while
 * the service it had replaced, the weekly briefing, did not run at all.
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

const html = await res.text();
const { events, categories } = parseMoeCalendar(html);

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
  /**
   * SAY WHAT WE GOT, DO NOT DIAGNOSE IT.
   *
   * This block used to assert "the page structure has changed — fix the
   * parser". On 29 Sep 2026 it fired, and the page had not changed at all:
   * fetched by hand the same hour it parsed 74 events exactly as before. The
   * run had been looping for five days -- a one-off script left as a service's
   * start command, restarted by Railway every time it exited -- and whatever
   * moe.gov.sg served that request was not the calendar.
   *
   * A failed fetch of that kind still returns HTTP 200, so `res.ok` is no help.
   * The difference between "they changed the page", "we were served a block
   * page" and "the proxy returned something else" is visible in the RESPONSE,
   * and nothing was printing it. An error message that names a cause it cannot
   * support sends somebody to fix the wrong thing -- which is what it did.
   */
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim().slice(0, 120);
  const text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim()
                   .slice(0, 300);

  console.error('\nParsed ZERO events. Here is what we actually received:');
  console.error(`  final url    ${res.url}`);
  console.error(`  status       ${res.status} ${res.statusText}`);
  console.error(`  content-type ${res.headers.get('content-type') ?? 'none'}`);
  console.error(`  bytes        ${html.length}`);
  console.error(`  <title>      ${title ?? 'none'}`);
  console.error(`  begins       ${text || '(no text)'}`);
  console.error('\nThe parser expects rows of the form:');
  console.error('  <tr class="fc-list-item" data-start="YYYY-MM-DD" ...><h2 class="event-l-title">');
  console.error(`  fc-list-item in this response: ${(html.match(/fc-list-item/g) ?? []).length}`);
  console.error(`  data-start   in this response: ${(html.match(/data-start="\d{4}-\d{2}-\d{2}"/g) ?? []).length}`);
  console.error('\nIf those two counts are ZERO and the title is not "Academic calendar | MOE",');
  console.error('we were served something other than the calendar — check whether this script is');
  console.error('being re-run in a loop. It is a ONE-OFF: run it once a year, never as a service');
  console.error('start command, because a script that exits is a service Railway keeps restarting.');
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
