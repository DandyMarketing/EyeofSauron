-- ============================================================
-- Cover pickup: what the book looked like N days before service,
-- and what was actually served on the night.
-- Run this in Supabase SQL Editor AFTER 050_conversations.sql
--
-- WHY IT EXISTS. The dashboard forecasts covers for the coming
-- days by the PICKUP method: take what is booked now, and add
-- what usually arrives between now and service on that weekday
-- at that venue -- walk-ins and late bookings, less late
-- cancellations and no-shows. To know what "usually arrives",
-- we need, for every past night, the book as it stood N days
-- out and the covers finally served. This returns exactly that
-- and nothing else; the modelling is in src/lib/forecast.ts,
-- where it can be tested.
--
-- WE CAN ONLY DO THIS BECAUSE OF source_created_at. Every
-- reservation carries the moment it was MADE, on 142,623 of
-- 142,623 rows back to April 2022, so the book as it stood on
-- any past afternoon is reconstructible: count the bookings for
-- that night that had already been made.
--
-- WHAT IT CANNOT RECONSTRUCT, stated rather than hidden. We
-- store each reservation's CURRENT state, not its history:
--   * A cancellation is dated by source_updated_at, the LAST
--     time the row changed. A booking cancelled on Monday and
--     touched again on Wednesday looks cancelled on Wednesday.
--     The book at a cutoff is therefore slightly overstated.
--   * Party size is the final party size. A four that became a
--     six counts as six from the moment it was made.
--   * A booking moved from Friday to Saturday counts as a
--     Saturday booking from the day it was first made.
-- All three are small, and all three apply identically to the
-- past nights the forecast learns from and the backtest it is
-- scored on -- so they blur the picture slightly rather than
-- biasing it one way.
--
-- THE CUTOFF IS A CLOCK TIME, NOT MIDNIGHT. "The book three days
-- out" is taken at the SAME time of day as the forecast is being
-- made, so a forecast at 4pm learns from books as they stood at
-- 4pm. Midnight would leave a forecast built from a book that is
-- missing today's bookings, beside a "booked" figure that has
-- them -- a range whose bottom sat below what was already on the
-- book.
--
-- RETURNS ONE jsonb VALUE, NOT A SET OF ROWS. PostgREST caps a
-- set at 1,000 rows and this is several thousand; the cap drops
-- the tail without an error, which is how getCovers once lost
-- the most recent dates. A single value is not subject to it.
-- Arrays rather than objects, because this is read by a server
-- and not by a person: a third of the size.
--
-- NO PERSONAL DATA. Counts of covers by venue and date.
-- ============================================================

create or replace function public.cover_pickup(
  p_venue_ids   uuid[],
  p_pickup_from date,     -- first night to reconstruct books for
  p_final_from  date,     -- first night to return served covers for
  p_to          date,     -- last night (yesterday: tonight is not final)
  p_leads       int[],    -- days before service, e.g. {1,2,3,4,5}
  p_clock       time      -- Singapore time of day the cutoff is taken at
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with
  -- Every reservation the two halves need, read once.
  base as (
    select r.venue_id, r.business_date, r.party_size, r.status_simple,
           r.is_walk_in, r.source_created_at, r.source_updated_at
    from public.reservations r
    -- An EMPTY id array matches nothing. `= any('{}')` is false for
    -- every row, which is the safe direction: the caller passes the
    -- venues in scope, and none must never be read as all.
    where r.venue_id = any(p_venue_ids)
      and r.business_date between least(p_pickup_from, p_final_from) and p_to
  ),

  -- What was served on each night. Completed covers, walk-ins
  -- INCLUDED -- a walk-in eats, and they are a third of the room
  -- at Neon Pigeon. This is the number the forecast is aiming at.
  finals as (
    select venue_id, business_date,
           coalesce(sum(party_size) filter (where status_simple = 'Complete'), 0) as served
    from base
    where business_date >= p_final_from
    group by venue_id, business_date
  ),

  -- The book for each night as it stood `lead` days earlier, at
  -- p_clock Singapore time.
  books as (
    select b.venue_id, b.business_date, l.lead_days,
           coalesce(sum(b.party_size) filter (
             where not b.is_walk_in
               and b.source_created_at is not null
               -- Already made by the cutoff. The naive timestamp is
               -- read AS Singapore time and converted to an instant,
               -- because source_created_at is UTC and comparing a
               -- local clock to it puts every cutoff eight hours out.
               and b.source_created_at <= ((b.business_date - l.lead_days) + p_clock) at time zone 'Asia/Singapore'
               -- And not yet cancelled by then. A no-show IS on the
               -- book at the cutoff -- nobody knew yet -- so only
               -- cancellations are removed.
               and (b.status_simple is distinct from 'Canceled'
                    or b.source_updated_at > ((b.business_date - l.lead_days) + p_clock) at time zone 'Asia/Singapore')
           ), 0) as booked
    from base b
    cross join unnest(p_leads) as l(lead_days)
    where b.business_date >= p_pickup_from
    group by b.venue_id, b.business_date, l.lead_days
  )

  select jsonb_build_object(
    -- [venue_id, 'YYYY-MM-DD', served]
    'finals', coalesce((
      select jsonb_agg(jsonb_build_array(venue_id, business_date, served) order by venue_id, business_date)
      from finals
    ), '[]'::jsonb),
    -- [venue_id, 'YYYY-MM-DD', lead, booked_at_cutoff]
    'books', coalesce((
      select jsonb_agg(jsonb_build_array(venue_id, business_date, lead_days, booked) order by venue_id, business_date, lead_days)
      from books
    ), '[]'::jsonb)
  );
$$;

comment on function public.cover_pickup(uuid[], date, date, date, int[], time) is
  'For each past night: covers served, and the book as it stood N days earlier at a given '
  'Singapore clock time. Raw observations for the pickup forecast in src/lib/forecast.ts. '
  'Reconstructed from source_created_at; cancellations are dated by source_updated_at, which '
  'slightly overstates the historical book. Returns one jsonb value to avoid the 1,000-row cap.';
