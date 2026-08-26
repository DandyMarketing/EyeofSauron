-- Do guests come back — to this venue, and to the group?
--
-- Measured 25 Aug 2026 and it is the most important thing about this business
-- that the engine could not previously see. For the week of 17-23 August:
-- 356 booked guests across three venues, 42 returning to the same venue, 12
-- arriving from a sister venue, 302 new to the group entirely. The group
-- acquires roughly six guests for every one it keeps.
--
-- WHY IT IS A DATABASE FUNCTION AND NOT TYPESCRIPT. Answering it means looking
-- at every prior visit by every guest who came this week -- 116,000 completed
-- reservations. PostgREST silently caps a result at 1,000 rows, which is the
-- defect recorded in BUILD_LOG section 1 and the one this codebase has hit most
-- often. Fetching the table to count it in Node would be wrong at 1,000 rows and
-- would still look right. Postgres does the arithmetic; we read four integers.
--
-- WALK-INS ARE EXCLUDED, AND THAT IS NOT A PREFERENCE. SevenRooms mints a fresh
-- client record for nearly every walk-in: 20,347 walk-in visits carry 20,300
-- distinct client ids, so visits-per-guest is 1.00 against 1.34 for booked
-- guests. Those ids are disposable, so a walk-in can never be seen returning
-- and including them would understate retention by construction. They are
-- counted separately instead, because the SHARE they represent is how much of
-- the venue this metric cannot see -- 17.5% group-wide, but 31% at Neon Pigeon.
--
-- OUTLET AND GROUP RETENTION ARE SEPARATE ANSWERS TO SEPARATE QUESTIONS, and
-- collapsing them into one rate is why this was never actionable. Whether a
-- guest returns to THIS venue is the venue's own work -- the food, the room,
-- the service, the reason to come back. Whether the group holds the guest at
-- all is a group job: CRM, cross-venue communication, whether a Fat Prince
-- guest has ever been told Neon Pigeon exists. Different owners, different
-- levers, and one blended number tells neither of them what to do.
--
-- A FIXED LOOKBACK, NOT "HAS EVER VISITED". With four and a half years of
-- history, "ever" would mean the rate climbs every month purely because the
-- window widens -- the same trap as Instagram's follower count, a number that
-- appears to trend and is really measuring how long we have been collecting.
-- 365 days keeps the denominator still, so the movement is real.

create index if not exists reservations_client_history_idx
  on public.reservations (sevenrooms_client_id, business_date)
  where sevenrooms_client_id is not null and status_simple = 'Complete';

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
  with visits as (
    -- Completed only. A cancellation is not a visit and a no-show is
    -- emphatically not one; together they are about 18% of all rows.
    select venue_id, sevenrooms_client_id, business_date
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = false
      and sevenrooms_client_id is not null
  ),
  period as (
    -- DISTINCT: a guest who came twice this week is one guest, not two.
    select distinct venue_id, sevenrooms_client_id
    from visits
    where business_date between p_start and p_end
  ),
  flagged as (
    select
      t.venue_id,
      exists (
        select 1 from visits p
        where p.sevenrooms_client_id = t.sevenrooms_client_id
          and p.venue_id             = t.venue_id
          and p.business_date <  p_start
          and p.business_date >= p_start - p_lookback
      ) as same_venue,
      exists (
        select 1 from visits p
        where p.sevenrooms_client_id = t.sevenrooms_client_id
          and p.venue_id            <> t.venue_id
          and p.business_date <  p_start
          and p.business_date >= p_start - p_lookback
      ) as other_venue
    from period t
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
  'Booked-guest retention for a period. Walk-ins are EXCLUDED from the four retention columns because SevenRooms gives each walk-in a fresh client id (1.00 visits per guest vs 1.34 booked) — they are counted separately as the size of the blind spot. returning_here + crossed_from_sister + new_to_group = booked_guests, mutually exclusive by construction.';
