-- Bookings per channel per month, so a channel that dies is visible.
--
-- WHY THIS EXISTS. Neon Pigeon's two online booking paths both collapsed in
-- February 2025 and stayed down until June. Google Reserve went 86, 43, 5, 1.
-- The booking widget went 186, 133, 32, 24, 14. Total bookings fell from an
-- average of 481 a month to 391 and new guests from ~272 to ~208 -- roughly 360
-- lost bookings over four months, cushioned only because business shifted to
-- the phone and to landing pages.
--
-- It was not hidden. Nobody was looking at booking channel by month, so there
-- was nothing for it to hide from. A week-on-week comparison would not have
-- caught it either: a 20% decline spread over four months is invisible at that
-- resolution.
--
-- AGGREGATED IN POSTGRES, not fetched and counted in Node. A year of
-- reservations for three venues is several thousand rows and PostgREST caps a
-- result at 1,000 -- silently, which is the defect this codebase has hit more
-- than any other.
--
-- THE LONG TAIL IS DROPPED HERE. Most distinct `booked_by` values are staff
-- names with a handful of bookings each, and returning them would be hundreds
-- of rows that no monitor will ever alarm on -- they are below the materiality
-- floor by construction. p_min_bookings removes them before they cost anything.
--
-- NOT normalised in SQL. Folding "Google" and "Google Reserve Integration"
-- together is a real requirement -- SevenRooms renamed the channel mid-period
-- and compared raw it reads as one channel dying and another being born -- but
-- it belongs in normaliseChannel(), where it is unit-tested against the actual
-- labels rather than buried in a CASE nobody can exercise.

create index if not exists reservations_channel_month_idx
  on public.reservations (venue_id, business_date)
  where status_simple = 'Complete';

create or replace function public.booking_channel_months(
  p_from         date,
  p_to           date,
  p_min_bookings int default 10
)
returns table (
  venue_id   uuid,
  month      date,
  booked_by  text,
  is_walk_in boolean,
  bookings   bigint
)
language sql
stable
as $$
  with counted as (
    select
      r.venue_id,
      date_trunc('month', r.business_date)::date as month,
      coalesce(r.booked_by, '')                  as booked_by,
      r.is_walk_in,
      count(*)                                   as bookings
    from public.reservations r
    where r.status_simple = 'Complete'
      and r.business_date >= p_from
      and r.business_date <= p_to
    group by 1, 2, 3, 4
  )
  select c.*
  from counted c
  where exists (
    -- Keep every month of a channel that was material in ANY month, so a
    -- channel's collapse to zero is still visible next to the months it was
    -- healthy. Filtering month by month would delete exactly the rows the
    -- monitor needs.
    select 1 from counted peak
    where peak.venue_id  = c.venue_id
      and peak.booked_by = c.booked_by
      and peak.is_walk_in = c.is_walk_in
      and peak.bookings >= p_min_bookings
  );
$$;

comment on function public.booking_channel_months(date, date, int) is
  'Completed bookings per channel per month. Channels never reaching p_min_bookings in any month are dropped (a long tail of staff names). Labels are RAW — fold aliases with normaliseChannel() in src/lib/channel-health.ts, because SevenRooms renames channels.';
