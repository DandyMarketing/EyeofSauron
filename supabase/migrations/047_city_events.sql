-- What else is on in Singapore, and who it takes.
--
-- WHY THIS EXISTS, and it is a specific failure rather than a gap somebody
-- noticed. On 30 Sep 2026 the planning agent was asked to plan an event for
-- 10 October and said nothing about it. The 10th is race Saturday of the
-- Singapore Grand Prix, and Amber Lounge runs that night at Clifford Pier with
-- passes from $850. The agent did not push back, did not name the clash, and
-- happily began planning a dinner into one of the busiest and most distorted
-- nights of the Singapore year.
--
-- IT WAS NOT THE MODEL'S FAULT, or not only. Nothing in this warehouse knew.
-- F1 is not a public holiday so it is not in public_holidays; it is not a term
-- break so it is not in school_calendar; it is not ours so it is not in events.
-- The only route was a web search the agent had no reason to run.
--
-- AND SEARCHING IS THE WRONG ANSWER ANYWAY. The weekly briefing run on 29 Sep
-- searched exactly this and pulled FOURTEEN PAGES, cited none of them, and read
-- about 420,000 tokens of cache doing it -- the same waste migration 040
-- recorded for public holidays, where eleven searches across seventy-eight
-- pages produced zero citations. A race weekend is knowable a year ahead and
-- published by its organiser. It is a warehouse row, not a discovery.
--
-- THE PRICE BAND IS THE POINT, not decoration. Khai's framing: given the ticket
-- price of the competing event, theorise the demographic. Amber Lounge at $850
-- to $45,000 from 9pm is not competing for a $180 set-menu wallet -- it is a
-- PRE-PARTY DINNER at 7pm, which is a different approach and a different target
-- market rather than a reason to move the date. A clash and an opportunity look
-- identical on a calendar and are told apart by who can afford the other thing.
--
-- CONFIRMED BY A PERSON, like every other external fact here: revel_venue_keys,
-- the Xero tenant mapping, the account map. A row carries its source url, and
-- rows nobody has checked are flagged rather than trusted.

create table if not exists public.city_events (
  id   uuid primary key default gen_random_uuid(),
  name text not null,

  -- Inclusive, and a single-day event stores the same date twice — the shape
  -- school_calendar and events both use, so no overlap test special-cases.
  start_date date not null,
  end_date   date not null,
  check (end_date >= start_date),

  category text not null default 'other'
           check (category in ('sport', 'festival', 'concert', 'nightlife', 'conference', 'other')),

  -- Where in the city. Proximity matters: an event at Marina Bay reaches Telok
  -- Ayer and Craig Road in a way one in Jurong does not.
  location text,

  /**
   * Which larger thing this belongs to, as plain text.
   *
   * A race weekend is not one event, it is a weekend with satellites -- the
   * race, the concerts, half a dozen parties -- and a planner asking about a
   * Saturday needs all of them, not the one whose name they happened to
   * recall. Free text rather than a self-reference because the grouping is a
   * label people already use ("Singapore Grand Prix 2026"), not a hierarchy
   * anybody will maintain.
   */
  part_of text,

  -- --- the price band, which is what makes the reasoning possible ----------
  --
  -- Stored as a RANGE because these events are sold in tiers and the spread is
  -- the information: Amber Lounge runs $850 to $45,000, and a band that wide
  -- describes a different room from one that runs $60 to $90. Null where it is
  -- free or unknown; unknown must not be written as zero.
  ticket_price_low  numeric(10,2),
  ticket_price_high numeric(10,2),
  currency          text not null default 'SGD',

  -- Who goes, in words. The demographic read is JUDGEMENT and belongs to
  -- whoever is reasoning; this is the observed fact it reasons from.
  audience text,

  -- What it tends to do to trade nearby, where somebody knows. Deliberately
  -- free text and deliberately optional: an honest "nobody has measured this"
  -- beats a confident direction nobody checked.
  effect_notes text,

  -- --- provenance ----------------------------------------------------------
  source     text,
  source_url text,
  /**
   * Whether a person has checked it.
   *
   * FALSE IS NOT A FAULT, it is a state: a row added from a search is useful
   * and is not yet confirmed, and the query tool says which is which. The
   * alternative -- refusing to store anything unconfirmed -- is how the
   * calendar stays empty and the agent goes back to reading Wikipedia.
   */
  confirmed    boolean not null default false,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,

  created_at timestamptz not null default now(),

  -- A name and a start date identify it. Re-running a seed or adding the same
  -- festival twice from two sources should update rather than duplicate.
  unique (name, start_date)
);

comment on table public.city_events is
  'Third-party events in Singapore that move trade — race weekends, festivals, '
  'concerts, the big nightlife nights. Checked whenever a date is named, before '
  'anything else about an event is planned. The ticket price band is stored '
  'because it is what separates a CLASH from an OPPORTUNITY: a $850 party at '
  '9pm is a pre-party dinner at 7pm, not a competitor for the same wallet.';

create index if not exists city_events_dates_idx on public.city_events (start_date, end_date);

-- --- row-level security -----------------------------------------------------
--
-- Public information about the city, with no venue and no money of ours in it,
-- so every signed-in user may read it. It still gets a policy: the anon key is
-- public by design, and rls_audit() would report an unguarded table as a fault
-- every day.

alter table public.city_events enable row level security;

drop policy if exists "Signed-in users can read city events" on public.city_events;
create policy "Signed-in users can read city events"
  on public.city_events for select
  using (auth.uid() is not null);

-- --- the weekend that caused this -------------------------------------------
--
-- Seeded because it is the case in hand and because an empty calendar teaches
-- the agent that the check is pointless. Every figure below was read from the
-- named source on 30 Sep 2026, and every row is confirmed = false until a
-- person has looked: they came from a web search, which is exactly the standard
-- of evidence this table exists to improve on.
--
-- PODIUM LOUNGE IS DELIBERATELY ABSENT. Khai named it and it is certainly on,
-- but its 2026 dates and prices did not come back from a search I would quote,
-- and a guessed date in a table whose whole job is warning about dates would be
-- worse than the gap. Add it with what you know.

insert into public.city_events
  (name, start_date, end_date, category, location, part_of,
   ticket_price_low, ticket_price_high, audience, effect_notes, source, source_url)
values
  ('Formula 1 Singapore Grand Prix 2026', '2026-10-09', '2026-10-11', 'sport',
   'Marina Bay Street Circuit',
   'Singapore Grand Prix 2026',
   198, 5110,
   'Very wide. Walkabout tickets from about $198 put ordinary crowds in the city; hospitality from about $5,110 brings a separate, much higher-spending population. Heavily international.',
   'The single largest distortion of the Singapore trading year for anything near the bay. Roads close, the CBD empties of its usual weekday traffic and fills with visitors, and normal weekday patterns do not apply for the whole week. A venue near Telok Ayer or Craig Road is close enough to feel all of it.',
   'singaporegp.sg and F1 ticketing guides',
   'https://singaporegp.sg/en/'),

  ('Amber Lounge Singapore 2026', '2026-10-10', '2026-10-11', 'nightlife',
   'The Clifford Pier, 80 Collyer Quay',
   'Singapore Grand Prix 2026',
   850, 45000,
   'The top of the race-weekend market. Individual passes from $850 on the Saturday and $1,250 on the Sunday, tables from $7,500 and suites to $45,000. Drivers, teams, international guests.',
   'Doors at 9pm, running to 5am. NOT a competitor for a dinner service at that price point — somebody paying $850 for a 9pm party eats somewhere first, which makes this a pre-party window rather than a clash. Read it as an opportunity for an early, high-spend seating and a dead late service.',
   'amberlounge.com',
   'https://www.amberlounge.com/events/singapore-2026/')
on conflict (name, start_date) do nothing;
