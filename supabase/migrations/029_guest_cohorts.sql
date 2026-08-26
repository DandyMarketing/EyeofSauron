-- Does a first-time guest come back? Measured by when they first arrived.
--
-- The distribution in 028's comment says 81% of booked guests came exactly
-- once. That is a static fact about four and a half years, and it cannot answer
-- the question the rebrand needs: is it getting better or worse.
--
-- WHY COHORTS RATHER THAN A ROLLING RATE. A lifetime distribution mixes people
-- who first came in 2022 -- and have had four years to return -- with people who
-- first came in June, who have had weeks. That comparison is not a measurement.
-- A cohort holds the window still: everyone in it gets exactly the same number
-- of days to come back, so two cohorts can be put side by side and the
-- difference means something.
--
-- MATURITY IS RETURNED, AND IGNORING IT WOULD INVENT A COLLAPSE. A cohort needs
-- the full window to have played out. The most recent quarter has had a few
-- weeks, so its return rate is near zero -- and plotted next to mature cohorts
-- it draws a cliff at the right-hand edge that looks exactly like retention
-- falling off. It is not a finding, it is the calendar. `is_mature` says which
-- rows may be compared; the ones that may not are still returned, because
-- hiding them would leave someone to wonder why the chart stops.
--
-- OUTLET AND GROUP COHORTS ARE BOTH RETURNED, on the same argument as 028. A
-- guest's first visit to Fat Prince and their first visit to the group are
-- different events with different owners. Group rows carry venue_id IS NULL.
-- They cannot be derived by summing the venue rows -- a guest who first visited
-- two venues in the same quarter appears in both -- so they are computed
-- separately rather than rolled up.

create or replace function public.guest_cohorts(
  p_grain  text default 'quarter',
  p_window int  default 365,
  p_from   date default date '2022-01-01'
)
returns table (
  venue_id     uuid,        -- NULL means the group as a whole
  cohort_start date,
  cohort_size  bigint,
  returned     bigint,
  is_mature    boolean
)
language sql
stable
as $$
  with visits as (
    select venue_id, sevenrooms_client_id, business_date
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = false
      and sevenrooms_client_id is not null
  ),
  -- First visit to THIS venue. The venue's own acquisition event.
  outlet_first as (
    select venue_id, sevenrooms_client_id, min(business_date) as first_visit
    from visits
    group by 1, 2
  ),
  outlet as (
    select
      f.venue_id,
      date_trunc(p_grain, f.first_visit)::date as cohort_start,
      count(*) as cohort_size,
      count(*) filter (where exists (
        select 1 from visits v
        where v.venue_id             = f.venue_id
          and v.sevenrooms_client_id = f.sevenrooms_client_id
          -- Strictly after: the first visit is not a return.
          and v.business_date >  f.first_visit
          and v.business_date <= f.first_visit + p_window
      )) as returned
    from outlet_first f
    where f.first_visit >= p_from
    group by 1, 2
  ),
  -- First visit to ANY venue. The group's acquisition event, and a different
  -- date for a guest who came to a second venue later.
  group_first as (
    select sevenrooms_client_id, min(business_date) as first_visit
    from visits
    group by 1
  ),
  grp as (
    select
      null::uuid as venue_id,
      date_trunc(p_grain, g.first_visit)::date as cohort_start,
      count(*) as cohort_size,
      count(*) filter (where exists (
        select 1 from visits v
        where v.sevenrooms_client_id = g.sevenrooms_client_id
          and v.business_date >  g.first_visit
          and v.business_date <= g.first_visit + p_window
      )) as returned
    from group_first g
    where g.first_visit >= p_from
    group by 1, 2
  ),
  combined as (
    select * from outlet
    union all
    select * from grp
  )
  select
    c.venue_id,
    c.cohort_start,
    c.cohort_size,
    c.returned,
    -- Mature when the LAST guest to join the cohort has had the full window.
    -- That is the end of the cohort period plus the window, not the start.
    ((c.cohort_start + ('1 ' || p_grain)::interval)::date + p_window) <= current_date
      as is_mature
  from combined c;
$$;

comment on function public.guest_cohorts(text, int, date) is
  'First-visit cohorts and how many returned within the window. venue_id NULL = the group (computed separately, NOT the sum of venue rows — a guest can be new to two venues in one quarter). is_mature is false until the whole cohort has had the full window; comparing immature cohorts draws a cliff that is the calendar, not a finding.';
