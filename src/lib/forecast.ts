/**
 * Forecast covers for the coming nights, and say how good the forecast is.
 *
 * Khai, 4 Oct 2026: "forecasted reservations ... based on daily seasonality
 * from previous year, does that make sense?" Then: "Build it but explain it."
 *
 * TWO METHODS, AND THE DATA DECIDES BETWEEN THEM RATHER THAN US.
 *
 *   PICKUP -- the headline. What is booked now, plus what usually arrives
 *   between now and service on that weekday at that venue: walk-ins and late
 *   bookings, less late cancellations and no-shows. "Usually" is the last
 *   twelve weeks of the same weekday, measured at the same number of days out
 *   and the same time of day. It uses the strongest signal there is, tonight's
 *   actual book, and corrects it with a pattern measured over a dozen nights.
 *
 *   LAST YEAR -- Khai's proposal, built fairly. The same weekday last year (364
 *   days back, which keeps the weekday; 365 would compare a Saturday with a
 *   Sunday), averaged with the weeks either side so it is three nights rather
 *   than one, then scaled by how this year is running against last.
 *
 * Both are BACKTESTED on the last 26 weeks: for every past night, what each
 * method would have said one to five days before, using only what was known
 * then, against what was actually served. That answers the question Khai asked
 * with his own numbers instead of with an opinion -- and it is the only thing
 * that makes a forecast trustworthy. A forecast nobody scores is
 * indistinguishable from a guess.
 *
 * WHY PICKUP IS ADDITIVE, NOT A RATIO. "Saturdays end at 2.1x their 4-day
 * book" sounds natural, and blows up whenever the book is small: three covers
 * booked a week out times a ratio of thirty is ninety covers of nonsense. "Add
 * the 70 covers that usually arrive" is stable at every size of book, and one
 * number nets out everything that happens between now and service.
 *
 * A RANGE, NOT A NUMBER. The middle 60% of what those twelve weeks did. The
 * backtest reports how often the actual night landed inside it, which is the
 * check on whether the range means what it says.
 *
 * WHAT THIS IS NOT. It knows nothing about a guest chef, a buyout, a road
 * closure or the weather. Public holidays are flagged, not modelled: twelve
 * ordinary Thursdays say little about a Thursday that is Deepavali.
 */

export const TRAINING_WEEKS = 12;
/** Below this many comparable nights there is no forecast, only the book. */
export const MIN_OBSERVATIONS = 6;
export const BACKTEST_DAYS = 182;
/** The range is the 20th to the 80th percentile: the middle 60%. */
export const RANGE_LOW = 0.2;
export const RANGE_HIGH = 0.8;
/** A level needs this many trading days behind it to be a level. */
const MIN_LEVEL_DAYS = 30;

const DAY_MS = 86_400_000;

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Linear-interpolated quantile of an ASCENDING array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) throw new Error('quantile of nothing');
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The cover_pickup RPC's output, indexed.
 *
 * A night that served NOBODY is dropped from `served` rather than kept as a
 * zero. It is a closure or a missing feed, and neither is a night the venue
 * traded quietly -- learning from it would teach the forecast that a quarter of
 * Sundays are empty because Firangi is shut on them.
 */
export interface PickupData {
  /** venue -> date -> covers served. Trading nights only. */
  served: Map<string, Map<string, number>>;
  /** venue -> date -> days out -> covers on the book at the cutoff. */
  booked: Map<string, Map<string, Map<number, number>>>;
}

export function parsePickup(raw: unknown): PickupData {
  const served = new Map<string, Map<string, number>>();
  const booked = new Map<string, Map<string, Map<number, number>>>();
  const r = (raw ?? {}) as { finals?: unknown[]; books?: unknown[] };

  for (const row of Array.isArray(r.finals) ? r.finals : []) {
    const [v, d, n] = row as [string, string, number];
    if (!(Number(n) > 0)) continue;
    if (!served.has(v)) served.set(v, new Map());
    served.get(v)!.set(String(d), Number(n));
  }
  for (const row of Array.isArray(r.books) ? r.books : []) {
    const [v, d, lead, n] = row as [string, string, number, number];
    if (!booked.has(v)) booked.set(v, new Map());
    const byDate = booked.get(v)!;
    if (!byDate.has(String(d))) byDate.set(String(d), new Map());
    byDate.get(String(d))!.set(Number(lead), Number(n));
  }
  return { served, booked };
}

/**
 * The history, indexed once per venue so every lookup is a binary search.
 *
 * WHY THIS EXISTS: SPEED, MEASURED. The backtest asks for ~2,700 forecasts per
 * load of fresh history, and each one scanned every night on record to find
 * twelve -- about 250 ms of CPU on production-sized data, during which the Node
 * server could answer nobody else. Grouped by weekday and days out and sorted
 * by date, "the last twelve Tuesdays before the 3rd" is two binary searches;
 * a level over twelve weeks is two more and a subtraction of prefix sums.
 *
 * Built lazily and held against the PickupData object itself, so it lives
 * exactly as long as the data it indexes and can never describe another set.
 */
interface VenueIndex {
  /** `${weekday}|${lead}` -> nights in date order, trading nights only. */
  byKey: Map<string, { dates: string[]; pickup: number[]; served: number[] }>;
  servedDates: string[];
  /** prefix[i] = sum of the first i nights' covers. */
  servedPrefix: number[];
}

const indexes = new WeakMap<PickupData, Map<string, VenueIndex | null>>();

/** First position at which `x` could be inserted keeping `arr` sorted. */
function lowerBound(arr: string[], x: string): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function indexFor(data: PickupData, venueId: string): VenueIndex | null {
  let perData = indexes.get(data);
  if (!perData) { perData = new Map(); indexes.set(data, perData); }
  if (perData.has(venueId)) return perData.get(venueId)!;

  const served = data.served.get(venueId);
  const booked = data.booked.get(venueId);
  let built: VenueIndex | null = null;
  if (served) {
    // Bookings are optional here: last year's method needs only served covers.
    const byKey = new Map<string, { dates: string[]; pickup: number[]; served: number[] }>();
    for (const date of booked ? [...booked.keys()].sort() : []) {
      const s = served.get(date);
      if (s === undefined) continue;                 // closed or missing: not a night to learn from
      const wd = weekday(date);
      for (const [lead, b] of booked!.get(date)!) {
        const k = `${wd}|${lead}`;
        if (!byKey.has(k)) byKey.set(k, { dates: [], pickup: [], served: [] });
        const e = byKey.get(k)!;
        e.dates.push(date); e.pickup.push(s - b); e.served.push(s);
      }
    }
    const servedDates = [...served.keys()].sort();
    const servedPrefix = [0];
    for (const d of servedDates) servedPrefix.push(servedPrefix[servedPrefix.length - 1] + served.get(d)!);
    built = { byKey, servedDates, servedPrefix };
  }
  perData.set(venueId, built);
  return built;
}

export interface PickupForecast {
  mid: number;
  lo: number;
  hi: number;
  /** Comparable nights the pickup was measured on. */
  n: number;
  /** The most covers any of those nights served, for spotting a book beyond them. */
  max_served: number;
}

/**
 * Booked now, plus what the same weekday usually picked up from this point.
 *
 * `asOf` is the day the forecast is made. Training uses only nights BEFORE it,
 * so a backtest cannot see the answer: a night is learned from only once it
 * has been served.
 */
export function pickupForecast(
  data: PickupData, venueId: string, target: string, lead: number, bookedNow: number, asOf: string,
): PickupForecast | null {
  const idx = indexFor(data, venueId);
  const nights = idx?.byKey.get(`${weekday(target)}|${lead}`);
  if (!nights) return null;

  // Same weekday, same days out, in [asOf - 12 weeks, asOf): nights served
  // BEFORE the forecast was made, so a backtest cannot see its own answer.
  const lo = lowerBound(nights.dates, addDays(asOf, -TRAINING_WEEKS * 7));
  const hi = lowerBound(nights.dates, asOf);
  if (hi - lo < MIN_OBSERVATIONS) return null;

  const pickups = nights.pickup.slice(lo, hi).sort((a, b) => a - b);
  const maxServed = Math.max(...nights.served.slice(lo, hi));

  // Never below zero: a forecast of minus four covers is arithmetic, not trade.
  const at = (q: number) => Math.max(0, Math.round(bookedNow + quantile(pickups, q)));
  return { mid: at(0.5), lo: at(RANGE_LOW), hi: at(RANGE_HIGH), n: pickups.length, max_served: maxServed };
}

/** Mean covers per trading night over [from, to). Null when too thin to be a level. */
function level(idx: VenueIndex, from: string, to: string): number | null {
  const lo = lowerBound(idx.servedDates, from);
  const hi = lowerBound(idx.servedDates, to);
  const n = hi - lo;
  return n >= MIN_LEVEL_DAYS ? (idx.servedPrefix[hi] - idx.servedPrefix[lo]) / n : null;
}

/**
 * Khai's method: the same weekday last year, scaled to this year's level.
 *
 * BUILT TO BE FAIR TO THE IDEA. One night last year is one observation and
 * moves ±25% on nothing, so this averages the same weekday across three weeks
 * centred on it. 364 days back rather than 365 so the weekday holds.
 *
 * It ignores the current book entirely, by construction -- which is precisely
 * what the backtest is there to price.
 */
export function lastYearForecast(
  data: PickupData, venueId: string, target: string, asOf: string,
): number | null {
  const served = data.served.get(venueId);
  const idx = indexFor(data, venueId);
  if (!served || !idx) return null;

  const ly = addDays(target, -364);
  const nights = [addDays(ly, -7), ly, addDays(ly, 7)]
    .map(d => served.get(d))
    .filter((v): v is number => v !== undefined);
  if (nights.length < 2) return null;

  const recent = level(idx, addDays(asOf, -TRAINING_WEEKS * 7), asOf);
  const before = level(idx, addDays(asOf, -364 - TRAINING_WEEKS * 7), addDays(asOf, -364));
  if (recent === null || before === null || before === 0) return null;

  const mean = nights.reduce((a, b) => a + b, 0) / nights.length;
  return Math.max(0, Math.round(mean * (recent / before)));
}

export interface BacktestRecord {
  target: string;
  lead: number;
  actual: number;
  booked: number;
  pickup: PickupForecast | null;
  last_year: number | null;
}

/**
 * What each method WOULD have said, for every night of the last 26 weeks.
 *
 * NO LOOKING AHEAD. For a night forecast three days out, the forecast is made
 * as of three days before it, and learns only from nights served before that.
 * Training on the night being predicted is the classic way a backtest flatters
 * itself, and it would have done so here without any line looking wrong.
 */
export function backtest(
  data: PickupData, venueId: string, today: string, leads: number[], days = BACKTEST_DAYS,
): BacktestRecord[] {
  const served = data.served.get(venueId);
  const booked = data.booked.get(venueId);
  if (!served || !booked) return [];

  const out: BacktestRecord[] = [];
  for (let i = days; i >= 1; i--) {
    const target = addDays(today, -i);
    const actual = served.get(target);
    if (actual === undefined) continue;          // closed or missing: nothing to score
    for (const lead of leads) {
      const b = booked.get(target)?.get(lead);
      if (b === undefined) continue;
      const asOf = addDays(target, -lead);
      out.push({
        target, lead, actual, booked: b,
        pickup: pickupForecast(data, venueId, target, lead, b, asOf),
        last_year: lastYearForecast(data, venueId, target, asOf),
      });
    }
  }
  return out;
}

export interface MethodScore {
  /** Average miss, in covers. */
  mae: number;
  /** Total miss as a share of total covers -- a percentage that a quiet night cannot blow up. */
  wape_pct: number;
  /** Average signed miss. Positive means it tends to forecast too HIGH. */
  bias: number;
}

export interface Accuracy {
  lead: number;
  /** Nights scored -- the SAME nights for both methods. */
  n: number;
  pickup: MethodScore & { in_range_pct: number };
  last_year: MethodScore | null;
}

function score(pairs: Array<[number, number]>): MethodScore {
  let abs = 0, signed = 0, actual = 0;
  for (const [pred, act] of pairs) { abs += Math.abs(pred - act); signed += pred - act; actual += act; }
  return {
    mae: round1(abs / pairs.length),
    wape_pct: actual > 0 ? round1(abs / actual * 100) : 0,
    bias: round1(signed / pairs.length),
  };
}

/**
 * Accuracy by days out.
 *
 * BOTH METHODS ARE SCORED ON THE SAME NIGHTS. Scoring each wherever it
 * happened to produce a number would let one be marked on easier nights than
 * the other -- last year's method has no forecast for a night whose equivalent
 * last year was closed -- and the comparison would be decided by the sample,
 * not the method. One set of nights, so `n` is one number and means one thing.
 */
export function scoreBacktest(records: BacktestRecord[], leads: number[]): Accuracy[] {
  const out: Accuracy[] = [];
  for (const lead of leads) {
    const rows = records.filter(r => r.lead === lead && r.pickup !== null);
    if (rows.length === 0) continue;

    const both = rows.filter(r => r.last_year !== null);
    // Prefer the like-for-like set. Fall back to pickup alone only when last
    // year has nothing at all -- a venue with under a year of history -- and
    // say so by returning last_year: null.
    const scored = both.length >= MIN_OBSERVATIONS ? both : rows;

    const inRange = scored.filter(r => r.actual >= r.pickup!.lo && r.actual <= r.pickup!.hi).length;
    out.push({
      lead,
      n: scored.length,
      pickup: { ...score(scored.map(r => [r.pickup!.mid, r.actual])), in_range_pct: round1(inRange / scored.length * 100) },
      last_year: both.length >= MIN_OBSERVATIONS ? score(both.map(r => [r.last_year!, r.actual])) : null,
    });
  }
  return out;
}

/**
 * Several venues' backtests as one group backtest.
 *
 * A venue with no record for a night was CLOSED or had no data, and
 * contributes zero to both sides. A venue whose record exists but which could
 * not forecast makes the whole group night unscorable -- adding two venues'
 * forecasts to three venues' actuals would score the group on a miss it never
 * made.
 */
export function combineBacktests(perVenue: BacktestRecord[][]): BacktestRecord[] {
  const byKey = new Map<string, BacktestRecord[]>();
  for (const recs of perVenue) for (const r of recs) {
    const k = `${r.target}|${r.lead}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  const out: BacktestRecord[] = [];
  for (const recs of byKey.values()) {
    const pickupOk = recs.every(r => r.pickup !== null);
    const lyOk = recs.every(r => r.last_year !== null);
    const sum = (f: (r: BacktestRecord) => number) => recs.reduce((n, r) => n + f(r), 0);
    out.push({
      target: recs[0].target,
      lead: recs[0].lead,
      actual: sum(r => r.actual),
      booked: sum(r => r.booked),
      pickup: pickupOk ? {
        mid: sum(r => r.pickup!.mid), lo: sum(r => r.pickup!.lo), hi: sum(r => r.pickup!.hi),
        n: Math.min(...recs.map(r => r.pickup!.n)), max_served: sum(r => r.pickup!.max_served),
      } : null,
      last_year: lyOk ? sum(r => r.last_year!) : null,
    });
  }
  return out.sort((a, b) => a.target.localeCompare(b.target) || a.lead - b.lead);
}

/**
 * How much busier last year's equivalent of the coming days was than the
 * twelve weeks before it -- the one thing the pickup method cannot see.
 *
 * NOT APPLIED TO THE FORECAST. It is reported beside it. The pickup learns from
 * the last twelve weeks, so a seasonal turn it has not lived through yet is
 * invisible to it, and this says whether last year had one here. Whether
 * applying it would HELP is a question for the backtest to answer, not for a
 * multiplier to assume.
 */
export function seasonalLift(series: Map<string, number>, today: string, horizonDays: number): number | null {
  /**
   * EACH NIGHT AGAINST ITS OWN WEEKDAY, never the window against an average.
   *
   * Caught on the first render: five coming nights that happen to be Monday to
   * Thursday, compared with a baseline that includes Fridays and Saturdays,
   * came out "22% quieter" on a synthetic venue built to be BUSIER -- the
   * measure was reading the weekday mix of the window, not the season. On real
   * data it would announce a quiet spell every time the next five days missed
   * a weekend. So each of last year's nights is divided by the average of the
   * same weekday in the twelve weeks before, and those ratios are averaged.
   */
  const baseFrom = addDays(today, -364 - TRAINING_WEEKS * 7);
  const baseTo = addDays(today, -364);
  const byWeekday = new Map<number, number[]>();
  for (const [date, v] of series) {
    if (date < baseFrom || date >= baseTo) continue;
    const wd = weekday(date);
    if (!byWeekday.has(wd)) byWeekday.set(wd, []);
    byWeekday.get(wd)!.push(v);
  }

  /**
   * THREE WEEKS OF LAST YEAR, NOT ONE. The same correction as lastYearForecast
   * and for the same reason: five nights at ordinary ±20% variation estimate a
   * 12% seasonal lift as anything from 0 to 20 -- measured on the first
   * synthetic run, which read 5% against a true 12. Three weeks triples the
   * nights and cuts the wobble by about 40%.
   *
   * FORWARD WEEKS ONLY: the equivalent nights and the two weeks after them.
   * The week BEFORE sits inside the baseline it would be compared against, so
   * including it pulls every lift toward zero -- the measure would partly be
   * comparing the baseline with itself.
   */
  const ratios: number[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    for (const offset of [0, 7, 14]) {
      const date = addDays(today, i - 364 + offset);
      const v = series.get(date);
      const base = byWeekday.get(weekday(date));
      // Four of the same weekday is the least that makes an average of one.
      if (v === undefined || !base || base.length < 4) continue;
      const mean = base.reduce((a, b) => a + b, 0) / base.length;
      if (mean > 0) ratios.push(v / mean);
    }
  }
  if (ratios.length < 4) return null;
  return round1((ratios.reduce((a, b) => a + b, 0) / ratios.length - 1) * 100);
}

export interface ForecastDay {
  date: string;
  lead: number;
  booked: number;
  closed: boolean;
  /** Null when there are too few comparable nights to say anything. */
  mid: number | null;
  lo: number | null;
  hi: number | null;
  n: number;
  /** Khai's method, for comparison. */
  last_year: number | null;
  /**
   * More already booked than any of the comparable nights SERVED. Usually a
   * buyout or an event, where the walk-ins the pickup adds will not come.
   */
  beyond_history: boolean;
  holiday: string | null;
}

export interface CoverForecast {
  days: ForecastDay[];
  accuracy: Accuracy[];
  /** Percent; positive means last year's equivalent days ran busier than usual. */
  seasonal_lift_pct: number | null;
  note: string;
}

export interface ForecastDayInput { date: string; booked: number; closed: boolean }

export function venueForecast(
  data: PickupData, venueId: string, today: string, days: ForecastDayInput[],
  leads: number[], holidays: Map<string, string>,
  /** Supplied when the caller already ran it -- the group needs the records too. */
  records: BacktestRecord[] = backtest(data, venueId, today, leads),
): CoverForecast {
  const out: ForecastDay[] = days.map(d => {
    const lead = daysBetween(today, d.date);
    const base = { date: d.date, lead, booked: d.booked, closed: d.closed, holiday: holidays.get(d.date) ?? null };
    if (d.closed || lead < 1) {
      return { ...base, mid: null, lo: null, hi: null, n: 0, last_year: null, beyond_history: false };
    }
    const p = pickupForecast(data, venueId, d.date, lead, d.booked, today);
    return {
      ...base,
      mid: p?.mid ?? null, lo: p?.lo ?? null, hi: p?.hi ?? null, n: p?.n ?? 0,
      last_year: lastYearForecast(data, venueId, d.date, today),
      beyond_history: p !== null && d.booked > p.max_served,
    };
  });

  const accuracy = scoreBacktest(records, leads);
  const lift = seasonalLift(data.served.get(venueId) ?? new Map(), today, days.length);
  return { days: out, accuracy, seasonal_lift_pct: lift, note: forecastNote(out, accuracy, lift) };
}

/**
 * The group line: sums of the venues, with the range said to be wider than it
 * truly is.
 *
 * ADDING PERCENTILES IS NOT A PERCENTILE. The 20th percentile of three venues
 * added together is higher than the three 20th percentiles added, because the
 * venues do not all have a bad night at once -- so the summed range is too
 * wide. Wider is the safe direction for a range, and the note says it.
 */
export function groupForecast(
  perVenue: CoverForecast[], groupAccuracy: Accuracy[], groupLift: number | null,
): CoverForecast {
  const dates = perVenue[0]?.days.map(d => d.date) ?? [];
  const days: ForecastDay[] = dates.map((date, i) => {
    const parts = perVenue.map(f => f.days[i]).filter(Boolean);
    const open = parts.filter(p => !p.closed);
    const all = <K extends 'mid' | 'lo' | 'hi' | 'last_year'>(k: K) =>
      open.length > 0 && open.every(p => p[k] !== null) ? open.reduce((n, p) => n + (p[k] as number), 0) : null;
    return {
      date,
      lead: parts[0].lead,
      booked: parts.reduce((n, p) => n + p.booked, 0),
      closed: open.length === 0,
      mid: all('mid'), lo: all('lo'), hi: all('hi'),
      n: open.length ? Math.min(...open.map(p => p.n)) : 0,
      last_year: all('last_year'),
      beyond_history: open.some(p => p.beyond_history),
      holiday: parts.find(p => p.holiday)?.holiday ?? null,
    };
  });
  const note = forecastNote(days, groupAccuracy, groupLift) +
    ' The group range is the venue ranges added together, which is wider than the true group range — venues rarely all have a bad night at once.';
  return { days, accuracy: groupAccuracy, seasonal_lift_pct: groupLift, note };
}

/**
 * What the forecast is, how it did, and what it cannot see -- in words,
 * composed here so the page does not write its own.
 */
export function forecastNote(days: ForecastDay[], accuracy: Accuracy[], lift: number | null): string {
  const parts: string[] = [
    `Each forecast is what is booked now plus what usually arrives between now and service on that weekday here — ` +
    `walk-ins and late bookings, less cancellations and no-shows — measured over the last ${TRAINING_WEEKS} weeks. ` +
    `The range is where the middle 60% of those weeks landed.`,
  ];

  /**
   * ONE HEADLINE ACCURACY, the middle of the horizon, because a sentence of
   * five is unreadable. The table on the panel has the rest.
   */
  const mid = accuracy[Math.floor((accuracy.length - 1) / 2)];
  if (mid) {
    // Whole covers and whole percents in a sentence. "Missed by 9.7 covers" is
    // precision the method does not have; the table carries the same rounding.
    const r = Math.round;
    let s = `Tested on the last ${r(BACKTEST_DAYS / 7)} weeks: ${mid.lead} day${mid.lead === 1 ? '' : 's'} out it missed by ` +
            `${r(mid.pickup.mae)} covers on an average night (${r(mid.pickup.wape_pct)}%), and the actual landed inside the range ` +
            `${r(mid.pickup.in_range_pct)}% of the time.`;
    if (mid.last_year) {
      s += ` Last year's pattern, scaled to this year, missed by ${r(mid.last_year.mae)}` +
           (mid.last_year.mae > mid.pickup.mae ? ' — which is why it is shown for comparison and not used.' : '.');
    }
    // Systematic lean, named when it is big enough to act on.
    if (Math.abs(mid.pickup.bias) >= Math.max(3, mid.pickup.mae * 0.4)) {
      s += ` It has tended to run ${r(Math.abs(mid.pickup.bias))} covers ${mid.pickup.bias > 0 ? 'HIGH' : 'LOW'}.`;
    }
    parts.push(s);
  } else {
    parts.push('Not yet scored: there is not enough history to test it against.');
  }

  if (lift !== null && Math.abs(lift) >= 10) {
    parts.push(
      `Last year, this time of year ran ${Math.round(Math.abs(lift))}% ${lift > 0 ? 'busier' : 'quieter'} than the same weekdays in the ${TRAINING_WEEKS} weeks before it. ` +
      `The forecast learns from recent weeks and cannot see a seasonal turn it has not lived through — ` +
      `if last year repeats, expect the ${lift > 0 ? 'top' : 'bottom'} of the range.`,
    );
  }

  const hol = days.filter(d => d.holiday && !d.closed);
  if (hol.length) {
    parts.push(
      `${hol.map(d => d.holiday).join(', ')} ${hol.length === 1 ? 'falls' : 'fall'} in this window. ` +
      `Holidays are flagged, not modelled — ${TRAINING_WEEKS} ordinary weeks say little about one.`,
    );
  }

  if (days.some(d => d.beyond_history)) {
    parts.push(
      'A night marked ⚑ already has more booked than any comparable night served — usually a buyout or event, ' +
      'where the walk-ins this adds will not come. Read that one as the book, not the forecast.',
    );
  }

  return parts.join(' ');
}
