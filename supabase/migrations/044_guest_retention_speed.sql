-- guest_retention() times out, and the index built for it was never usable.
--
-- SYMPTOM, 22 Sep 2026: every call fails on a statement timeout — one venue,
-- one week, any range. The shape of that is the clue. A query whose cost tracks
-- the question would get faster as the window narrows; this one does not,
-- because the expensive part never depended on the window at all.
--
-- CAUSE. Migration 028 opened with `with visits as (...)` selecting EVERY
-- completed booked reservation — about 116,000 rows, with no date bound — and
-- then referenced it three times: once to find the period's guests, and twice
-- more inside correlated `exists` subqueries checking each guest's history.
--
-- Postgres materialises a CTE that is referenced more than once. So `visits`
-- was built in full, as a temporary result, and a temporary result HAS NO
-- INDEXES. The partial index created immediately above it —
-- reservations_client_history_idx, on exactly the columns those lookups use —
-- could never be consulted, because the lookups were not reading the table.
-- Every guest in the period cost two sequential scans of 116,000 rows. Six
-- hundred guests in a week is seventy million comparisons, and narrowing to one
-- venue removes none of them.
--
-- An index that cannot be used looks identical to one that is working. Nothing
-- reported this; it surfaced as a chat answer apologising for a system fault.
--
-- THE FIX IS THE SHAPE, NOT A HINT. Marking the CTE NOT MATERIALIZED would
-- probably restore the index and is a one-word change, but it leaves the answer
-- depending on a planner decision that can flip when the table grows. This
-- bounds both sides by date instead and joins them:
--
--   period  — distinct guests who visited in the window
--   history — distinct (venue, guest) pairs in the lookback BEFORE it
--
-- Both are date-bounded scans. One hash join replaces the per-guest subqueries,
-- and `history` is distinct on (venue_id, client) so a guest contributes at
-- most one row per venue rather than one per visit.
--
-- THE ANSWER IS UNCHANGED. Same four mutually exclusive columns, same walk-in
-- exclusion, same fixed lookback. Only the plan is different, which is what
-- makes this safe to apply without re-checking every figure that has been
-- quoted from it.

-- Matches the new access pattern: a date range, then the guest. The old index
-- is left in place — it is small, and queries elsewhere may lean on it.
create index if not exists reservations_retention_window_idx
  on public.reservations (business_date, sevenrooms_client_id)
  where status_simple = 'Complete'
    and is_walk_in = false
    and sevenrooms_client_id is not null;

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
  history as (
    -- BOUNDED BY THE LOOKBACK, which is the whole repair. Migration 028 read
    -- every visit ever recorded here and then filtered per guest; this reads
    -- only the window that can possibly matter.
    select distinct venue_id, sevenrooms_client_id
    from public.reservations
    where status_simple = 'Complete'
      and is_walk_in = false
      and sevenrooms_client_id is not null
      and business_date >= p_start - p_lookback
      and business_date <  p_start
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
  '= booked_guests, mutually exclusive by construction. Rewritten in 044: the '
  'original materialised an unbounded CTE and timed out at any window size.';
