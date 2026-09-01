-- How many of this month's visits were somebody's first, second, third, or
-- fourth-and-beyond -- per venue and for the group.
--
-- WHY THIS EXISTS, and it is a defect report rather than a feature request.
-- Asked on 1 Sep 2026: "1st, 2nd, 3rd, 4th+ time visits, group wide and venue
-- local, all 3 venues, month by month". A completely reasonable question with
-- no tool shaped like it, so the model did the only thing available and looped:
-- query_guest_retention once per venue per month, roughly thirty-two calls.
-- MAX_TOOL_ROUNDS is 12. It spent SIX MINUTES on twelve rounds of Opus, hit the
-- ceiling, composed a 4,149-token partial answer from the recovery path -- and
-- by then the HTTP request had timed out at the edge, so the answer was thrown
-- away and the user saw "Request failed". Nothing crashed. Everything worked as
-- designed. The question was simply the wrong shape for the menu.
--
-- This is the treadmill CLAUDE.md predicts: "eventually a question will fall
-- outside the menu". The answer for now is the same as for retention and
-- cohorts -- put the arithmetic in Postgres, where one call replaces thirty-two
-- and neither PostgREST's 1,000-row cap nor the round-trip cost applies.
--
-- IT COUNTS VISITS, NOT GUESTS, and the distinction is the whole point. A guest
-- who comes twice in March contributes to March twice, once as visit 2 and once
-- as visit 3. Counting guests instead would silently answer a different
-- question -- "how many distinct people came" -- and make the buckets not sum
-- to footfall.
--
-- THE RANKING IS OVER ALL HISTORY, THE OUTPUT IS OVER THE WINDOW. The period
-- filter is applied at the very end, after the ranks are computed. Filtering
-- first would restart everyone's count inside the window and report a year of
-- regulars as first-timers -- the failure mode this is most likely to be
-- misused into, so it is worth saying out loud.
--
-- dense_rank, NOT row_number, for the reason 029 gives: two bookings on the
-- same DAY are one visit, and row_number would call the second one a return.

create or replace function public.visit_distribution(
  p_start date,
  p_end   date
)
returns table (
  venue_id     uuid,        -- NULL means the group as a whole
  month_start  date,
  visit_number int,         -- 1, 2, 3, or 4 meaning "fourth or later"
  visits       bigint
)
language sql
stable
as $$
  with base as (
    select
      venue_id,
      sevenrooms_client_id,
      business_date,
      dense_rank() over (partition by venue_id, sevenrooms_client_id order by business_date) as nth_here,
      dense_rank() over (partition by sevenrooms_client_id            order by business_date) as nth_group
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = false
      and sevenrooms_client_id is not null
  ),
  -- One row per guest per venue per DAY. Two bookings the same evening are one
  -- visit; without this a large party split across two reservations would read
  -- as a guest who came back.
  outlet as (
    select distinct venue_id, sevenrooms_client_id, business_date, nth_here as nth
    from base
  ),
  -- One row per guest per DAY across the whole group. A guest who ate at two
  -- venues on one day is ONE group visit and TWO outlet visits, which is why
  -- the venue rows deliberately do not sum to the group row.
  grp as (
    select distinct sevenrooms_client_id, business_date, nth_group as nth
    from base
  ),
  combined as (
    select venue_id,     business_date, least(nth, 4) as visit_number from outlet
    union all
    select null::uuid,   business_date, least(nth, 4)                 from grp
  )
  select
    c.venue_id,
    date_trunc('month', c.business_date)::date as month_start,
    c.visit_number::int,
    count(*) as visits
  from combined c
  where c.business_date between p_start and p_end
  group by c.venue_id, date_trunc('month', c.business_date)::date, c.visit_number;
$$;

comment on function public.visit_distribution(date, date) is
  'Visits per month bucketed by whether they were the guest''s 1st, 2nd, 3rd or 4th+ visit. venue_id NULL is the group. Counts VISITS not guests; ranks are computed over all history and only then filtered to the window. Booked guests only — walk-ins get a fresh client id each time and can never be seen returning.';
