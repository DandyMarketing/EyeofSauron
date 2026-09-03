-- How far ahead people book, month by month, per venue and for the group.
--
-- WHY THIS EXISTS. Asked on 3 Sep 2026: how many days ahead did each booking
-- come in. The chat answered that we do not hold a reservation creation
-- timestamp and that it would need a new field pulled from SevenRooms. Both
-- halves were wrong. `reservations.source_created_at` has existed since
-- migration 009, `src/ingest/sevenrooms.ts` has always mapped SevenRooms'
-- `created` onto it, and it is populated on 142,623 of 142,623 rows going back
-- to April 2022. What was missing was that `query_reservations` never selected
-- the column, so the model could not see it -- and then explained the absence
-- with a reason it invented. A confident wrong answer about our own schema.
--
-- WHY IT IS AN AGGREGATE RATHER THAN A COLUMN ON THE EXISTING TOOL. Adding
-- source_created_at to query_reservations would hand the model 142,623 rows to
-- subtract dates across, which is the arithmetic-in-the-model failure this
-- warehouse exists to avoid, and PostgREST caps a page at 1,000 rows anyway.
-- One call per venue-month instead. Same argument as 028 through 032.
--
-- WHY LEAD TIME IS WORTH HAVING. April 2025 at Neon Pigeon: booked covers
-- halved while walk-ins held. The conclusion was that the booking pipe broke,
-- and the measurement that separates "people stopped booking" from "people
-- started booking later" is this one. Those are different problems with
-- different fixes and the data could not tell them apart until now.
--
-- ---------------------------------------------------------------------------
-- THREE DECISIONS THAT DECIDE WHETHER THE NUMBER MEANS ANYTHING
-- ---------------------------------------------------------------------------
--
-- 1. WALK-INS ARE EXCLUDED, AND COUNTED SO THE EXCLUSION IS VISIBLE.
--    A walk-in is created at the moment it arrives, so its lead time is zero by
--    definition. Including them would make the median a measurement of the
--    walk-in ratio wearing the name of lead time -- and it would move whenever
--    the walk-in mix moved, which is exactly the sort of figure that drifts for
--    a reason nobody can find. Same rule as visit_distribution, for a different
--    reason: there, walk-ins cannot be seen returning; here, they cannot be
--    seen booking ahead.
--
-- 2. FUTURE BUSINESS DATES ARE EXCLUDED. Bookings for next March have not all
--    been made yet, so a month still ahead of us shows only its early bookers
--    and reports a lead time far longer than it will finish with. That is
--    censoring in the opposite direction to the cohort tools, and it is worse,
--    because it makes the most recent months look best.
--
-- 3. THE CREATED DATE IS CONVERTED TO SINGAPORE TIME FIRST. `business_date` is
--    venue-local and `source_created_at` is UTC -- migration 009's own comment
--    warns that SevenRooms mixes zones within one record. Subtracting the two
--    raw would put a booking made at 9am Singapore on the previous day, adding
--    a phantom day of lead to roughly a third of all bookings.
--
-- A booking created AFTER the date it was for has a negative lead time. That is
-- not a booking at all, it is a record entered retrospectively, so it is
-- counted separately and kept out of the median rather than folded into
-- "same day", where it would silently drag the figure down.

create or replace function public.booking_lead_time(
  p_start date,
  p_end   date
)
returns table (
  venue_id        uuid,     -- NULL means the group as a whole
  month_start     date,
  bookings        bigint,   -- non-walk-in bookings with a usable lead time
  median_days     numeric,
  mean_days       numeric,
  p90_days        numeric,
  same_day        bigint,
  days_1_3        bigint,
  days_4_7        bigint,
  days_8_30       bigint,
  days_31_plus    bigint,
  walk_ins        bigint,   -- excluded from every figure above
  retrospective   bigint    -- created after the date it was for; also excluded
)
language sql
stable
set search_path = public, pg_temp
as $$
  with base as (
    select
      r.venue_id,
      date_trunc('month', r.business_date)::date as month_start,
      r.is_walk_in,
      -- Both sides in venue-local terms before subtracting. See decision 3.
      (r.business_date - (r.source_created_at at time zone 'Asia/Singapore')::date) as lead_days
    from public.reservations r
    where r.business_date between p_start and p_end
      /**
       * Decision 2: a month not yet finished being booked is not comparable.
       *
       * Singapore's today, not the server's. `current_date` is evaluated in the
       * database's timezone, which is UTC, and UTC lags Singapore by eight
       * hours -- so every morning in Singapore the server still believes it is
       * yesterday, and today's trade would be dropped from the most recent
       * month for the first eight hours of every day.
       */
      and r.business_date <= (now() at time zone 'Asia/Singapore')::date
      and r.source_created_at is not null
  ),
  /**
   * Venue rows and a group row from the same base, unioned rather than summed.
   * The medians are not additive, so a group median has to be computed over the
   * group's own bookings; adding three venue medians together would produce a
   * number with no meaning that nonetheless looks like an answer.
   */
  combined as (
    select venue_id,   month_start, is_walk_in, lead_days from base
    union all
    select null::uuid, month_start, is_walk_in, lead_days from base
  )
  select
    c.venue_id,
    c.month_start,
    count(*) filter (where not c.is_walk_in and c.lead_days >= 0)                          as bookings,
    round(percentile_cont(0.5) within group (
      order by case when not c.is_walk_in and c.lead_days >= 0 then c.lead_days end::double precision
    )::numeric, 1)                                                                          as median_days,
    round(avg(c.lead_days) filter (where not c.is_walk_in and c.lead_days >= 0)::numeric, 1) as mean_days,
    round(percentile_cont(0.9) within group (
      order by case when not c.is_walk_in and c.lead_days >= 0 then c.lead_days end::double precision
    )::numeric, 1)                                                                          as p90_days,
    count(*) filter (where not c.is_walk_in and c.lead_days = 0)                            as same_day,
    count(*) filter (where not c.is_walk_in and c.lead_days between 1 and 3)                as days_1_3,
    count(*) filter (where not c.is_walk_in and c.lead_days between 4 and 7)                as days_4_7,
    count(*) filter (where not c.is_walk_in and c.lead_days between 8 and 30)               as days_8_30,
    count(*) filter (where not c.is_walk_in and c.lead_days > 30)                           as days_31_plus,
    count(*) filter (where c.is_walk_in)                                                    as walk_ins,
    count(*) filter (where not c.is_walk_in and c.lead_days < 0)                            as retrospective
  from combined c
  group by c.venue_id, c.month_start;
$$;

comment on function public.booking_lead_time(date, date) is
  'Days between a booking being created and the date it was for, per venue per '
  'month. venue_id NULL is the group. Walk-ins are excluded and counted -- their '
  'lead time is zero by definition and including them would make this a measure '
  'of the walk-in ratio. Business dates in the future are excluded: a month '
  'still being booked shows only its early bookers. Created time is converted to '
  'Singapore time before subtracting, because source_created_at is UTC and '
  'business_date is venue-local.';

