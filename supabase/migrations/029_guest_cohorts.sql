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
  /*
   * ONE WINDOWED PASS, NOT A CORRELATED SUBQUERY PER GUEST.
   *
   * The first version asked, for each of ~78,000 guest-venue pairs, "does any
   * later visit exist inside the window". Written against a CTE, which Postgres
   * materialises into a 96,000-row temporary result with NO INDEXES, so every
   * one of those 78,000 checks scanned all 96,000 rows. It timed out.
   * guest_retention survives the same shape only because it runs 356 of them.
   *
   * The question is equivalent to a much cheaper one: what was the guest's
   * SECOND distinct visit date, and was it inside the window? If the earliest
   * subsequent visit falls outside the window, no visit is inside it. So one
   * dense_rank per partition answers it in a single sort.
   *
   * dense_rank rather than row_number, deliberately: two bookings on the same
   * DAY are one visit, and row_number would call the second one a return.
   */
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
  -- First and second visit to THIS venue. The venue's own acquisition event.
  outlet as (
    select
      venue_id,
      min(business_date) filter (where nth_here = 1) as first_visit,
      min(business_date) filter (where nth_here = 2) as second_visit
    from base
    group by venue_id, sevenrooms_client_id
  ),
  -- First and second visit to ANY venue. A different date for a guest whose
  -- second venue came later.
  grp as (
    select
      min(business_date) filter (where nth_group = 1) as first_visit,
      min(business_date) filter (where nth_group = 2) as second_visit
    from base
    group by sevenrooms_client_id
  ),
  combined as (
    select venue_id, first_visit, second_visit from outlet
    union all
    select null::uuid, first_visit, second_visit from grp
  )
  select
    c.venue_id,
    date_trunc(p_grain, c.first_visit)::date as cohort_start,
    count(*) as cohort_size,
    count(*) filter (
      where c.second_visit is not null
        and c.second_visit <= c.first_visit + p_window
    ) as returned,
    -- Mature when the LAST guest to join the cohort has had the full window.
    -- That is the end of the cohort period plus the window, not the start.
    --
    -- The grain is mapped rather than interpolated, because `quarter` is a
    -- valid date_trunc field and NOT a valid interval unit: '1 quarter'::interval
    -- fails with "invalid input syntax for type interval". The two accept
    -- different vocabularies and only one of them says so.
    ((date_trunc(p_grain, c.first_visit)::date + case p_grain
                         when 'month'   then interval '1 month'
                         when 'quarter' then interval '3 months'
                         when 'year'    then interval '1 year'
                         else interval '3 months'
                       end)::date + p_window) <= current_date as is_mature
  from combined c
  where c.first_visit >= p_from
  group by c.venue_id, date_trunc(p_grain, c.first_visit)::date;
$$;

comment on function public.guest_cohorts(text, int, date) is
  'First-visit cohorts and how many returned within the window. venue_id NULL = the group (computed separately, NOT the sum of venue rows — a guest can be new to two venues in one quarter). is_mature is false until the whole cohort has had the full window; comparing immature cohorts draws a cliff that is the calendar, not a finding.';
