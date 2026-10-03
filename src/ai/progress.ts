/**
 * What the chat shows while Sauron is working.
 *
 * WHY THIS EXISTS. A question that runs a twelve-round tool loop can take well
 * over a minute, and the only thing in front of the person asking was three
 * bouncing dots. A long answer and a crashed one looked identical -- which
 * server.ts already says in as many words at the /ask error handler: "A
 * six-minute answer and a crash look identical from the front end and are
 * nothing alike." This makes them different.
 *
 * THE LABELS ARE THE PRODUCT, NOT THE PLUMBING. "query_profit_and_loss" tells a
 * restaurant manager nothing; "Pulling the P&L — Neon Pigeon, June" tells them
 * it is working and on what. The phrasing is in plain language for the same
 * reason the charts and tables are: this is read on a phone between services,
 * by someone who has never seen our function names and should not have to.
 *
 * WHAT IS DELIBERATELY NOT HERE. The answer text is not streamed token by
 * token. Sauron's replies are mostly TABLES -- the system prompt requires one
 * for anything past about three numbers -- and a table streamed as raw markdown
 * is a wall of pipes and asterisks that only becomes readable at the end.
 * Progress while working, then the finished thing rendered properly, was
 * Khai's call on 3 Oct 2026 and it is the right one for this product.
 *
 * A LABEL MUST NEVER LEAK WHAT THE READER MAY NOT SEE. These phrases are built
 * from tool INPUTS, which the model chose, and are shown before the tool has
 * run -- so before enforceVenueScope() or enforceDomainScope() have refused
 * anything. A model that asks for another venue's P&L gets refused, but the
 * label would have said the venue's name out loud first. `labelFor` is given
 * the caller's allowed venues and renders anything else as a neutral phrase;
 * there is a test for it.
 */

/** One thing that happened, on its way to the browser. */
export type ProgressEvent =
  /** A model call has started. Sent once, at the top. */
  | { kind: 'thinking' }
  /** Queries are about to run. One event per round, with every label in it. */
  | { kind: 'working'; round: number; labels: string[] }
  /** The loop is done and the answer is being written. */
  | { kind: 'writing' }
  /** Something the reader should know about, mid-flight. Rare. */
  | { kind: 'note'; text: string };

/** How a venue is named to a reader: slug in, display name out. */
export type VenueNames = Record<string, string>;

/**
 * Tools whose names are not self-explanatory once prettified.
 *
 * Anything absent falls through to the generic rule below, which turns
 * `query_booking_lead_time` into "Reading booking lead time". That rule is good
 * enough for most of them, and this table only holds the ones where it is not:
 * an abbreviation a human would say differently, or a verb that is wrong.
 */
const PHRASES: Record<string, string> = {
  query_profit_and_loss: 'Pulling the P&L',
  query_supplier_bills: 'Opening the supplier bills',
  query_product_mix: 'Reading the product mix',
  query_daily_operations: 'Reading daily trade',
  compare_venues: 'Comparing venues',
  explain_revenue_change: 'Breaking down the revenue change',
  create_chart: 'Drawing the chart',
  create_composition_chart: 'Drawing the chart',
  list_available_data: 'Checking what data exists',
  check_booking_channels: 'Checking booking channels',
  query_public_holidays: 'Checking public holidays',
  query_school_calendar: 'Checking the school calendar',
  query_city_events: "Checking what else is on in town",
  query_events: 'Reading our own events',
  query_guest_retention: 'Reading guest retention',
  query_guest_cohorts: 'Reading guest cohorts',
  query_social_performance: 'Reading Instagram',
  query_top_posts: 'Reading the top posts',
  query_post_patterns: 'Reading post patterns',
  query_labour: 'Reading labour',
  web_search: 'Searching the web',
};

/**
 * `neon_pigeon` -> "Neon Pigeon", for a label and nothing else.
 *
 * The session carries a venue's SLUG and not its display name, and fetching
 * names would be a database round trip per question to decorate a status line.
 * A slug is derived from the name, so reversing it is reliable enough for this
 * one purpose and wrong nowhere that matters -- and it is NOT used for the
 * venue mapping CLAUDE.md insists a person confirms, which is about matching an
 * external key to an identity. This matches nothing; it capitalises a word.
 */
export function prettyVenue(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** `query_meal_period_sales` -> "Reading meal period sales". */
function generic(name: string): string {
  const words = name.replace(/^query_/, '').replace(/_/g, ' ').trim();
  if (!words) return 'Working';
  return `Reading ${words}`;
}

/**
 * The qualifier after the dash: which venue, and over what period.
 *
 * Built only from fields a tool actually takes, and only from values that are
 * safe to repeat. Anything unrecognised is left out rather than guessed at — a
 * label is a comfort, and a wrong one costs more than a missing one.
 */
function qualifier(input: Record<string, any>, allowed: VenueNames | null): string[] {
  const bits: string[] = [];

  const venue = input.venue ?? input.venue_slug ?? input.venue_name;
  if (typeof venue === 'string' && venue) {
    if (allowed === null) {
      // Unrestricted: an owner, or an internal caller with no user attached.
      // There is nobody here to keep a venue name from.
      bits.push(prettyVenue(venue));
    } else if (allowed[venue]) {
      bits.push(allowed[venue]);
    } else {
      /**
       * NOT the venue's name. The tool layer is about to refuse this, and a
       * label is drawn BEFORE that happens -- so printing what the model asked
       * for would announce a venue this reader is not allowed to know we hold.
       */
      bits.push('another venue');
    }
  }

  const from = input.start_date ?? input.from ?? input.period_start;
  const to = input.end_date ?? input.to ?? input.period_end;
  if (typeof from === 'string' && typeof to === 'string') {
    bits.push(`${from} to ${to}`);
  } else if (typeof from === 'string') {
    bits.push(`from ${from}`);
  } else if (typeof input.days === 'number') {
    bits.push(`last ${input.days} days`);
  } else if (typeof input.months === 'number') {
    bits.push(`last ${input.months} months`);
  }

  return bits;
}

/**
 * One tool call, as a sentence a venue manager would recognise.
 *
 * `allowedVenues` maps the slugs this reader may see to their display names.
 * Pass null ONLY for an internal caller with no user attached — the
 * recommendation engine — where there is no one to leak to.
 */
export function labelFor(
  name: string,
  input: Record<string, any> = {},
  allowedVenues: VenueNames | null = {},
): string {
  const head = PHRASES[name] ?? generic(name);
  const tail = qualifier(input, allowedVenues);
  return tail.length ? `${head} — ${tail.join(', ')}` : head;
}

/**
 * The labels for a whole round, with duplicates collapsed.
 *
 * A round routinely asks the same tool for two venues or two periods, and five
 * near-identical lines read as a stutter rather than as progress. Identical
 * labels collapse; different ones all show.
 */
export function labelsForRound(
  uses: { name: string; input?: Record<string, any> }[],
  allowedVenues: VenueNames | null = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of uses) {
    const label = labelFor(u.name, u.input ?? {}, allowedVenues);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * Serialise one event as an SSE frame.
 *
 * Kept here beside the type so the two cannot drift, and so the newline rule is
 * in one place: a payload containing a raw newline would terminate the frame
 * early and the browser would silently receive half an event. JSON.stringify
 * escapes them, which is why the payload is always JSON and never bare text.
 */
export function sseFrame(event: ProgressEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
