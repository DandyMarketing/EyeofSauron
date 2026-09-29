-- Events: the thing this warehouse has never been able to see.
--
-- WHY IT EXISTS. Sauron reads an unusual Wednesday and has no idea a
-- Michelin-starred guest chef was in the kitchen. Every event is currently
-- planned from memory, every unusual night is a mystery, and the briefing of
-- 16 Sep 2026 reached its conclusion about a two-night collab twenty-four hours
-- before the doors opened because nothing in the system knew the collab existed.
--
-- WHAT IT UNLOCKS, in the order the playbook needs it:
--   * the weekly briefing stops reporting an event as an anomaly;
--   * a concept can be measured against the last one of its kind;
--   * socials can be read against the commercial outcome rather than beside it;
--   * "what else is on that week" can be answered about our own diary first.
--
-- IT STARTS EMPTY AND THAT IS DECIDED. No backfill. For roughly a year the
-- honest answer to "what did the last one do" will be "nothing on record", and
-- that must never be allowed to read as "this has never been done here". The
-- distinction is the one the retention measure had to learn in migration 044,
-- where an empty lookback was being reported as a guest who had never visited.
-- Every query over this table returns how many comparable events it FOUND.

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

create table if not exists public.events (
  id   uuid primary key default gen_random_uuid(),
  name text not null,

  -- Dates, inclusive. A one-night event stores the same date twice, the same
  -- shape school_calendar uses, so no overlap test has to special-case.
  start_date date not null,
  end_date   date not null,
  check (end_date >= start_date),

  -- --- the attributes comparison runs on -----------------------------------
  --
  -- COMPARABLE MEANS ONE SHARED POINT, not one matching type. Two events are
  -- worth comparing if they share ANY of these, ranked by how many overlap,
  -- and the brief names which ones matched. A single `concept_type` column
  -- would have thrown away every other axis -- the partner who returns, the
  -- community being targeted, the format.
  --
  -- All nullable: an event that has not been fully specified is still an event
  -- worth recording, and a forced value here is a guess that later reads as a
  -- fact.

  -- 'Valentine's Day', 'Deepavali', 'CNY', 'National Day'. THE STRONGEST AXIS,
  -- because this group repeats the big days and that is what makes a
  -- year-on-year read possible at all.
  occasion text,

  -- 'guest-chef collab', 'tasting', 'brunch', 'party', 'launch'.
  concept_type text,

  -- 'Vicky Ratnani'. A returning partner is a comparison on its own.
  partner text,

  -- 'set menu', 'a la carte', 'ticketed'. Decides whether a walk-in can buy it,
  -- which decides the whole campaign -- see the playbook's product_shape row.
  format text,

  -- Who it was for, in the planner's own words: 'the Sindhi community'. Free
  -- text deliberately. A controlled list would have to be invented up front and
  -- would be wrong by the third event.
  demographic text,

  -- --- the concept, unmeasured on purpose ----------------------------------
  --
  -- CREATIVE IS EXEMPT FROM THE MEASURABILITY RULE. Mood, look, the story, why
  -- it belongs in this room: these must NOT be forced into numbers. The rule
  -- binds targets and commitments, never the idea, and a system that demanded a
  -- KPI for a creative direction would be worse than no system.
  concept    text,
  usp        text,
  venue_fit  text,

  -- --- targets, which must be measurable -----------------------------------
  --
  -- EACH TARGET CARRIES THE BASELINE IT WAS SET AGAINST. "Revenue" is not an
  -- objective and neither is "$28,000" on its own -- it becomes one at "$28,000
  -- against a median Thursday-Friday pair of $19,400". A target without its
  -- baseline cannot be judged afterwards by somebody who was not in the room,
  -- which is the whole test.
  target_net_sales        numeric(12,2),
  target_covers           integer,
  target_spend_per_head   numeric(10,2),
  baseline_net_sales      numeric(12,2),
  baseline_covers         integer,
  baseline_spend_per_head numeric(10,2),
  -- Where the baseline came from, in words: 'median Thu-Fri pair, last 8 weeks'.
  baseline_basis          text,

  -- --- price, against per-type averages ------------------------------------
  --
  -- NEVER A BLENDED AVERAGE. Food and beverage move differently and a set menu
  -- with a pairing is two decisions. A venue at $95 a head might be $62 food
  -- and $33 drink; an event priced off the $95 gets the drinks package wrong
  -- every time. Both bases are stored as they stood WHEN THE PRICE WAS SET,
  -- because the venue's averages move and a price has to be judged against what
  -- was known at the time.
  price                 numeric(10,2),
  price_basis_food_avg  numeric(10,2),
  price_basis_bev_avg   numeric(10,2),

  -- --- the cost build ------------------------------------------------------
  --
  -- ALL COSTS GO IN, or the event is a marketing spend wearing a P&L's clothes.
  -- Ingredients, partner fee and travel, extra labour, printing, decor, comped
  -- covers, and the ad budget below. Line items as [{label, amount}] so the
  -- shape is not fixed now and wrong in March; the total is stored separately
  -- because it is what gets quoted and it should not be recomputed by four
  -- different readers.
  cost_lines        jsonb not null default '[]'::jsonb,
  cost_total        numeric(12,2),
  -- The cover count where this washes its face. An event that breaks even at
  -- 90% occupancy is a decision, not a plan -- but only if somebody worked it
  -- out before the night.
  break_even_covers integer,

  -- --- paid promotion ------------------------------------------------------
  --
  -- SIGNED OFF BY THE MARKETING MANAGER, every amount, with no ceiling: the
  -- control is that somebody owns the number, not that large numbers escalate.
  -- The approval is a row and a date because an amount nobody approved is the
  -- one that gets argued about after it has been spent.
  --
  -- NOTE, and it is not small: there is no `marketing` role in
  -- user_venue_roles, which is owner | finance | manager | staff. Until the
  -- function axis exists this column is a RECORD and not a CONTROL, and it
  -- should not be described as an approval gate.
  ad_budget      numeric(12,2),
  ad_plan        text,
  ad_approved_by uuid references auth.users(id),
  ad_approved_at timestamptz,

  -- --- lifecycle -----------------------------------------------------------
  --
  -- A cancelled event stays on the record. It is evidence -- about the concept,
  -- the date, or the campaign -- and deleting it would leave the next planner
  -- believing nobody had tried.
  status text not null default 'planning'
         check (status in ('planning', 'brief_issued', 'confirmed', 'ran', 'cancelled')),

  -- --- outcome, filled at close-out ----------------------------------------
  --
  -- WHAT IS *NOT* STORED HERE, deliberately: the whole trading day's sales and
  -- covers. Those are in daily_operations and reservations already, keyed by
  -- venue and date, and copying them here would create two figures for one fact
  -- that drift -- the Monday-versus-Revel problem CLAUDE.md names, bought
  -- voluntarily. Read them by joining on venue and date.
  --
  -- These columns exist for the case the join CANNOT answer: an event that was
  -- part of a night. A private room, a bar takeover, one seating. Then somebody
  -- counted, and what they counted is not the day.
  outcome_basis text not null default 'unknown'
                check (outcome_basis in ('unknown', 'venue_day', 'measured')),
  -- Null when outcome_basis is 'venue_day' -- derive it, do not duplicate it.
  covers_actual    integer,
  net_sales_actual numeric(12,2),
  -- What actually happened, in words. The half a number never carries.
  outcome_notes    text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.events is
  'Events the group ran or plans to run. Two events are COMPARABLE if they share '
  'any one of occasion, venue, concept_type, partner, format or demographic — '
  'ranked by how many overlap, never by a single type. For a shared occasion the '
  'reach is the PREVIOUS OCCURRENCE whatever the gap: Deepavali 2025 to 2026 is '
  '384 days and a 365-day window misses it. Whole-day sales and covers are NOT '
  'stored here; join daily_operations and reservations on venue and date.';

create index if not exists events_dates_idx    on public.events (start_date, end_date);
create index if not exists events_occasion_idx on public.events (occasion) where occasion is not null;
create index if not exists events_status_idx   on public.events (status);

-- ---------------------------------------------------------------------------
-- event_venues — one event, many venues, and the playbook makes you earn it
-- ---------------------------------------------------------------------------
--
-- THE SCHEMA ALLOWS IT; THE TEST IS WHETHER THE MECHANIC BREAKS. Pull one venue
-- out tomorrow -- does the thing still work? A passport across all three, a
-- shared voucher, a group membership launch: no. That is one event in many
-- venues, and it is rare.
--
-- A SHARED OCCASION IS NOT A SHARED EVENT. Valentine's at all three is THREE
-- events -- a Japanese one, a Middle Eastern one, an Indian one -- and forcing
-- them into one row buries three concepts, three prices, three audiences and
-- three results under one heading, then makes it impossible to say which
-- worked. Nothing is lost by splitting them: they share `occasion`, so the
-- comparison already treats them as related.

create table if not exists public.event_venues (
  event_id uuid not null references public.events(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  primary key (event_id, venue_id)
);

create index if not exists event_venues_venue_idx on public.event_venues (venue_id);

-- ---------------------------------------------------------------------------
-- event_tasks — the content and outreach schedule
-- ---------------------------------------------------------------------------
--
-- A POST WITHOUT A DATE IS AN INTENTION, NOT A PLAN. Every content and outreach
-- item carries a target date, because those dates are what become deadlines for
-- the people who have to make the assets. Stored as T-MINUS DAYS as well as an
-- absolute date: the planning is done in "five days out", the calendar needs a
-- day, and recomputing either from the other breaks the moment an event moves.
--
-- This is also what becomes a monday.com GROUP of items later -- a group per
-- event, not a board per event, so every live event sits on one screen. That
-- stage is deferred and nothing here depends on it.

create table if not exists public.event_tasks (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  kind text not null check (kind in ('content', 'outreach', 'ops', 'other')),

  -- 'Reel: dish being plated', 'Call VIPs who booked the last collab'.
  description text not null,

  -- Format for content, channel for outreach: 'reel', 'carousel', 'story',
  -- 'phone', 'whatsapp', 'email'. Null where it does not apply.
  channel text,

  -- Negative days from the event's start. -14 is a fortnight out, 0 is the day.
  -- Kept alongside due_date rather than derived, so moving the event is a
  -- deliberate recalculation rather than a silent one.
  t_minus_days integer,
  due_date     date,

  -- A plan with no owner is a wish, and the items that get dropped are always
  -- the ones nobody was named for. Free text as well as a user reference,
  -- because the owner is often somebody without a login.
  owner_user_id uuid references auth.users(id),
  owner_name    text,

  status text not null default 'todo' check (status in ('todo', 'done', 'dropped')),
  completed_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists event_tasks_event_idx on public.event_tasks (event_id, t_minus_days);
create index if not exists event_tasks_due_idx   on public.event_tasks (due_date) where status = 'todo';

-- ---------------------------------------------------------------------------
-- event_posts — which posts promoted which event
-- ---------------------------------------------------------------------------
--
-- THE POINT OF THE WHOLE STORE, arguably. Reach and covers currently sit beside
-- each other and have to be associated by eye; this is what lets a campaign be
-- read against its commercial outcome. Measured on the 16-17 Sep collab: the
-- reminder image reached 481 with 14 interactions, the weakest of nine recent
-- posts, while dish reels in the same period reached 3,654-3,666 -- a finding
-- that took a person going and looking, and should have taken a query.
--
-- A post can promote more than one event and an event has many posts, so this
-- is a join rather than a column on social_posts.

create table if not exists public.event_posts (
  event_id uuid not null references public.events(id) on delete cascade,
  post_id  uuid not null references public.social_posts(id) on delete cascade,
  -- How the link was made. A human said so, or a job matched it -- and the two
  -- deserve different confidence when the difference decides an answer.
  linked_by text not null default 'manual' check (linked_by in ('manual', 'inferred')),
  primary key (event_id, post_id)
);

create index if not exists event_posts_post_idx on public.event_posts (post_id);

-- ---------------------------------------------------------------------------
-- row-level security
-- ---------------------------------------------------------------------------
--
-- SCOPED THROUGH event_venues, which is the only wrinkle: an event has no
-- venue_id of its own, so "may I see this event" is "may I see any venue it
-- runs at". An event with NO venues attached is visible to owners only -- it is
-- a half-written row, and defaulting an unscoped row to visible is how a
-- restricted account ends up reading something nobody meant it to.
--
-- The policy shape is the one social_posts uses: your venues, or you are an
-- owner. Service role bypasses all of this, so the API route remains the real
-- boundary for anything server-side -- see the audit of 23 Sep.

alter table public.events       enable row level security;
alter table public.event_venues enable row level security;
alter table public.event_tasks  enable row level security;
alter table public.event_posts  enable row level security;

create or replace function public.may_read_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_venue_roles
    where user_id = auth.uid() and role = 'owner'
  )
  or exists (
    select 1
    from public.event_venues ev
    join public.user_venue_roles r
      on r.venue_id = ev.venue_id and r.user_id = auth.uid()
    where ev.event_id = p_event_id
  );
$$;

comment on function public.may_read_event(uuid) is
  'True when the caller owns the group or holds a role at any venue the event '
  'runs at. An event with no venues attached is owner-only by construction: '
  'the second clause finds nothing, which is the intended answer for a '
  'half-written row rather than an accident.';

drop policy if exists "Users can view events for their venues" on public.events;
create policy "Users can view events for their venues"
  on public.events for select
  using (public.may_read_event(id));

drop policy if exists "Users can view event venues for their venues" on public.event_venues;
create policy "Users can view event venues for their venues"
  on public.event_venues for select
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

drop policy if exists "Users can view event tasks for their venues" on public.event_tasks;
create policy "Users can view event tasks for their venues"
  on public.event_tasks for select
  using (public.may_read_event(event_id));

drop policy if exists "Users can view event posts for their venues" on public.event_posts;
create policy "Users can view event posts for their venues"
  on public.event_posts for select
  using (public.may_read_event(event_id));

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_events_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_events_updated_at();
