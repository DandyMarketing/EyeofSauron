-- What actually moved when revenue moved.
--
-- WHY THIS IS ARITHMETIC AND NOT ANALYSIS. Revenue is an identity:
--
--     revenue = covers x spend per head
--     covers  = booked covers + walk-in covers
--     booked  = bookings x average party size
--
-- So a change in revenue can be attributed EXACTLY, with nothing left over and
-- no statistics involved. It cannot produce a false finding, it needs no
-- confidence caveat, and it answers the most common real question -- "why did
-- revenue drop" -- in a way a correlation never can.
--
-- WHY IT EXISTS NOW. The dry run on 9 Sep 2026 did this by hand for Fat Prince
-- across THIRTY-TWO queries, and landed on the answer: the dining room had its
-- best week per head on record and the gap was private-event trade, visible as
-- average party size falling from 3.5 to 3.0. That is the right answer and it
-- cost thirty-two round trips of Opus to assemble. It is one query.
--
-- It is also the April 2025 investigation made repeatable. Booked covers at
-- Neon Pigeon halved while walk-ins held, which said the booking pipe broke
-- rather than the venue failing -- found manually, months late, and only
-- because somebody went looking.
--
-- CORRELATION IS THE SECOND QUESTION, NOT THIS ONE. This says WHAT moved.
-- Whether social reach or a holiday moved with it is a different tool with
-- different dangers -- trend, seasonality, multiple comparisons, and labour
-- hours correlating with revenue because you roster more when you expect more.
-- None of those can touch a subtraction.
--
-- THE SEAM, STATED RATHER THAN HIDDEN. Revenue comes from Revel and covers
-- from SevenRooms, so spend per head divides one system by another. CLAUDE.md
-- records that the two disagree slightly on guest counts, so a small move in
-- spend per head can be two systems counting differently rather than guests
-- behaving differently. The caveat travels with the figure -- see
-- src/lib/revenue-decomposition.ts.
--
-- DEFINITIONS ARE THE EXISTING ONES, deliberately, because a decomposition that
-- disagreed with query_reservations about how many covers there were would be
-- worse than no decomposition:
--   covers      party_size where status_simple = 'Complete'
--   bookings    rows that were neither cancelled nor a no-show
--   net sales   daily_operations.net_sales, which is Revel's "Total Sales"

-- A SINGLE COMPARISON IS A COIN TOSS, so a trailing series comes back with it.
--
-- The same dry run reached its actual conclusion from the baseline rather than
-- the comparison: the review week was 11% below the week before AND 17% above
-- the four-week July average, so the fortnight in between was the outlier and
-- not this week the collapse. Week-on-week alone would have reported a crash.
--
-- p_trailing_weeks of complete weeks ending at p_prev_end are returned as their
-- own rows, so "is this week unusual" and "which way are we heading" are
-- answered from the same round trip.

create or replace function public.revenue_decomposition(
  p_start           date,
  p_end             date,
  p_prev_start      date,
  p_prev_end        date,
  p_trailing_weeks  int default 8
)
returns table (
  venue_id        uuid,
  -- 'current' or 'prior'. Two rows per venue rather than a wide row, so adding
  -- a third period later is a filter change rather than a schema change.
  period          text,
  net_sales       numeric,
  covers          bigint,
  booked_covers   bigint,
  walkin_covers   bigint,
  bookings        bigint,
  trading_days    bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with windows as (
    select 'current'::text as period, p_start as d0, p_end as d1
    union all
    select 'prior'::text,             p_prev_start,  p_prev_end
    union all
    -- The trailing weeks, each labelled by its own start date so the caller can
    -- order them without parsing anything. They run BACKWARDS from the day
    -- before the prior period, so no week is counted twice.
    select
      'week:' || to_char(p_prev_start - (i * 7), 'YYYY-MM-DD'),
      p_prev_start - (i * 7),
      p_prev_start - (i * 7) + 6
    from generate_series(1, greatest(p_trailing_weeks, 0)) as i
  ),
  sales as (
    select w.period, o.venue_id,
           sum(coalesce(o.net_sales, 0))::numeric as net_sales,
           /**
            * A trading day is one the POS recorded, so a closure is absent
            * rather than a zero. Firangi closes every Sunday, and counting
            * that as a day would make any per-day figure wrong for one venue
            * and right for the others -- BUILD_LOG 3.2.
            */
           count(*)::bigint as trading_days
    from windows w
    join public.daily_operations o
      on o.business_date between w.d0 and w.d1
    group by w.period, o.venue_id
  ),
  res as (
    select w.period, r.venue_id,
           sum(r.party_size) filter (where r.status_simple = 'Complete')::bigint as covers,
           sum(r.party_size) filter (where r.status_simple = 'Complete' and not r.is_walk_in)::bigint as booked_covers,
           sum(r.party_size) filter (where r.status_simple = 'Complete' and r.is_walk_in)::bigint as walkin_covers,
           -- Active bookings: the same basis query_reservations uses, so the
           -- two tools cannot disagree about how many bookings there were.
           count(*) filter (where r.status_simple not in ('Canceled', 'No Show') and not r.is_walk_in)::bigint as bookings
    from windows w
    join public.reservations r
      on r.business_date between w.d0 and w.d1
    group by w.period, r.venue_id
  )
  select
    coalesce(s.venue_id, x.venue_id),
    coalesce(s.period, x.period),
    coalesce(s.net_sales, 0),
    coalesce(x.covers, 0),
    coalesce(x.booked_covers, 0),
    coalesce(x.walkin_covers, 0),
    coalesce(x.bookings, 0),
    coalesce(s.trading_days, 0)
  -- FULL join: a venue with sales and no reservations, or reservations and no
  -- sales, is a data gap worth seeing rather than a row to drop silently.
  from sales s
  full outer join res x
    on x.venue_id = s.venue_id and x.period = s.period;
$$;

comment on function public.revenue_decomposition(date, date, date, date, int) is
  'Net sales, covers, booked and walk-in covers, bookings and trading days for '
  'two periods per venue. The arithmetic that attributes a revenue change to '
  'covers versus spend per head is done in src/lib/revenue-decomposition.ts. '
  'Covers are from SevenRooms and sales from Revel, so spend per head divides '
  'one system by another. Trailing weeks come back as period = week:YYYY-MM-DD, '
  'because one comparison is a coin toss and the baseline is what says whether '
  'a week is unusual or the week before it was.';
