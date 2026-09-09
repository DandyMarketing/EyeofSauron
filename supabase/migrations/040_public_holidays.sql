-- Singapore public holidays, so the engine stops asking the internet.
--
-- WHY THIS EXISTS. The weekly recommendation run on 7 Sep 2026 performed
-- ELEVEN web searches across SEVENTY-EIGHT pages, and every one of them was a
-- Singapore public holiday or school calendar. Three venues, the same question
-- each time, every week, for a fact that does not change.
--
-- The cost is worse than eleven searches. Each page lands in the model's
-- context and is then re-read on every subsequent round of that venue's
-- analysis, so it inflates the cache read on all thirteen rounds that follow.
-- It also produced ZERO citations, meaning the engine read two dozen blogs and
-- quoted none of them -- so the holiday context in a briefing rested on
-- whichever page it happened to believe.
--
-- WHERE THE DATA COMES FROM. data.gov.sg, dataset
-- d_8ef23381f9417e4d4254ee8b4dcdb176, "Singapore Public Holidays
-- (consolidated)", published by the MINISTRY OF MANPOWER. That is the
-- gazetting authority, so this is the source rather than a report of it -- the
-- distinction CLAUDE.md draws for the benchmarks table, where an external
-- figure must be a warehouse row with a source and a url rather than something
-- a model read once.
--
-- OBSERVED DAYS ARE THEIR OWN ROWS, and that is the point for an F&B business.
-- When a holiday falls on a Sunday the following Monday is gazetted separately
-- -- National Day 2026 is Sunday the 9th of August AND Monday the 10th. Both
-- are trading days with holiday behaviour, and collapsing them would lose the
-- Monday, which for a restaurant is the one that actually changes the covers.

create table if not exists public.public_holidays (
  holiday_date date primary key,
  name         text not null,
  weekday      text not null,

  -- A gazetted day-in-lieu, which reads "(Observed)" in the source. Kept as a
  -- flag as well as in the name so a query can ask for one without matching on
  -- a string.
  is_observed  boolean not null default false,

  -- Provenance, on the row rather than in a comment. Same shape the benchmarks
  -- table is specified with: an external fact carries where it came from.
  source       text not null default 'Ministry of Manpower via data.gov.sg',
  source_url   text not null default 'https://data.gov.sg/datasets/d_8ef23381f9417e4d4254ee8b4dcdb176/view',
  fetched_at   timestamptz not null default now()
);

comment on table public.public_holidays is
  'Singapore public holidays from the Ministry of Manpower via data.gov.sg. '
  'Observed days-in-lieu are separate rows: for a restaurant the Monday after a '
  'Sunday holiday is the one that changes covers.';

-- --- row-level security -----------------------------------------------------
--
-- Public information with no venue and no money in it, so every signed-in user
-- may read it. It still gets RLS, because the anon key is public by design and
-- a table without a policy is open to anyone who loads the login page -- and
-- because rls_audit() would otherwise report this table as a fault every day.

alter table public.public_holidays enable row level security;

drop policy if exists "Signed-in users can read public holidays" on public.public_holidays;
create policy "Signed-in users can read public holidays"
  on public.public_holidays for select
  using (auth.uid() is not null);
