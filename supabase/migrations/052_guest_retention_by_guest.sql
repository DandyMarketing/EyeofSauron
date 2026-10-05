-- ============================================================
-- guest_retention(): look up the month's guests, not all history.
-- Run this in Supabase SQL Editor AFTER 051_cover_pickup.sql
--
-- SYMPTOM, 5 Oct 2026, in the production log:
--   [dashboard] retention unavailable: canceling statement due to
--   statement timeout
-- on a background refresh. The dashboard kept serving the previous value,
-- which is what its cache is for -- but the next cold start would have had
-- nothing to fall back on, and the panel would have gone.
--
-- CAUSE. On 4 Oct the dashboard switched retention from a one-year lookback
-- to a LIFETIME one (Khai: "people who had been guest in our life time").
-- Migration 044 made this function fast by bounding the history scan BY
-- DATE. A lifetime bound sits before everything held, so the scan became
-- every completed visit since April 2022 again -- the shape 044 had removed.
-- Measured locally on production-sized data, 65-115 ms at a year became
-- 120-200 ms at lifetime; Supabase's shared tier is several times slower,
-- and close enough to its statement timeout to cross it sometimes.
--
-- FIX. Bound history by WHO instead: the guests who booked in the period.
-- Read each one's past through the (client, date) index from migration 028.
--
-- THE ANSWER IS UNCHANGED, and that was checked rather than asserted: the
-- old and new functions were run side by side on 142,896 synthetic
-- reservations, for several months, at a one-year and a lifetime lookback,
-- and every row of output compared. Same signature, same four mutually
-- exclusive columns, same walk-in exclusion. Every caller -- the dashboard,
-- create_chart's 365-day line, the query tools -- is unaffected except in
-- speed.
-- ============================================================

create or replace function public.guest_retention(
  p_start    date,
  p_end      date,
  p_lookback int default 365
)
returns table (
  venue_id            uuid,
  booked_guests       bigint,
  returning_here      bigint,
  crossed_from_sister bigint,
  new_to_group        bigint,
  walk_in_guests      bigint
)
language sql
stable
as $$
  with period as (
    -- DISTINCT: a guest who came twice this week is one guest, not two.
    select distinct venue_id, sevenrooms_client_id
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = false
      and sevenrooms_client_id is not null
      and business_date between p_start and p_end
  ),
  -- WHOSE history, not WHEN. 044 bounded history by date, which was the fix
  -- for a one-year window; for a lifetime window the date bound sits before
  -- everything held and the scan is the whole table again. What actually
  -- decides the cost is how many guests are being looked up, and that is the
  -- month's guests -- about 1,500 -- not every visit since 2022. Starting from
  -- them and reading each one's past through reservations_client_history_idx
  -- (client, date; migration 028) makes the cost track the month, whatever
  -- the lookback.
  guests as (
    select distinct sevenrooms_client_id from period
  ),
  history as (
    select distinct r.venue_id, r.sevenrooms_client_id
    from guests g
    join public.reservations r
      on r.sevenrooms_client_id = g.sevenrooms_client_id
    where r.status_simple = 'Complete'
      and r.is_walk_in = false
      and r.business_date >= p_start - p_lookback
      and r.business_date <  p_start
  ),
  flagged as (
    select
      t.venue_id,
      t.sevenrooms_client_id,
      -- coalesce because a guest with no history joins to a NULL row, and
      -- bool_or over nothing is NULL rather than false. Left uncoalesced, a
      -- first-time guest would count as neither new nor returning and quietly
      -- vanish from a set of columns that is supposed to sum to the total.
      coalesce(bool_or(h.venue_id =  t.venue_id), false) as same_venue,
      coalesce(bool_or(h.venue_id <> t.venue_id), false) as other_venue
    from period t
    left join history h
      on h.sevenrooms_client_id = t.sevenrooms_client_id
    group by t.venue_id, t.sevenrooms_client_id
  ),
  walk_ins as (
    -- Counted, never mixed in. This is the size of the blind spot.
    select venue_id, count(distinct sevenrooms_client_id) as guests
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = true
      and sevenrooms_client_id is not null
      and business_date between p_start and p_end
    group by 1
  )
  select
    f.venue_id,
    count(*)                                                   as booked_guests,
    count(*) filter (where same_venue)                         as returning_here,
    -- Crossed, not returned: they came back to the GROUP at a different room.
    -- `and not same_venue` keeps the four columns mutually exclusive, so they
    -- sum to booked_guests and cannot double-count anyone.
    count(*) filter (where other_venue and not same_venue)     as crossed_from_sister,
    count(*) filter (where not same_venue and not other_venue) as new_to_group,
    coalesce(w.guests, 0)                                      as walk_in_guests
  from flagged f
  left join walk_ins w on w.venue_id = f.venue_id
  group by f.venue_id, w.guests;
$$;

comment on function public.guest_retention(date, date, int) is
  'Booked-guest retention for a period. Walk-ins are EXCLUDED from the four '
  'retention columns because SevenRooms gives each walk-in a fresh client id '
  '(1.00 visits per guest vs 1.34 booked) — they are counted separately as the '
  'size of the blind spot. returning_here + crossed_from_sister + new_to_group '
  '= booked_guests, mutually exclusive by construction. 052: history is read '
  'for the period''s guests through the client index, so the cost tracks the '
  'period whatever the lookback, including the dashboard''s lifetime one.';
