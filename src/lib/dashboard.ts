/**
 * The week-to-date figures behind the dashboard, for one venue or several.
 *
 * ONE CALL FOR THE WHOLE PAGE. The front-end rules in CLAUDE.md say never to
 * serialise two requests that do not depend on each other, and the strongest
 * version of that is not to make the second request at all: the page needs
 * figures, a daily line, tonight's book and the week's advice, and asking for
 * them separately would put four round trips on a phone on mobile data between
 * services. The handler assembles them in parallel and returns one object.
 *
 * NOTHING IS COMPUTED IN THE BROWSER. Every figure here comes out of the
 * warehouse through src/lib/sales.ts, including the percentages -- a share the
 * page worked out itself is a number nobody can check, and it is the easiest
 * kind to get subtly wrong. Same rule as the query tools.
 *
 * VENUE SCOPE IS THE CALLER'S JOB AND IT IS NOT OPTIONAL. This runs with the
 * service role, which bypasses RLS entirely, so the venue list passed in IS the
 * control. `venueIds: []` must never be read as "no restriction" -- that is the
 * exact trap BUILD_LOG 4.3 records, and the endpoint refuses rather than
 * widening.
 */

import { supabaseAdmin } from '../auth/session.js';
import { salesFiguresOf, classSplitOf, sumClassSplits, foodAndBevSalesOf } from './sales.js';
import { getCovers, getDayMoments } from './covers.js';
import { serviceDays, serviceNote, syncAge, sgtClock, sgtToday } from './service-day.js';
import { HourlyCache, settleWithin, type CacheState } from './hourly-cache.js';
import {
  parsePickup, backtest, venueForecast, groupForecast, combineBacktests, scoreBacktest, seasonalLift,
  BACKTEST_DAYS, TRAINING_WEEKS,
  type PickupData, type BacktestRecord, type CoverForecast,
} from './forecast.js';
import { periodWindow, movement, defaultPeriod, type PeriodKind, type PeriodWindow } from './dashboard-window.js';
import { rollUp, type VenueWeek } from './dashboard-rollup.js';
import {
  lastCompleteMonth, retentionShares, sumCounts, inPlainWords,
  historyHorizon, LIFETIME_LOOKBACK_DAYS,
  type RetentionCounts, type RetentionShares, type HistoryHorizon,
} from './retention-month.js';
import { costRatios, costCaveats, costBucket, type CostRatios, type PLRow } from './cost-ratios.js';
import { trailingMonths, costTrend, trendNote, type CostPoint, type MonthInput } from './cost-trend.js';
import { readAllPages, selectAll } from './paged.js';
import { weeklyCogs, coverageFor, type WeeklyCogs, type BillLine, type AccountNames } from './weekly-cogs.js';
import { fetchAccountMap, resolveAccount } from './account-map.js';
export type { VenueWeek };
export { rollUp };
import { getClosedWeekdays } from '../ingest/revel.js';
import { weekdayOf } from '../ingest/closures.js';


/**
 * How far the service strip reaches either side of today.
 *
 * Two nights back rather than none, because the comparison an operator makes
 * out loud is "last night did 88, tonight we are on 96" -- and a strip that
 * starts at today can only ever show promises. Five forward keeps the whole
 * run to eight cells, which still scrolls on a phone without the week
 * disappearing off the end.
 */
const SERVICE_BACK = 2;
const SERVICE_FORWARD = 5;

interface SalesRowFromDb {
  venue_id: string;
  business_date: string;
  gross_sales: unknown;
  net_sales: unknown;
  item_discounts: unknown;
  order_discounts: unknown;
  total_transactions: unknown;
  sales_by_class: unknown;
  meal_periods: unknown;
}

/**
 * Read daily_operations for a window, PAGED.
 *
 * PostgREST caps a response at 1,000 rows and BUILD_LOG section 1 records that
 * costing data five separate times. Three venues times fourteen days cannot
 * reach it today, which is exactly the reasoning that was wrong every previous
 * time: the cap is a property of the database layer, not of this query's
 * current size.
 */
async function readOperations(venueIds: string[], start: string, end: string): Promise<SalesRowFromDb[]> {
  const PAGE = 1000;
  const rows: SalesRowFromDb[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('daily_operations')
      .select('venue_id, business_date, gross_sales, net_sales, item_discounts, order_discounts, total_transactions, sales_by_class, meal_periods')
      .in('venue_id', venueIds)
      .gte('business_date', start)
      .lte('business_date', end)
      .order('business_date', { ascending: true })
      // Three venues share every date, so the date alone is not a unique order
      // and offset paging over it can repeat or skip a row (BUILD_LOG 1.3).
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`dashboard: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as SalesRowFromDb[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

/** Zero sales and zero transactions means the venue did not open. */
function closed(row: SalesRowFromDb): boolean {
  return Number(row.gross_sales ?? 0) === 0 && Number(row.total_transactions ?? 0) === 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RetentionBlock {
  /** The month measured. Never the current week — see retention-month.ts. */
  month: { start: string; end: string; label: string };
  counts: RetentionCounts;
  shares: RetentionShares;
  /** The sentence to put in front of a manager, with the counts in it. */
  plain: string;
  /**
   * Set when "lifetime" is a year of history or less, in which case the rate
   * is understated by a shortfall that shrinks every month and must not be
   * shown as a measurement.
   */
  withheld: boolean;
  /**
   * How far back "ever" actually reaches. A lifetime rate reads as complete and
   * is not: it can see only as far as the first booking we ingested, so the
   * panel prints that date rather than letting "before" sound absolute.
   */
  horizon: HistoryHorizon;
}

export interface CostBlock {
  month: { start: string; end: string; label: string };
  ratios: CostRatios;
  caveats: string[];
  /** False when no P&L has been ingested for that month. Never inferred. */
  available: boolean;
}

export interface DashboardPayload {
  window: PeriodWindow;
  /**
   * Food and beverage cost for the SELECTED period, from supplier bills.
   *
   * Bills carry a date, so unlike the P&L this follows whatever window is on
   * screen -- which is the correction Khai made: "a weekly cogs is based on the
   * same week sales, invoices are uploaded at their best daily." Null when the
   * venue has no bills ingested. It sits BESIDE the ledger figure rather than
   * replacing it: bills are earlier and noisier, the ledger is slower and
   * settled, and the coverage percentage is what says which to believe.
   */
  period_costs: Record<string, WeeklyCogs> | null;
  /**
   * Cost of sales for the last COMPLETE month, beside the retention block and
   * for the same reason: the P&L's finest grain is a month, so there is no
   * week-to-date version of a food cost percentage. Null when nothing could be
   * computed at all.
   */
  costs: Record<string, CostBlock> | null;
  /**
   * The same measure over six months, because one month of it is noise.
   *
   * A cost-of-sales line is purchases, not consumption, so a delivery near a
   * month end lands against sales it has not produced yet. Over six months that
   * mostly cancels and what is left is drift -- the thing worth acting on, and
   * the thing nobody can see one month at a time.
   */
  cost_trend: Record<string, { points: CostPoint[]; note: string }> | null;
  /**
   * MONTHLY, and labelled as such. Null when SevenRooms has nothing to measure.
   * It sits on a week-to-date page because a week holds too few returning
   * guests for the rate to mean anything — the same reason create_chart forces
   * both retention measures to monthly whatever it is asked for.
   */
  retention: Record<string, RetentionBlock> | null;
  /**
   * Forecast covers for the nights on the service strip after today, with the
   * backtest that says how far to trust it. Null when it could not be computed
   * -- most likely migration 051 not yet applied -- and the page then simply
   * has no forecast panel, rather than no page.
   */
  forecast: Record<string, CoverForecast> | null;
  /**
   * Panels still computing when the page was sent -- cold cache only. The page
   * says "still calculating" for these instead of its empty state, which would
   * be a false statement about a figure that is seconds away.
   */
  pending: string[];
  venues: VenueWeek[];
  /** Present only when more than one venue is in scope. */
  group: VenueWeek | null;
}

/** Where a dashboard load spent its time, for the log line and Server-Timing. */
export type DashboardTimings = Record<string, { ms: number; cache?: CacheState }>;

/**
 * How long the optional panels may hold the page once sales and covers are in.
 *
 * Short on purpose. Sales and covers are what the page is opened for; a panel
 * that is still computing after they are ready ships as "still calculating"
 * and carries on into the cache, where the next load finds it. A warm cache
 * answers in well under a millisecond, so this only ever applies cold -- the
 * first load after a deploy, or of a new month.
 */
const PANEL_GRACE_MS = 250;

/**
 * The slow, slow-changing panels, cached by hour. See hourly-cache.ts for why
 * these four and why never sales or covers.
 */
const retentionCache = new HourlyCache<RetentionInputs>();
const costsCache = new HourlyCache<Record<string, CostBlock>>();
const periodCostsCache = new HourlyCache<Record<string, WeeklyCogs>>();
const forecastCache = new HourlyCache<ForecastInputs>();
const dataThroughCache = new HourlyCache<string | null>();

/**
 * Called after a Revel file is ingested, from the one route that does it.
 *
 * The last-day-of-data lookup is CLEARED, because the window must move to the
 * new day on the very next load -- "I uploaded it and it isn't there" is the
 * worst thing a dashboard can say after an upload. The two cost panels read
 * sales too and are EXPIRED instead: served once more as they were while the
 * refresh runs, so the upload costs nobody a wait. Retention and the forecast
 * read SevenRooms, which a Revel file does not touch, and are left alone.
 */
export function invalidateAfterSalesIngest(): void {
  dataThroughCache.clear();
  costsCache.expire();
  periodCostsCache.expire();
}

/**
 * A builder that returns null for "nothing there" and for "failed" alike, made
 * to throw instead -- so the cache never keeps a null for an hour. A failure is
 * retried next load; a venue with genuinely nothing is cheap to re-ask.
 */
const orThrow = <T>(name: string, p: Promise<T | null>) =>
  p.then(v => { if (v === null) throw new Error(`${name}: nothing to show`); return v; });

export async function buildDashboard(
  venues: Array<{ id: string; name: string; slug: string }>,
  today?: string,
  period?: PeriodKind,
  timings: DashboardTimings = {},
): Promise<DashboardPayload> {
  if (venues.length === 0) {
    throw new Error('dashboard: no venues in scope — refusing rather than reading every venue');
  }

  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);

  /**
   * ONE INSTANT FOR THE WHOLE PAYLOAD. Reading the clock separately per venue
   * would let three venues in one response describe three different moments,
   * and at 20:59 two of them would say 20:59 and one 21:00.
   */
  const now = new Date();
  const day = today ?? sgtToday(now);
  const hour = sgtClock(now).slice(0, 2);
  const token = `${day}|${hour}`;
  const ids = venues.map(v => v.id);
  const scope = [...ids].sort().join(',');
  const month = lastCompleteMonth(day);

  /**
   * EVERYTHING THAT NEEDS ONLY THE DATE STARTS NOW, before the one lookup the
   * rest depends on.
   *
   * This was two batches in sequence: sales and covers, THEN retention, cost of
   * sales, bills and the forecast -- none of which depend on the first batch.
   * The second batch therefore waited for the slowest read of the first before
   * starting its own, which is the serialisation CLAUDE.md forbids, and it went
   * unnoticed while the second batch was light. Today's additions made it heavy.
   */
  const track = <T>(name: string, c: { state: CacheState; value: Promise<T> }) => {
    c.value.then(() => { timings[name] = { ms: since(), cache: c.state }; }, () => {});
    return c;
  };
  // Keyed by MONTH alone: the RPC returns every venue whoever asks, so the
  // owner and every manager share one run. Each reader's slice is cut below.
  const retentionC = track('retention', retentionCache.get(month.start, token,
    () => loadRetentionInputs(month)));
  const costsC = track('costs', costsCache.get(`${month.start}|${scope}`, token,
    () => orThrow('costs', buildCosts(venues, day))));
  // Keyed by venues only, so the hour turning over -- or the day -- serves the
  // last history while the new one loads. The book it is applied to is live.
  const forecastC = track('forecast', forecastCache.get(scope, token,
    () => loadForecastInputs([...ids].sort(), day, hour)));
  // row-cap: the next five days hold at most a handful of holidays.
  const holidaysP = supabaseAdmin.from('public_holidays').select('holiday_date, name')
    .gt('holiday_date', day).lte('holiday_date', addDays(day, SERVICE_FORWARD));
  const momentsP = Promise.all(venues.map(v => getDayMoments(v.id, day)));
  const closedP = Promise.all(venues.map(v => getClosedWeekdays(v.id)));

  /**
   * THE LAST DAY WE ACTUALLY HAVE, before any window is built.
   *
   * Revel delivers overnight carrying the previous day, so during any given day
   * the warehouse's most recent complete day is yesterday. A window running to
   * the calendar's today therefore holds one day less TRADE than the window it
   * is compared against -- five days against six -- and reports a fall every
   * day of every week. The dates were right and the data behind one of them
   * was not, which is the hardest version of this to see.
   */
  /**
   * CACHED, BECAUSE IT CHANGES ONCE A DAY AND COST A FULL ROUND TRIP EVERY LOAD.
   *
   * The production log of 5 Oct 2026 put this one-row query at 110-700 ms,
   * with the whole core waiting on it -- not for the work, for the distance.
   * The answer moves only when a Revel file lands, and that happens through
   * this process: `invalidateAfterSalesIngest()` clears it there, so an upload
   * shows on the very next load rather than up to an hour later.
   */
  const dataThroughC = dataThroughCache.get(`${scope}|${day}`, token, async () => {
    const { data: latest, error } = await supabaseAdmin
      .from('daily_operations')
      .select('business_date')
      .in('venue_id', ids)
      // The Singapore day, not the server's: UTC is still yesterday until 8am.
      .lte('business_date', day)
      .order('business_date', { ascending: false })
      .limit(1);
    if (error) throw new Error(`data_through: ${error.message}`);
    return (latest?.[0]?.business_date as string | undefined) ?? null;
  });
  const dataThrough: string | null = await dataThroughC.value;
  timings.data_through = { ms: since(), cache: dataThroughC.state };

  const window = periodWindow(period ?? defaultPeriod(day), day, dataThrough);
  const periodCostsC = track('period_costs', periodCostsCache.get(
    `${window.current.start}|${window.current.end}|${day}|${scope}`, token,
    () => orThrow('period_costs', buildPeriodCosts(venues, window.current.start, window.current.end, day)),
  ));

  /**
   * Everything that does not depend on anything else, at once.
   *
   * The two sales reads and the covers reads have no ordering between them, and
   * awaiting them in sequence would make the slowest page in the app out of the
   * one people open most.
   */
  const [currentRows, priorRows, coversCurrent, coversPrior, coversService, todayMoments, closedWeekdays] = await Promise.all([
    readOperations(ids, window.current.start, window.current.end),
    readOperations(ids, window.prior.start, window.prior.end),
    Promise.all(venues.map(v => getCovers(v.id, window.current.start, window.current.end))),
    Promise.all(venues.map(v => getCovers(v.id, window.prior.start, window.prior.end))),
    // A couple of nights back through next week, so last night's actual and
    // tonight's book are on one strip without a second request.
    Promise.all(venues.map(v => getCovers(
      v.id, addDays(window.today, -SERVICE_BACK), addDays(window.today, SERVICE_FORWARD),
    ))),
    /**
     * TODAY AT RESERVATION GRAIN, which the daily roll-up above cannot give.
     *
     * Seating times are what separate "has eaten" from "is sitting here" from
     * "has not arrived", and they live on individual bookings. One extra read
     * per venue, for one date -- and only this panel pays for it. Started
     * above, with everything else that needs only the date.
     */
    momentsP,
    closedP,
  ]);
  timings.core = { ms: since() };

  const out: VenueWeek[] = venues.map((v, i) => {
    const mine = currentRows.filter(r => r.venue_id === v.id);
    const theirs = priorRows.filter(r => r.venue_id === v.id);

    const sum = (rows: SalesRowFromDb[]) => {
      const t = {
        gross_sales: 0, food_bev_sales: 0, food_sales: 0, beverage_sales: 0,
        net_sales: 0, service_charge: 0, total_discounts: 0, transactions: 0,
        trading_days: 0, closed_days: [] as string[],
      };
      for (const r of rows) {
        if (closed(r)) { t.closed_days.push(r.business_date); continue; }
        t.trading_days++;
        const f = salesFiguresOf(r as any);
        const split = classSplitOf(r as any);
        t.gross_sales += f.gross_sales;
        t.food_bev_sales += f.food_bev_sales;
        t.net_sales += f.net_sales;
        t.service_charge += f.service_charge ?? 0;
        t.total_discounts += f.total_discounts;
        t.food_sales += split.food_sales;
        t.beverage_sales += split.beverage_sales;
        t.transactions += Number(r.total_transactions ?? 0);
      }
      return t;
    };

    const cur = sum(mine);
    const pri = sum(theirs);

    /**
     * Covers are counted over the days that TRADED, matching the sales above.
     * A closed day has no covers and including it would not change the total,
     * but a venue with no SevenRooms data at all must come back null rather
     * than 0 — "nobody came" and "we cannot see" are different answers.
     */
    const coversOf = (m: Map<string, { covers: number }>) => {
      if (m.size === 0) return null;
      let n = 0;
      for (const c of m.values()) n += c.covers;
      return n;
    };
    const covers = coversOf(coversCurrent[i]);
    const priorCovers = coversOf(coversPrior[i]);

    const sph = covers && covers > 0 ? round2(cur.food_bev_sales / covers) : null;
    const priorSph = priorCovers && priorCovers > 0 ? round2(pri.food_bev_sales / priorCovers) : null;

    const daily = mine.map(r => {
      // A closed day is a GAP, never a zero. Plotted as zero it reads as a
      // collapse; the chart layer already works this way and the dashboard
      // must not disagree with it.
      const shut = closed(r);
      const split = shut ? null : classSplitOf(r as any);
      return {
        date: r.business_date,
        net_sales: shut ? null : round2(salesFiguresOf(r as any).net_sales),
        gross_sales: shut ? null : round2(foodAndBevSalesOf(r as any)),
        food_sales: split ? split.food_sales : null,
        beverage_sales: split ? split.beverage_sales : null,
        covers: coversCurrent[i].get(r.business_date)?.covers ?? null,
      };
    });

    /**
     * EVERY day in the strip, not only the ones with a booking.
     *
     * Building this from the covers map alone would silently drop any day with
     * no reservations -- so a quiet Tuesday would vanish from the row rather
     * than show a zero, and the week would look shorter than it is. The dates
     * are generated and the bookings looked up, never the other way round.
     *
     * TWO DAYS BACK AS WELL AS FORWARD, which is the change Khai asked for:
     * "if it's past current date you will look for the uncompleted
     * reservations, on the day you will take the snapshot at that point and
     * before is the completed." A strip that begins at today can only ever show
     * promises; last night's actual beside tonight's book is the comparison an
     * operator makes out loud.
     *
     * EXPECTED, NOT COMPLETED, for anything not yet over. A future booking
     * comes back from SevenRooms as status_simple 'Incomplete' and never
     * 'Complete', so a count keyed on completion reports ZERO for every
     * upcoming date -- which is what the live panel did. `serviceDays` picks
     * the right one of the two per day, and labels which it used.
     */
    const shut = new Set(closedWeekdays[i]);
    const service = serviceDays(
      Array.from({ length: SERVICE_BACK + 1 + SERVICE_FORWARD }, (_, d) => {
        const date = addDays(window.today, d - SERVICE_BACK);
        const c = coversService[i].get(date);
        return {
          date,
          closed: shut.has(weekdayOf(date)),
          completed: c?.covers ?? 0,
          expected: c?.expected_covers ?? 0,
          moments: date === window.today ? todayMoments[i].moments : undefined,
        };
      }),
      window.today,
      now,
    );
    const age = syncAge(todayMoments[i].synced_at, now);

    return {
      venue_id: v.id,
      venue: v.name,
      slug: v.slug,
      gross_sales: round2(cur.gross_sales),
      food_bev_sales: round2(cur.food_bev_sales),
      food_sales: round2(cur.food_sales),
      beverage_sales: round2(cur.beverage_sales),
      food_pct: cur.food_bev_sales > 0 ? round2(cur.food_sales / cur.food_bev_sales * 100) : null,
      net_sales: round2(cur.net_sales),
      service_charge: round2(cur.service_charge),
      total_discounts: round2(cur.total_discounts),
      discount_rate_pct: cur.gross_sales > 0 ? round2(cur.total_discounts / cur.gross_sales * 100) : null,
      covers,
      transactions: cur.transactions,
      avg_spend_per_head: sph,
      avg_check: cur.transactions > 0 ? round2(cur.net_sales / cur.transactions) : null,
      trading_days: cur.trading_days,
      closed_days: cur.closed_days,
      prior: { net_sales: round2(pri.net_sales), covers: priorCovers, avg_spend_per_head: priorSph },
      change: {
        net_sales: movement(round2(cur.net_sales), pri.trading_days > 0 ? round2(pri.net_sales) : null),
        covers: movement(covers, priorCovers),
        avg_spend_per_head: movement(sph, priorSph),
      },
      daily,
      service,
      /**
       * HOW OLD THE LIVE PANEL ACTUALLY IS. A snapshot is only as current as
       * the last ingest, and an hourly cron that died on Tuesday produces a
       * page indistinguishable from one that synced a minute ago.
       */
      synced_at: todayMoments[i].synced_at,
      synced_label: age.label,
      synced_stale: age.stale,
      /**
       * The sentence under the strip, composed here like every other figure on
       * this page. A page that writes its own prose is a page nobody can test.
       *
       * THE AGE IS LEFT OUT because `synced_label` already carries it, in the
       * panel heading where it is seen first and goes amber when it matters.
       * Said in both places it reads as two different facts. A text-only
       * surface — Telegram, a chat answer — has no heading to put it in and
       * passes the minutes, which is why serviceNote still takes them.
       */
      service_note: serviceNote(service.find(d => d.basis === 'snapshot'), null),
    };
  });

  /**
   * THE OPTIONAL PANELS, given a short grace once the core is in.
   *
   * A warm cache has them already. Cold, each gets PANEL_GRACE_MS more; one
   * still running after that is named in `pending` so the page can say "still
   * calculating" rather than its empty state -- "no retention figures yet"
   * would be a false statement about a figure that is ten seconds away -- and
   * the work carries on into the cache for the next load.
   */
  const pending: string[] = [];
  const panel = async <T>(name: string, c: { value: Promise<T> }): Promise<T | null> => {
    try {
      const r = await settleWithin(c.value, PANEL_GRACE_MS);
      if (r.timedOut) { pending.push(name); return null; }
      return r.value;
    } catch (e: any) {
      // Named, never swallowed: an unapplied migration otherwise looks exactly
      // like a venue with nothing to show.
      if (!/nothing to show/.test(String(e?.message))) console.warn(`[dashboard] ${name} unavailable: ${e?.message ?? e}`);
      return null;
    }
  };
  const [retentionInputs, costs, periodCosts, forecastInputs, { data: hols }] = await Promise.all([
    panel('retention', retentionC),
    panel('costs', costsC),
    panel('period_costs', periodCostsC),
    panel('forecast', forecastC),
    holidaysP,
  ]);
  const holidays = new Map<string, string>((hols ?? []).map((h: any) => [String(h.holiday_date), String(h.name)]));
  const forecast = forecastInputs ? assembleForecast(venues, out, day, forecastInputs, holidays) : null;
  const retention = retentionInputs ? assembleRetention(venues, month, retentionInputs) : null;

  timings.total = { ms: since() };
  /**
   * ONE LINE PER LOAD, in the Railway logs. "The dashboard is slower" was
   * answered from a local database because production had no measurement at
   * all; this is that measurement. Read it as: total, then where it went, then
   * how each cached panel was served.
   */
  console.log(
    `[dashboard] ${timings.total.ms}ms` +
    ` data_through=${timings.data_through?.ms}ms core=${timings.core?.ms}ms` +
    ['retention', 'costs', 'period_costs', 'forecast']
      .map(n => ` ${n}=${pending.includes(n) ? 'pending' : `${timings[n]?.cache ?? 'failed'}@${timings[n]?.ms ?? '?'}ms`}`)
      .join('') +
    ` venues=${venues.length}`,
  );
  /**
   * THE SIX-MONTH COST LINE IS OFF, and `buildCostTrend` is kept rather than
   * deleted. Khai, 4 Oct 2026: "Cost of sales chart section not necessary no
   * need the same treatment for now."
   *
   * Switched off HERE rather than only in the page, because it is the most
   * expensive thing on this request -- six months of P&L and six months of
   * product mix for every venue in scope -- and a payload field nobody draws is
   * latency an operator on mobile data pays for nothing. `cost-trend.ts`, its
   * tests and the builder all remain, so turning it back on is this one line.
   */
  const costTrendByVenue = null;
  return {
    window, retention, costs, period_costs: periodCosts, cost_trend: costTrendByVenue, forecast, pending,
    venues: out, group: out.length > 1 ? rollUp(out, now) : null,
  };
}



/**
 * The forecast's history, cacheable: the reconstructed books and served
 * covers, and the backtest run over them.
 *
 * THE HEAVIEST THING THIS PAGE READS, and it only changes when the SevenRooms
 * ingest does -- so it goes through the hourly cache in buildDashboard rather
 * than being recomputed per load. Throws on failure, so a failure is retried
 * next load rather than cached as nothing for an hour.
 *
 * Separate from the assembly below because the assembly needs the service
 * strip's book, which is live, and this does not. Caching the two together
 * would freeze tonight's bookings for an hour.
 */
interface ForecastInputs { data: PickupData; records: Map<string, BacktestRecord[]> }

const FORECAST_LEADS = Array.from({ length: SERVICE_FORWARD }, (_, i) => i + 1);

async function loadForecastInputs(ids: string[], today: string, clockHour: string): Promise<ForecastInputs> {
  const leads = FORECAST_LEADS;
  const longestLead = Math.max(...leads);
  const { data: raw, error } = await supabaseAdmin.rpc('cover_pickup', {
    p_venue_ids: ids,
    // Books: the backtest window, the twelve weeks each backtest night learns
    // from, and the lead -- nothing older is ever read.
    p_pickup_from: addDays(today, -(BACKTEST_DAYS + TRAINING_WEEKS * 7 + longestLead + 7)),
    // Served covers reach a year further, for last year's method and its level.
    p_final_from: addDays(today, -(BACKTEST_DAYS + 364 + TRAINING_WEEKS * 7 + longestLead + 14)),
    p_to: addDays(today, -1),
    p_leads: leads,
    // The cutoff is taken at this Singapore hour; see migration 051.
    p_clock: `${clockHour}:00`,
  });
  if (error) {
    throw new Error(
      `cover_pickup: ${error.message}` +
      (/cover_pickup/.test(error.message) ? ' -- has migration 051_cover_pickup.sql been applied?' : ''),
    );
  }
  const data = parsePickup(raw);
  return { data, records: new Map(ids.map(id => [id, backtest(data, id, today, leads)] as const)) };
}

/**
 * The forecast for the nights after today, from cached history and the LIVE
 * book. Synchronous and cheap: the expensive half is loadForecastInputs.
 */
function assembleForecast(
  venues: Array<{ id: string; name: string; slug: string }>,
  out: VenueWeek[],
  today: string,
  inputs: ForecastInputs,
  holidays: Map<string, string>,
): Record<string, CoverForecast> {
  const { data, records } = inputs;
  const leads = FORECAST_LEADS;
  const result: Record<string, CoverForecast> = {};
  const perVenue: CoverForecast[] = [];

  for (const [i, v] of venues.entries()) {
    /**
     * THE BOOK IS THE SERVICE STRIP'S, not a second read. The forecast must
     * start from exactly the "booked" number printed one panel up -- two reads
     * a few hundred milliseconds apart could disagree by a booking, and a
     * forecast built on 61 under a cell saying 62 is a discrepancy somebody
     * will spend ten minutes on.
     */
    const days = out[i].service
      .filter(d => d.basis === 'book')
      .map(d => ({ date: d.date, booked: d.covers, closed: d.closed }));
    const f = venueForecast(data, v.id, today, days, leads, holidays, records.get(v.id) ?? []);
    result[v.slug] = f;
    perVenue.push(f);
  }

  if (venues.length > 1) {
    const groupRecords = combineBacktests(venues.map(v => records.get(v.id) ?? []));
    // The group's own served series, for its seasonal lift.
    const summed = new Map<string, number>();
    for (const v of venues) {
      for (const [d, n] of data.served.get(v.id) ?? []) summed.set(d, (summed.get(d) ?? 0) + n);
    }
    result.group = groupForecast(perVenue, scoreBacktest(groupRecords, leads), seasonalLift(summed, today, SERVICE_FORWARD));
  }
  return result;
}

/**
 * Retention's raw inputs for a month: the RPC's rows for EVERY venue, and the
 * first booking date each venue holds.
 *
 * SHARED ACROSS EVERY READER, which is why it is split from the assembly
 * below. `guest_retention` computes all venues whatever the caller can see, so
 * caching it per person's scope ran the heaviest query on the page once for the
 * owner and once more for each manager -- and the production log of 5 Oct 2026
 * shows that query brushing the database's statement timeout. One run per
 * month per hour, filtered per reader afterwards, is the same answer for a
 * fraction of the load. Nothing here crosses a venue boundary: the assembly
 * hands each reader only their own venues' rows.
 *
 * Throws on failure, so a failure is retried rather than cached as nothing.
 */
interface RetentionInputs {
  rows: Array<RetentionCounts & { venue_id: string }>;
  /** venue id -> first booking date we hold. */
  firsts: Map<string, string | null>;
}

async function loadRetentionInputs(month: { start: string; end: string }): Promise<RetentionInputs> {
  /**
   * A LIFETIME LOOKBACK, not 365 days. Khai, 4 Oct 2026: "perhaps it should be
   * all time -- people who had been guest in our life time." Under the year
   * rule a guest who first came in 2023 and ate here last month counted as NEW
   * TO THE GROUP. The chart tools keep 365 and say so.
   */
  const [{ data, error }, { data: allVenues }] = await Promise.all([
    supabaseAdmin.rpc('guest_retention', {
      p_start: month.start, p_end: month.end, p_lookback: LIFETIME_LOOKBACK_DAYS,
    }),
    // row-cap: one row per venue.
    supabaseAdmin.from('venues').select('id'),
  ]);
  // Named, not swallowed: an unapplied migration otherwise looks exactly like a
  // month in which nobody ever came back.
  if (error) throw new Error(`guest_retention: ${error.message}`);

  /**
   * PER-VENUE HORIZONS. Each venue's records start when its own ingest did,
   * and the earliest row across the group would overstate the depth for a
   * venue that came later -- claiming history behind a figure that has none.
   */
  const ids = (allVenues ?? []).map((v: any) => String(v.id));
  const firstRows = await Promise.all(ids.map(id => supabaseAdmin.from('reservations').select('business_date')
    .eq('venue_id', id).order('business_date', { ascending: true }).limit(1)));
  const firsts = new Map(ids.map((id, i) => [id, (firstRows[i] as any)?.data?.[0]?.business_date ?? null] as const));

  return { rows: (data ?? []) as RetentionInputs['rows'], firsts };
}

/**
 * Retention for the last COMPLETE month, keyed by venue slug plus "group",
 * for THIS reader's venues only.
 *
 * Returns null when there is nothing to show; the caller degrades the panel
 * rather than the page, because the RPC has timed out in production before
 * (22 Sep 2026, and again on a background refresh on 5 Oct 2026).
 */
function assembleRetention(
  venues: Array<{ id: string; name: string; slug: string }>,
  month: { start: string; end: string; label: string },
  inputs: RetentionInputs,
): Record<string, RetentionBlock> | null {
  const { rows, firsts } = inputs;
  if (rows.length === 0) return null;

  const out: Record<string, RetentionBlock> = {};
  const mine: RetentionCounts[] = [];
  const horizons: HistoryHorizon[] = [];

  for (const v of venues) {
    const r = rows.find(x => x.venue_id === v.id);
    const counts: RetentionCounts = r
      ? {
          booked_guests: Number(r.booked_guests), returning_here: Number(r.returning_here),
          crossed_from_sister: Number(r.crossed_from_sister), new_to_group: Number(r.new_to_group),
          walk_in_guests: Number(r.walk_in_guests),
        }
      : { booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0, walk_in_guests: 0 };
    mine.push(counts);
    const shares = retentionShares(counts);

    const horizon = historyHorizon(month.start, firsts.get(v.id) ?? null);
    horizons.push(horizon);

    out[v.slug] = {
      month, counts, shares,
      plain: inPlainWords(counts, shares, month.label, horizon.from),
      /**
       * WITHHELD ONLY WHEN "LIFETIME" IS A YEAR OR LESS. Below that the phrase
       * promises more than the records hold and the figure carries the same
       * shrinking shortfall the 365-day rule was withheld for; above it, the
       * horizon is stated and the figure stands.
       */
      withheld: horizon.too_thin,
      horizon,
    };
  }

  if (venues.length > 1) {
    /**
     * SUMMED, then the rate recomputed -- never an average of the venue rates,
     * which would weight a quiet venue the same as a busy one.
     *
     * Not the same as the group retention the FUNCTION reports: a guest who ate
     * at two venues in the month is one guest at each and the venue rows
     * deliberately do not sum to a group row. This is the group's venues added
     * up, the right figure for "how did the group do" and the wrong one for
     * "how many distinct people", so the page says "across the venues".
     */
    const counts = sumCounts(mine);
    const shares = retentionShares(counts);
    /**
     * THE SHALLOWEST VENUE BOUNDS THE GROUP: a group line is only as sound as
     * its weakest part, and the deepest venue vouching for the rest is how a
     * figure looks better than any of the things it is made of.
     */
    const groupHorizon = horizons.reduce<HistoryHorizon>(
      (worst, h) => (h.days < worst.days ? h : worst),
      horizons[0] ?? { from: null, days: 0, too_thin: true },
    );
    out.group = {
      month, counts, shares,
      plain: inPlainWords(counts, shares, month.label, groupHorizon.from),
      withheld: groupHorizon.too_thin,
      horizon: groupHorizon,
    };
  }

  return out;
}


/**
 * Food and beverage cost for the last complete month, keyed by venue slug.
 *
 * SAME MONTH AS RETENTION, deliberately. Two monthly panels under one period
 * heading means the reader changes context once; two panels on different months
 * beside a week-to-date table is three periods on one screen and nobody holds
 * that.
 *
 * SALES ARE SUMMED OVER THE LEDGER'S MONTH, not the dashboard's week. That is
 * the whole alignment risk and it is the same one query_food_beverage_cost
 * handles: cost for September over sales for a week in October is not a
 * percentage of anything.
 *
 * A failure costs the panel, never the page.
 */
async function buildCosts(
  venues: Array<{ id: string; name: string; slug: string }>,
  today: string,
): Promise<Record<string, CostBlock> | null> {
  const month = lastCompleteMonth(today);

  try {
    const out: Record<string, CostBlock> = {};
    let anyAvailable = false;

    const perVenue = await Promise.all(venues.map(async v => {
      const [{ data: pl }, { data: ops }, accountMap] = await Promise.all([
        selectAll(() => supabaseAdmin.from('profit_and_loss')
          .select('section, account_name, amount, is_summary')
          .eq('venue_id', v.id)
          .gte('period_start', month.start)
          .lte('period_end', month.end)),
        selectAll(() => supabaseAdmin.from('daily_operations')
          .select('business_date, gross_sales, sales_by_class, meal_periods')
          .eq('venue_id', v.id)
          .gte('business_date', month.start)
          .lte('business_date', month.end)),
        fetchAccountMap(v.id),
      ]);

      const rows: PLRow[] = (pl ?? []).map((r: any) => {
        const { canonical_account, business_line } = resolveAccount(r.account_name, accountMap);
        return { ...r, amount: Number(r.amount), canonical_account, business_line };
      });

      return { slug: v.slug, rows, sales: sumClassSplits(ops ?? []) };
    }));

    for (const v of perVenue) {
      const available = v.rows.length > 0;
      if (available) anyAvailable = true;
      const ratios = costRatios(v.rows, v.sales);
      out[v.slug] = { month, ratios, caveats: costCaveats(ratios, 1), available };
    }

    if (venues.length > 1) {
      /**
       * The group ratio is recomputed from the summed parts, never averaged
       * across venues -- a 40% venue and a 25% venue are not a group at 32.5%
       * unless they are the same size, and they never are.
       */
      const allRows = perVenue.flatMap(v => v.rows);
      const allSales = perVenue.reduce(
        (t, v) => ({
          food_sales: t.food_sales + v.sales.food_sales,
          beverage_sales: t.beverage_sales + v.sales.beverage_sales,
          days: {
            monday_board: t.days.monday_board + v.sales.days.monday_board,
            none: t.days.none + v.sales.days.none,
          },
        }),
        { food_sales: 0, beverage_sales: 0, days: { monday_board: 0, none: 0 } });
      const ratios = costRatios(allRows, allSales);
      out.group = { month, ratios, caveats: costCaveats(ratios, 1), available: allRows.length > 0 };
    }

    return anyAvailable ? out : null;
  } catch (e: any) {
    console.warn(`[dashboard] cost of sales failed: ${e?.message ?? e}`);
    return null;
  }
}


/**
 * Food and beverage cost for the SELECTED window, from supplier bills.
 *
 * WHY THIS EXISTS BESIDE THE LEDGER ONE. The P&L closes monthly, so a food cost
 * from it is six weeks behind by the time anybody could act on it. Bills carry
 * a date and arrive daily, so they give the same measurement at whatever grain
 * is on screen -- at the cost of being purchasing rather than consumption, and
 * of only covering what actually came through a bill.
 *
 * COVERAGE IS MEASURED ON THE LAST COMPLETE MONTH, never on the window being
 * reported. A part-month has bills not yet entered and a ledger not yet closed;
 * measuring coverage there compares two different kinds of incomplete.
 */
async function buildPeriodCosts(
  venues: Array<{ id: string; name: string; slug: string }>,
  start: string,
  end: string,
  today: string,
): Promise<Record<string, WeeklyCogs> | null> {
  const month = lastCompleteMonth(today);

  try {
    let any = false;
    const out: Record<string, WeeklyCogs> = {};

    await Promise.all(venues.map(async v => {
      const [{ data: pl }, windowLines, monthLines, { data: ops }, accountMap] = await Promise.all([
        // The P&L is read for TWO things: the account_id -> name map, and the
        // ledger totals coverage is measured against.
        selectAll(() => supabaseAdmin.from('profit_and_loss')
          .select('account_id, account_name, section, amount, is_summary')
          .eq('venue_id', v.id)
          .gte('period_start', month.start)
          .lte('period_end', month.end)),
        // PAGED. A month of bill lines is over 1,000 at every venue, and a single
        // read stops there without saying so -- see src/lib/paged.ts.
        readAllPages<any>((from, to) => supabaseAdmin.from('supplier_bill_lines')
          .select('id, account_id, line_amount, supplier_bills!inner(bill_date, status)')
          .eq('venue_id', v.id)
          .gte('supplier_bills.bill_date', start)
          .lte('supplier_bills.bill_date', end)
          .order('id')
          .range(from, to)),
        readAllPages<any>((from, to) => supabaseAdmin.from('supplier_bill_lines')
          .select('id, account_id, line_amount, supplier_bills!inner(bill_date, status)')
          .eq('venue_id', v.id)
          .gte('supplier_bills.bill_date', month.start)
          .lte('supplier_bills.bill_date', month.end)
          .order('id')
          .range(from, to)),
        selectAll(() => supabaseAdmin.from('daily_operations')
          .select('business_date, gross_sales, sales_by_class, meal_periods')
          .eq('venue_id', v.id)
          .gte('business_date', start)
          .lte('business_date', end)),
        fetchAccountMap(v.id),
      ]);

      if (!windowLines || windowLines.length === 0) return;
      any = true;

      /**
       * account_id -> canonical name. The join that makes this possible at all:
       * profit_and_loss.account_id holds the same Xero UUID as a bill line, so a
       * bill reaches its P&L account without a chart-of-accounts lookup.
       */
      const names: AccountNames = new Map();
      const ledger = { food: 0, beverage: 0 };
      for (const r of pl ?? []) {
        if (!r.account_id) continue;
        const { canonical_account: canonical, business_line } = resolveAccount(r.account_name, accountMap);
        const info = { name: canonical, raw: r.account_name, section: r.section, business_line };
        names.set(r.account_id, info);
        if (r.is_summary) continue;
        const kind = costBucket({ canonical, raw: r.account_name, section: r.section, business_line });
        if (kind === 'food') ledger.food += Number(r.amount);
        else if (kind === 'beverage') ledger.beverage += Number(r.amount);
      }

      const toLines = (rows: any[]): BillLine[] =>
        rows.map(r => ({
          account_id: r.account_id,
          line_amount: Number(r.line_amount),
          bill_date: '',
          status: r.supplier_bills?.status ?? null,
        }));

      const sales = sumClassSplits(ops ?? []);
      out[v.slug] = weeklyCogs(
        toLines(windowLines),
        names,
        sales,
        coverageFor(toLines(monthLines), names, ledger),
      );
    }));

    return any ? out : null;
  } catch (e: any) {
    console.warn(`[dashboard] period costs failed: ${e?.message ?? e}`);
    return null;
  }
}


/**
 * Six months of food and beverage cost percentage, per venue.
 *
 * ONE PAIR OF QUERIES FOR THE WHOLE SPAN, not one per month. Six months times
 * three venues is thirty-six round trips done the obvious way, on the page
 * people open first; the rows come back once and are grouped in memory.
 *
 * A failure costs the panel, never the page.
 */
async function buildCostTrend(
  venues: Array<{ id: string; name: string; slug: string }>,
  today: string,
): Promise<Record<string, { points: CostPoint[]; note: string }> | null> {
  const months = trailingMonths(today, 6);
  const spanStart = months[0];
  // The last day of the final month, so the sales read covers all of it.
  const lastMonth = new Date(`${months[months.length - 1]}T00:00:00Z`);
  const spanEnd = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0))
    .toISOString().slice(0, 10);

  try {
    let any = false;
    const out: Record<string, { points: CostPoint[]; note: string }> = {};

    const perVenueInputs = new Map<string, MonthInput[]>();

    await Promise.all(venues.map(async v => {
      const [{ data: pl }, { data: ops }, accountMap] = await Promise.all([
        selectAll(() => supabaseAdmin.from('profit_and_loss')
          .select('period_start, section, account_name, amount, is_summary')
          .eq('venue_id', v.id)
          .gte('period_start', spanStart)
          .lte('period_start', spanEnd)),
        selectAll(() => supabaseAdmin.from('daily_operations')
          .select('business_date, gross_sales, sales_by_class, meal_periods')
          .eq('venue_id', v.id)
          .gte('business_date', spanStart)
          .lte('business_date', spanEnd)),
        fetchAccountMap(v.id),
      ]);

      const inputs: MonthInput[] = months.map(start => {
        const key = start.slice(0, 7);
        const rows: PLRow[] = (pl ?? [])
          .filter((r: any) => String(r.period_start).slice(0, 7) === key)
          .map((r: any) => {
            const { canonical_account, business_line } = resolveAccount(r.account_name, accountMap);
            return { ...r, amount: Number(r.amount), canonical_account, business_line };
          });

        let food = 0, bev = 0;
        for (const o of ops ?? []) {
          if (String(o.business_date).slice(0, 7) !== key) continue;
          const split = classSplitOf(o as any);
          food += split.food_sales;
          bev += split.beverage_sales;
        }
        return { start, rows, sales: { food_sales: food, beverage_sales: bev } };
      });

      perVenueInputs.set(v.slug, inputs);
      const points = costTrend(inputs);
      if (points.some(p => p.available)) any = true;
      out[v.slug] = { points, note: trendNote(points) };
    }));

    if (venues.length > 1) {
      /**
       * The group line is NOT an average of the venue lines, and it is not one
       * venue's line either. A 40% venue and a 25% venue are not a group at
       * 32.5% unless they are the same size, and they never are.
       *
       * So the group's MONTHS are rebuilt from the summed cost rows and the
       * summed sales and run through the same `costTrend` as every venue --
       * which also means the group's gaps are computed the same way: a month is
       * unavailable only when NO venue closed a P&L for it, not when one did
       * not.
       */
      const groupInputs: MonthInput[] = months.map((start, i) => {
        const rows: PLRow[] = [];
        const sales = { food_sales: 0, beverage_sales: 0 };
        for (const v of venues) {
          const m = perVenueInputs.get(v.slug)?.[i];
          if (!m) continue;
          rows.push(...m.rows);
          sales.food_sales += m.sales.food_sales;
          sales.beverage_sales += m.sales.beverage_sales;
        }
        return { start, rows, sales };
      });
      const groupPoints = costTrend(groupInputs);
      out.group = { points: groupPoints, note: trendNote(groupPoints) };
    }


    return any ? out : null;
  } catch (e: any) {
    console.warn(`[dashboard] cost trend failed: ${e?.message ?? e}`);
    return null;
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
