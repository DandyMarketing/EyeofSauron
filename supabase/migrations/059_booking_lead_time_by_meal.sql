-- Lead time for ONE MEAL, and cancellations counted beside it.
--
-- WHY. 13 Oct 2026: asked whether Firangi Superstar's 10 Oct F1 Champagne
-- Brunch bookings followed the marketing posts, the chat read lead time for
-- the WHOLE DAY -- 41 bookings, brunch and dinner together -- because this
-- function had no way to ask for one meal. It credited posts on 8 and 9 Oct.
-- SevenRooms' own list of that brunch (15 bookings, 3 walk-ins, 55 covers)
-- shows not one brunch booking made on either day; they came the day after the
-- 28 Sep announcement and the 5 Oct reminder. Same data, opposite conclusion.
--
-- WHAT CHANGES.
-- 1. `meal_period(shift_category, arrival_time)`: the SAME mapping as
--    `normaliseShift()` in src/lib/covers.ts, so a meal means one thing in SQL
--    and in TypeScript. Known shift names are mapped (BRUNCH, LUNCH, DINNER,
--    and Fat Prince's DAY and LEGACY); anything else falls back to the arrival
--    hour, before 15:00 lunch, otherwise dinner. A test asserts every name in
--    the TypeScript map appears here, so the two cannot drift silently.
-- 2. `booking_lead_time` takes an optional `p_meal`. Left out, it is exactly
--    the old function, so a call written before this migration still works.
-- 3. A new column, `cancelled`: bookings INCLUDED in the figures that were
--    later cancelled or did not show. They stay in, because a cancelled
--    booking was still somebody booking -- that is what lead time measures --
--    but SevenRooms' reservation list hides them by default, so without the
--    count the totals cannot be reconciled with the screen a manager looks at.
--
-- The return type changes, so the old function is dropped first; Postgres
-- cannot replace a function with a different result shape.

create or replace function public.meal_period(p_shift text, p_arrival text)
returns text
language sql
immutable
as $$
  select case upper(btrim(coalesce(p_shift, '')))
    when 'BRUNCH' then 'brunch'
    when 'LUNCH'  then 'lunch'
    when 'DAY'    then 'lunch'    -- Fat Prince's lunch service
    when 'DINNER' then 'dinner'
    when 'LEGACY' then 'dinner'   -- Fat Prince's dinner service
    else case
      when substring(coalesce(p_arrival, '') from '^\s*(\d{1,2})') is null then 'unknown'
      when substring(p_arrival from '^\s*(\d{1,2})')::int < 15 then 'lunch'
      else 'dinner'
    end
  end;
$$;

comment on function public.meal_period(text, text) is
  'Brunch, lunch or dinner for a reservation: the SevenRooms shift name where '
  'known, otherwise the arrival hour (before 15:00 is lunch). Mirrors '
  'normaliseShift() in src/lib/covers.ts.';

drop function if exists public.booking_lead_time(date, date);

create or replace function public.booking_lead_time(
  p_start date,
  p_end   date,
  p_meal  text default null   -- 'brunch' | 'lunch' | 'dinner'; null for the whole day
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
  retrospective   bigint,   -- created after the date it was for; also excluded
  cancelled       bigint    -- of `bookings`, later cancelled or no-show
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
      r.status_simple in ('Canceled', 'No Show') as fell_away,
      -- Both sides in venue-local terms before subtracting (migration 036, decision 3).
      (r.business_date - (r.source_created_at at time zone 'Asia/Singapore')::date) as lead_days
    from public.reservations r
    where r.business_date between p_start and p_end
      -- Singapore's today, not the server's (migration 036, decision 2).
      and r.business_date <= (now() at time zone 'Asia/Singapore')::date
      and r.source_created_at is not null
      and (p_meal is null or public.meal_period(r.shift_category, r.arrival_time) = p_meal)
  ),
  combined as (
    select venue_id,   month_start, is_walk_in, fell_away, lead_days from base
    union all
    select null::uuid, month_start, is_walk_in, fell_away, lead_days from base
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
    count(*) filter (where not c.is_walk_in and c.lead_days < 0)                            as retrospective,
    count(*) filter (where not c.is_walk_in and c.lead_days >= 0 and c.fell_away)           as cancelled
  from combined c
  group by c.venue_id, c.month_start;
$$;

comment on function public.booking_lead_time(date, date, text) is
  'Days between a booking being created and the date it was for, per venue per '
  'month, for one meal (p_meal) or the whole day (null). venue_id NULL is the '
  'group. Walk-ins are excluded and counted. Future business dates are '
  'excluded. Created time is converted to Singapore time before subtracting. '
  '`cancelled` counts the included bookings later cancelled or no-show.';
