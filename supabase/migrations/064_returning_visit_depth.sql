-- ============================================================
-- returning_visit_depth(): how many times "been here before" had been here.
-- Run this in Supabase SQL Editor AFTER 063_profile_brief_seen.sql
--
-- Khai, 17 Oct 2026, on the dashboard's Guests panel: "is it possible to
-- differentiate between all the 2 visits 3 visits and 4+ visits?"
--
-- WHAT IT COUNTS. The month's booked guests who had been to THIS venue before
-- the month -- exactly guest_retention()'s returning_here -- split by how many
-- times they had been: once (this month is their 2nd visit), twice (3rd), three
-- or more (4th or more). The three columns sum to returning_here by
-- construction: same period guests, same history filters, same lookback. The
-- dashboard checks that they do and shows nothing rather than a split that
-- disagrees with the line above it.
--
-- A VISIT IS A DAY. Two bookings on the same evening are one visit, as in
-- visit_distribution() (032) -- otherwise a large party split across two
-- reservations reads as a guest who came back.
--
-- GUESTS, NOT VISITS. A guest who came twice this month is one guest, placed by
-- the visits they had before it, so the rows answer "who was in the room" and
-- sit under the panel's guest count. visit_distribution() answers the other
-- question, "which visit number was each visit", and is what the chat uses.
--
-- SAME SHAPE AS 052, for the same reason: history is read for the month's
-- guests through the (client, date) index, so the cost tracks the month and a
-- lifetime lookback cannot time out. A NEW function beside guest_retention()
-- rather than more columns on it, so nothing already calling that one changes.
-- ============================================================

create or replace function public.returning_visit_depth(
  p_start    date,
  p_end      date,
  p_lookback int default 365
)
returns table (
  venue_id     uuid,
  second_visit bigint,   -- been here once before
  third_visit  bigint,   -- twice before
  fourth_plus  bigint    -- three or more times before
)
language sql
stable
as $$
  with period as (
    select distinct venue_id, sevenrooms_client_id
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = false
      and sevenrooms_client_id is not null
      and business_date between p_start and p_end
  ),
  guests as (
    select distinct sevenrooms_client_id from period
  ),
  history as (
    -- count(distinct business_date): a visit is a day, not a reservation.
    select r.venue_id, r.sevenrooms_client_id, count(distinct r.business_date) as days
    from guests g
    join public.reservations r
      on r.sevenrooms_client_id = g.sevenrooms_client_id
    where r.status_simple = 'Complete'
      and r.is_walk_in = false
      and r.business_date >= p_start - p_lookback
      and r.business_date <  p_start
    group by r.venue_id, r.sevenrooms_client_id
  )
  select
    p.venue_id,
    count(*) filter (where h.days = 1)  as second_visit,
    count(*) filter (where h.days = 2)  as third_visit,
    count(*) filter (where h.days >= 3) as fourth_plus
  from period p
  -- INNER join to history at the SAME venue: only guests who had been HERE.
  join history h
    on h.venue_id = p.venue_id
   and h.sevenrooms_client_id = p.sevenrooms_client_id
  group by p.venue_id;
$$;

comment on function public.returning_visit_depth(date, date, int) is
  'The period''s returning booked guests (guest_retention.returning_here) split '
  'by how many days they had been to the same venue before the period: 1, 2, '
  '3+. Sums to returning_here. Walk-ins excluded, a visit is a day. 064.';
