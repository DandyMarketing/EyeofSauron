-- ============================================================
-- guest_value(): what each kind of guest SPENDS, beside who they are.
-- Run this in Supabase SQL Editor AFTER 064_returning_visit_depth.sql.
--
-- Khai, 26 Nov 2026: retention counted guests and ignored their spend. Revel's
-- SevenRooms integration writes the POS bill onto the reservation, and Sauron
-- has stored it all along (pos_ticket_id, payment_net). Checked before this
-- was written, last 90 days of completed bookings:
--   - 97.6% (Fat Prince), 99.3% (Firangi), 98.4% (Neon Pigeon) carry a bill;
--   - 98-99% of those have a spend above zero; none over $1,000 a cover; no
--     bill number on two bookings;
--   - SevenRooms spend is 86-92% of Revel net sales in EVERY month May-Nov
--     2026 at every venue, steady -- under 100%, so it adds no tax or service
--     charge Revel leaves out; the rest is walk-ups never put in SevenRooms.
--
-- SAME GUESTS, SAME GROUPS AS guest_retention() (migration 052): booked, not
-- walk-in, completed, sorted by their history before the period into
-- returning here / crossed from a sister venue / new to the group. A guest's
-- group is decided once per venue and every booking of theirs in the period
-- carries it, so the guests here are exactly the ones retention counts.
--
-- SPEND ONLY WHERE IT IS REAL: a booking counts toward spend when it carries a
-- bill AND a spend above zero. Bookings without one are counted beside it
-- (linked_bookings vs bookings) so a thin figure says it is thin. Per cover is
-- spend over the covers OF THOSE SAME bookings, never all covers -- dividing a
-- partial spend by a full headcount would understate every group.
-- ============================================================

create or replace function public.guest_value(
  p_start    date,
  p_end      date,
  p_lookback int default 365
)
returns table (
  venue_id         uuid,
  guest_group      text,
  guests           bigint,
  bookings         bigint,
  covers           bigint,
  linked_bookings  bigint,
  linked_covers    bigint,
  spend            numeric
)
language sql
stable
as $$
  with period as (
    select venue_id, sevenrooms_client_id, party_size, pos_ticket_id, payment_net
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = false
      and sevenrooms_client_id is not null
      and business_date between p_start and p_end
  ),
  guests as (
    select distinct sevenrooms_client_id from period
  ),
  -- History read for the period's guests through the client index (052).
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
      coalesce(bool_or(h.venue_id =  t.venue_id), false) as same_venue,
      coalesce(bool_or(h.venue_id <> t.venue_id), false) as other_venue
    from (select distinct venue_id, sevenrooms_client_id from period) t
    left join history h
      on h.sevenrooms_client_id = t.sevenrooms_client_id
    group by t.venue_id, t.sevenrooms_client_id
  ),
  grouped as (
    select
      f.venue_id,
      f.sevenrooms_client_id,
      case when f.same_venue then 'returning_here'
           when f.other_venue then 'crossed_from_sister'
           else 'new_to_group' end as guest_group
    from flagged f
  )
  select
    g.venue_id,
    g.guest_group,
    count(distinct g.sevenrooms_client_id)                                        as guests,
    count(*)                                                                      as bookings,
    coalesce(sum(p.party_size), 0)                                                as covers,
    count(*) filter (where p.pos_ticket_id is not null and p.payment_net > 0)     as linked_bookings,
    coalesce(sum(p.party_size) filter (where p.pos_ticket_id is not null and p.payment_net > 0), 0) as linked_covers,
    coalesce(sum(p.payment_net) filter (where p.pos_ticket_id is not null and p.payment_net > 0), 0) as spend
  from grouped g
  join period p
    on p.venue_id = g.venue_id and p.sevenrooms_client_id = g.sevenrooms_client_id
  group by g.venue_id, g.guest_group;
$$;

comment on function public.guest_value(date, date, int) is
  'Spend by retention group (072). Same guests and groups as guest_retention(): '
  'booked, completed, non-walk-in, grouped by history before the period. Spend '
  'counts only bookings with a POS bill and payment_net > 0; linked_bookings and '
  'linked_covers say how many that was, and per-cover figures divide by '
  'linked_covers, never all covers.';

-- Check after running (should list three groups per venue for last month):
--   select v.name, g.guest_group, g.guests, g.bookings, g.linked_bookings,
--          round(g.spend / nullif(g.linked_covers, 0), 2) as per_cover
--   from public.guest_value((date_trunc('month', current_date) - interval '1 month')::date,
--                           (date_trunc('month', current_date) - interval '1 day')::date, 36500) g
--   join public.venues v on v.id = g.venue_id
--   order by v.name, g.guest_group;
