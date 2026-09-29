/**
 * Finding the events worth comparing against.
 *
 * THE RULE IS ONE SHARED POINT, not one matching type. Khai's: this group
 * repeats events, the big days above all, and any single point in common is
 * enough to be worth a look -- this Valentine's against last Valentine's. So
 * comparison is an OVERLAP over several attributes rather than equality on one,
 * and the number of attributes that matched is returned with every result,
 * because a match on format alone and a match on occasion, venue and partner
 * are not the same claim and must not read alike.
 *
 * THE REACH IS THE PREVIOUS OCCURRENCE, NOT A WINDOW OF DAYS. Measured against
 * MOM's calendar: Deepavali 2025 to 2026 is 384 days, Chinese New Year 383,
 * Good Friday 2024 to 2025 385. A 365-day lookback from Deepavali 2026 reaches
 * 8 November 2025 and misses last Deepavali, on 20 October, by nineteen days --
 * the single most valuable comparison there is, on the kind of day most likely
 * to be repeated.
 *
 * And it fails SELECTIVELY, which is the part that would have survived. Every
 * occasion anybody reaches for first -- Valentine's, Christmas, New Year's Eve,
 * National Day -- is a fixed date at exactly 365 days and compares perfectly.
 * Only the lunar and lunisolar days break.
 */

export const COMPARISON_ATTRIBUTES = [
  'occasion',
  'venue',
  'concept_type',
  'partner',
  'format',
  'demographic',
] as const;

export type Attribute = (typeof COMPARISON_ATTRIBUTES)[number];

export interface EventLike {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  occasion: string | null;
  concept_type: string | null;
  partner: string | null;
  format: string | null;
  demographic: string | null;
  /** Venue slugs this event ran at, from event_venues. */
  venue_slugs: string[];
}

/** What we are looking for. Every field optional — an empty brief matches nothing. */
export interface Criteria {
  occasion?: string | null;
  concept_type?: string | null;
  partner?: string | null;
  format?: string | null;
  demographic?: string | null;
  venue_slugs?: string[];
  /** Exclude this event from its own results. */
  exclude_id?: string;
  /** Only consider events that started before this. */
  before?: string;
}

export interface Match {
  event: EventLike;
  /** Which attributes matched. Never empty — a zero-overlap event is not returned. */
  shared: Attribute[];
  days_before: number | null;
}

/**
 * Loose equality for a free-text tag.
 *
 * Case and punctuation are stripped, so "Valentine's Day" matches "valentines
 * day". THIS DOES NOT SOLVE SYNONYMS and must not be described as if it does:
 * "CNY" and "Chinese New Year" are the same occasion and will not match here,
 * which is `account_map` all over again -- the same thing named differently by
 * different people. The fix is at entry rather than at read: the tagging
 * interface should offer the values already in use and let somebody pick, so
 * the second Deepavali is spelled like the first. Until it does, the caveats
 * say so.
 */
const norm = (v: string | null | undefined): string =>
  (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const same = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = norm(a);
  // An absent value on either side is not a match. Two events with no partner
  // recorded do not "share a partner" -- they share a blank, and counting that
  // would rank every unspecified event above a real one.
  return x !== '' && x === norm(b);
};

const DAY_MS = 86_400_000;
const asUtc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/** Which of the comparison attributes this event shares with the criteria. */
export function sharedAttributes(criteria: Criteria, event: EventLike): Attribute[] {
  const shared: Attribute[] = [];

  if (same(criteria.occasion, event.occasion)) shared.push('occasion');

  if (criteria.venue_slugs?.length && event.venue_slugs.length) {
    if (criteria.venue_slugs.some(s => event.venue_slugs.includes(s))) shared.push('venue');
  }

  if (same(criteria.concept_type, event.concept_type)) shared.push('concept_type');
  if (same(criteria.partner, event.partner)) shared.push('partner');
  if (same(criteria.format, event.format)) shared.push('format');
  if (same(criteria.demographic, event.demographic)) shared.push('demographic');

  return shared;
}

/**
 * Comparable events, most alike first.
 *
 * ORDERED BY OVERLAP THEN BY RECENCY, and never by date alone. An event sharing
 * occasion, venue and partner from two years ago tells you more than one
 * sharing only a format from last month, and sorting by date would bury it.
 *
 * NOTHING IS FILTERED BY A DATE WINDOW HERE. The caller decides how far back to
 * look and, for a shared occasion, the answer is "the previous one" whatever
 * the gap -- see the file header for why a year is the wrong instrument.
 */
export function rankComparable(
  criteria: Criteria,
  candidates: EventLike[],
  reference?: string,
): Match[] {
  const out: Match[] = [];

  for (const event of candidates) {
    if (criteria.exclude_id && event.id === criteria.exclude_id) continue;
    if (criteria.before && event.start_date >= criteria.before) continue;

    const shared = sharedAttributes(criteria, event);
    if (shared.length === 0) continue;

    out.push({
      event,
      shared,
      days_before: reference
        ? Math.round((asUtc(reference) - asUtc(event.start_date)) / DAY_MS)
        : null,
    });
  }

  return out.sort((a, b) =>
    b.shared.length - a.shared.length ||
    b.event.start_date.localeCompare(a.event.start_date));
}

/**
 * The most recent earlier event sharing the occasion, at any distance.
 *
 * Returned separately from the ranked list even though it is usually in it,
 * because it is the comparison somebody actually asked for -- "what did last
 * Deepavali do" -- and it should not have to be picked out of a list by the
 * reader or by the model.
 */
export function previousOccurrence(
  occasion: string | null | undefined,
  candidates: EventLike[],
  before: string,
  excludeId?: string,
): EventLike | null {
  if (!norm(occasion)) return null;

  const earlier = candidates
    .filter(e => e.id !== excludeId && e.start_date < before && same(occasion, e.occasion))
    .sort((a, b) => b.start_date.localeCompare(a.start_date));

  return earlier[0] ?? null;
}

/**
 * What to say about what was found, including when nothing was.
 *
 * THE EMPTY CASE IS THE ONE THAT MATTERS FOR THE NEXT YEAR. There is no
 * backfill: the store started empty in September 2026 and fills forward, so
 * "nothing on record" will be the most common answer for about twelve months.
 * It must never be allowed to read as "this has never been done here" -- the
 * same distinction migration 044 had to teach the retention measure, where an
 * empty lookback was being reported as a guest who had never visited.
 */
export function comparabilityCaveats(matches: Match[], criteria: Criteria): string[] {
  const notes: string[] = [];

  if (matches.length === 0) {
    notes.push(
      'NO COMPARABLE EVENT ON RECORD. This means the events store holds nothing matching — ' +
      'NOT that the group has never done this. The store began in September 2026 and was not ' +
      'backfilled, so anything earlier is absent by construction. Say "we have no record of a ' +
      'comparable event", never "this has not been tried".',
    );
    return notes;
  }

  const weak = matches.filter(m => m.shared.length === 1).length;
  if (weak === matches.length) {
    notes.push(
      `Every match shares exactly ONE attribute with this concept. That is the weakest kind of ` +
      `comparison — two events sharing only a format are barely related — so present these as ` +
      `loosely similar and do not build a forecast on them.`,
    );
  } else if (weak > 0) {
    notes.push(
      `${weak} of ${matches.length} match(es) share only ONE attribute. Rank your reading by the ` +
      `shared list on each: occasion plus venue plus partner is a real precedent, format alone is not.`,
    );
  }

  if (criteria.occasion && !matches.some(m => m.shared.includes('occasion'))) {
    notes.push(
      `Nothing on record shares the occasion "${criteria.occasion}", so none of these is a ` +
      `year-on-year comparison. Note that an occasion spelled differently will not match — ` +
      `"CNY" and "Chinese New Year" are the same day and different strings.`,
    );
  }

  return notes;
}
