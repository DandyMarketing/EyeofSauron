-- Labour hours and cost, aggregated to the point where no person is in it.
--
-- WHAT THIS DELIBERATELY DOES NOT HOLD. StaffAny returns a cost per person per
-- shift, which is that person's earnings. CLAUDE.md's labour section is
-- explicit: hours are ingested aggregated by venue, date and role or section,
-- never by individual, and the strongest protection is not holding the data at
-- all. So `staff_count` is a COUNT and there is no user column, no name, no
-- rate, and nothing that could be joined back to one. The aggregation happens
-- in memory in src/ingest/staffany.ts and the detail never reaches Postgres.
--
-- WHY SECTION IS THE GRAIN. Back-of-house and front-of-house are separate
-- SECTIONS in StaffAny -- `Fat Prince BOH`, `Fat Prince FOH` -- and every
-- work-hour row carries its section. So the split the brief asks for falls out
-- of the source structurally, and needs neither the role mapping table nor the
-- hours-weighted apportionment that would have made it an estimate.
--
-- THE COST IS MEASURED, NOT DERIVED. Discovered 7 Sep 2026: the v1 timesheets
-- endpoint returns `actualCosts` as { basicCost, eventCost, weekendCost,
-- overtimeCost }, on a generally available endpoint the published spec does not
-- document as carrying cost at all. Nothing here multiplies an hourly rate by
-- hours, applies a 44-hour threshold, or decides who falls under Part IV of the
-- Employment Act -- StaffAny knows each person's contract and does that
-- arithmetic itself. The components are stored apart because a total says
-- labour was expensive and the split says why, and overtime is the one with a
-- lever on it.
--
-- IT WILL NOT MATCH THE P&L, and that is expected rather than a fault. This is
-- what the roster generated. The Xero `Wages and Salaries` line adds employer
-- CPF, the skills levy and leave accrual, so this should sit BELOW it. Two
-- figures for one metric is the Monday-versus-Revel problem the build log
-- warns about, so they are named differently everywhere: ROSTERED LABOUR COST
-- here, TOTAL EMPLOYMENT COST in the ledger. A reconciliation between them is
-- also the only check that catches salaried staff who never clock in, who are
-- absent from this table entirely and are the most expensive people in the
-- building.

-- --- the section mapping, confirmed by a person -----------------------------
--
-- Same shape as revel_venue_keys, the Xero tenant mapping and the social
-- account mapping: an opaque source key resolved to a venue by somebody who
-- knows, never by matching on the name. Two of the three legal entities here
-- are called "Potus" and "20 Craig Road", which is the standing argument
-- against name-guessing (BUILD_LOG 2.2) -- and a section guessed into the wrong
-- venue puts another venue's labour cost onto this venue's margin comparison.

create table if not exists public.staffany_sections (
  staffany_section_id text primary key,
  section_name        text not null,
  section_tag         text,

  -- NULL until a person confirms it. An unmapped section is not ingested; the
  -- run reports it and the admin console lists it. Timesheets can be re-fetched,
  -- so waiting costs nothing and guessing costs a wrong comparison.
  venue_id            uuid references public.venues(id) on delete cascade,

  -- BOH / FOH / GROUP. GROUP is for a section that is neither a kitchen nor a
  -- floor -- The Dandy Collection section carries group staff, and folding it
  -- into either half of a venue would corrupt the split it exists to measure.
  area                text check (area in ('BOH', 'FOH', 'GROUP')),

  first_seen_at       timestamptz not null default now(),
  confirmed_at        timestamptz,
  confirmed_by        uuid references auth.users(id)
);

comment on table public.staffany_sections is
  'StaffAny section id to venue and BOH/FOH area. Confirmed by a person, never '
  'guessed from the section name. An unmapped section is not ingested.';

-- --- the daily aggregate ----------------------------------------------------

create table if not exists public.labour_daily (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references public.venues(id) on delete cascade,
  business_date       date not null,
  staffany_section_id text not null references public.staffany_sections(staffany_section_id),
  area                text not null,

  -- Both sides of the plan. The variance between them is the cheapest real
  -- report in the whole labour ladder and only exists if both are kept.
  scheduled_hours     numeric(10,2) not null default 0,
  actual_hours        numeric(10,2) not null default 0,

  basic_cost          numeric(12,2) not null default 0,
  overtime_cost       numeric(12,2) not null default 0,
  weekend_cost        numeric(12,2) not null default 0,
  event_cost          numeric(12,2) not null default 0,
  -- Anything StaffAny adds later that we do not recognise lands here rather
  -- than being dropped, so a new component shows up as an unexplained bucket
  -- instead of silently shrinking the total.
  other_cost          numeric(12,2) not null default 0,
  total_cost          numeric(12,2) not null default 0,

  -- A COUNT. There is deliberately no way to get from this to a person.
  staff_count         integer not null default 0,

  fetched_at          timestamptz not null default now(),

  -- Keyed on section and date and NOTHING ELSE. The 023 lesson: a column a bug
  -- fix might CHANGE must never be part of a unique key. `area` and `venue_id`
  -- both come from a mapping a person can edit, so including either would make
  -- a re-map insert a duplicate rather than update the row.
  unique (staffany_section_id, business_date)
);

create index if not exists idx_labour_venue_date
  on public.labour_daily (venue_id, business_date);

comment on table public.labour_daily is
  'ROSTERED labour hours and cost per venue, day and section. Not total '
  'employment cost -- it excludes employer CPF, SDL and leave accrual, so it '
  'sits below the Xero Wages and Salaries line. No individual is recoverable.';

-- --- row-level security -----------------------------------------------------
--
-- The anon key is public by design, so RLS is the only barrier between it and
-- a table. Two tables once went a year without it and a vendor's scanner found
-- them (BUILD_LOG 4.4); rls_audit() now catches that, and this table starts
-- with it rather than relying on the check.

alter table public.labour_daily enable row level security;

drop policy if exists "Users can view labour for their venues" on public.labour_daily;
create policy "Users can view labour for their venues"
  on public.labour_daily for select
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

-- The mapping carries no money and no person, and everybody who can see a
-- venue needs to know which section is which. Owners edit it through the admin
-- console, which goes through the service role.
alter table public.staffany_sections enable row level security;

drop policy if exists "Users can view section mappings" on public.staffany_sections;
create policy "Users can view section mappings"
  on public.staffany_sections for select
  using (auth.uid() is not null);
