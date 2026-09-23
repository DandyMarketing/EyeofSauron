/**
 * The MOE school calendar, parsed from the authority rather than from a blog.
 *
 * WHY IT EXISTS. CLAUDE.md recorded school terms as a known gap and told the
 * engine to say so rather than fill it: "School terms are genuinely not held:
 * say they are missing rather than going to find them." That was the right call
 * while the only sources were holiday blogs. The Ministry of Education
 * publishes the calendar itself, machine-readable, at moe.gov.sg/calendar --
 * so this is the source rather than a report of it, the same standing MOM has
 * for public holidays in migration 040.
 *
 * WHY A RESTAURANT CARES. A four-week June vacation and a six-week year-end one
 * empty the family trade and move the rest of it earlier in the evening. A week
 * containing a term break is not comparable to the week before it, and until
 * now nothing in this system could say which weeks those were -- the briefing
 * for Neon Pigeon on 22 Sep 2026 had to end a whole section with "if you think
 * a term break is in play, that one needs a human check".
 *
 * PUBLIC HOLIDAYS ARE DELIBERATELY NOT INGESTED FROM HERE. MOE's feed carries
 * them, and `public_holidays` already holds them from the Ministry of Manpower,
 * which is the body that gazettes them. Taking both would give two figures for
 * one fact that disagree at the edges -- the Monday-versus-Revel problem
 * CLAUDE.md names, bought voluntarily. `INGESTED_CATEGORIES` is the guard.
 */

/** One row of MOE's listing view. Dates are ISO; a single day has start == end. */
export interface CalendarEvent {
  start_date: string;
  end_date: string;
  /** The event without its level parenthetical: "Term 1", "Teachers' Day". */
  name: string;
  /** MOE's own category, verbatim: "School terms" or "School holidays". */
  category: string;
  /** The parenthetical, when there was one: "MK, Primary & Secondary". */
  level: string | null;
}

/**
 * What we take, and therefore what we leave.
 *
 * "Public holidays" is excluded on the two-sources argument above.
 * "GIRO deductions" is school fee collection and has nothing to do with trade.
 * "National exams" is excluded because the ranges are windows rather than
 * events -- MOE lists the 2026 O-Levels as 2 Jun to 10 Nov, five months, which
 * covers half the trading year and would mark almost any week as an exam week.
 * The ingest can see them if that is ever wanted; adding the string here is the
 * whole change.
 */
export const INGESTED_CATEGORIES = ['School terms', 'School holidays'];

const DAY_MS = 86_400_000;

const toUtc = (iso: string): number => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`school-calendar: not a date: ${iso}`);
  return t;
};

const decode = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Split "Term 1 (MK, Primary & Secondary)" into a name and a level.
 *
 * Only a parenthetical at the END is taken, because MOE's exam titles carry
 * brackets in the middle -- "GCE N(A)- and N(T)" -- and treating those as a
 * level would produce a level of "A" on an event nobody can read.
 */
export function splitLevel(title: string): { name: string; level: string | null } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(title);
  if (!m || m[1].trim() === '') return { name: title.trim(), level: null };
  return { name: m[1].trim(), level: m[2].trim() };
}

/**
 * Read MOE's listing view out of the page.
 *
 * The markup is stable and structured in the way that matters: every event is a
 * `tr.fc-list-item` carrying `data-start` and, for a range, `data-end` as ISO
 * dates. The visible "Friday, 02 Jan 2026 - Friday, 13 Mar 2026" text is
 * ignored entirely -- a prose date is a parser's way of being wrong quietly,
 * and the press-release tables that carry only prose also carry footnote
 * markers glued to the dates ("Fri 19 Nov 2"), which is precisely the trap.
 *
 * IT RETURNS WHAT IT SAW, INCLUDING CATEGORIES WE DO NOT WANT, so the caller
 * can tell "the filter removed them" from "the page changed and we parsed
 * nothing". Those two look identical from an empty list.
 */
export function parseMoeCalendar(html: string): {
  events: CalendarEvent[];
  categories: Record<string, number>;
} {
  const events: CalendarEvent[] = [];
  const categories: Record<string, number> = {};

  const rows = html.split(/<tr\b/i).slice(1);

  for (const row of rows) {
    const start = /data-start="(\d{4}-\d{2}-\d{2})"/.exec(row)?.[1];
    if (!start) continue;

    const title = /<h2[^>]*class="[^"]*event-l-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(row)?.[1];
    const type = /<div[^>]*class="[^"]*event-l-type[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(row)?.[1];
    if (!title || !type) continue;

    const category = decode(type);
    categories[category] = (categories[category] ?? 0) + 1;

    // No data-end is a single-day event, not an open-ended one. Collapsing it
    // to start == end keeps every consumer on one shape.
    const end = /data-end="(\d{4}-\d{2}-\d{2})"/.exec(row)?.[1] ?? start;
    const { name, level } = splitLevel(decode(title));

    events.push({ start_date: start, end_date: end, name, category, level });
  }

  return { events, categories };
}

/** How many days of `event` fall inside [start, end]. Zero when they miss. */
export function overlapDays(
  event: { start_date: string; end_date: string },
  start: string,
  end: string,
): number {
  const lo = Math.max(toUtc(event.start_date), toUtc(start));
  const hi = Math.min(toUtc(event.end_date), toUtc(end));
  return hi < lo ? 0 : Math.round((hi - lo) / DAY_MS) + 1;
}

export interface HolidayCoverage {
  /** Days of the period that fell in a school holiday. */
  days: number;
  /** Days in the period. */
  period_days: number;
  pct: number;
  /** True when every day of the period was a school holiday. */
  whole_period: boolean;
  /** The holidays that touched it, longest overlap first. */
  overlapping: Array<{ name: string; start_date: string; end_date: string; days_in_period: number }>;
}

/**
 * How much of a period was school holiday, which is the figure an operator
 * actually wants.
 *
 * COUNTED ON DISTINCT DAYS, not by summing the events. MOE lists the same break
 * twice, once for MK/Primary/Secondary and once for Post-secondary, and the two
 * usually carry identical dates -- adding their overlaps would report a
 * nine-day break as eighteen days inside a seven-day week. The bug would be
 * invisible because the number would still look like a number.
 */
export function holidayCoverage(
  events: CalendarEvent[],
  start: string,
  end: string,
): HolidayCoverage {
  const periodDays = Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1;

  const holidays = events.filter(e => e.category === 'School holidays');
  const covered = new Set<number>();
  const overlapping: HolidayCoverage['overlapping'] = [];

  for (const e of holidays) {
    const days = overlapDays(e, start, end);
    if (days === 0) continue;

    overlapping.push({
      name: e.level ? `${e.name} (${e.level})` : e.name,
      start_date: e.start_date,
      end_date: e.end_date,
      days_in_period: days,
    });

    const lo = Math.max(toUtc(e.start_date), toUtc(start));
    for (let d = 0; d < days; d++) covered.add(lo + d * DAY_MS);
  }

  overlapping.sort((a, b) => b.days_in_period - a.days_in_period || a.start_date.localeCompare(b.start_date));

  return {
    days: covered.size,
    period_days: periodDays,
    pct: periodDays === 0 ? 0 : Math.round((covered.size / periodDays) * 1000) / 10,
    whole_period: periodDays > 0 && covered.size === periodDays,
    overlapping,
  };
}
