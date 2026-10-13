/**
 * The morning report: yesterday, week to date, month to date, tonight's book.
 *
 * Asked for by Khai on 11 Oct 2026, to go out on WhatsApp every morning. It is
 * FIGURES ONLY. Advice stays weekly (see "The proactive half" in CLAUDE.md): a
 * Tuesday dip is a Tuesday, and daily advice teaches people to ignore advice.
 *
 * NOT TIED TO A CHANNEL. This builds the figures and one plain-text rendering
 * of them. The web preview shows that text exactly as a phone would; WhatsApp
 * (or Telegram) is a sender bolted on later, and neither may compute a figure of
 * its own -- a second copy of a number is how the Monday board and Revel came to
 * disagree.
 *
 * NO PERSONAL DATA. Covers are counts. Returning guests and their profiles are
 * parked (CLAUDE.md, "Later"), and when they come, names never go over chat.
 *
 * EVERY COMPARISON IS LIKE FOR LIKE BY WEEKDAY, the dashboard's rule:
 *   - yesterday against the same weekday a week earlier;
 *   - week to date against the same weekdays of the week before;
 *
 * EXCEPT THE MONTH, which is by DATE: 1-10 Oct against 1-10 Sep. Khai, 11 Oct
 * 2026: "the month to date should match month to month". It is the dashboard's
 * rule, taken from `periodWindow()` itself so the two can never disagree. The
 * spans can then hold a different number of weekend days -- or of days, on the
 * 31st -- and the message says so on its own line rather than letting the
 * calendar pass for trade. A monthly budget will sit beside it when one exists.
 */

import { salesFiguresOf } from './sales.js';
import type { CoversSummary } from './covers.js';
import { dashboardWindow, movement, periodWindow, weekendDays } from './dashboard-window.js';
import { weekdayOf } from '../ingest/closures.js';

export interface Span { start: string; end: string }
export interface Comparison { current: Span; prior: Span; days: number }

export interface ReportWindows {
  day: Comparison;
  wtd: Comparison;
  mtd: Comparison;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function spanDays(s: Span): number {
  return Math.round((Date.parse(`${s.end}T00:00:00Z`) - Date.parse(`${s.start}T00:00:00Z`)) / 86400_000) + 1;
}

/** The three comparisons for a report whose last day is `day`. */
export function reportWindows(day: string): ReportWindows {
  const w = dashboardWindow(day);
  // Built AS OF the report day, so "to date" means to the last day reported.
  const m = periodWindow('mtd', day, day);
  return {
    day: { current: { start: day, end: day }, prior: { start: addDays(day, -7), end: addDays(day, -7) }, days: 1 },
    wtd: { current: w.current, prior: w.prior, days: w.days },
    mtd: { current: m.current, prior: m.prior, days: m.days },
  };
}

export type DayStatus = 'ok' | 'closed' | 'late' | 'no_data';

/**
 * Which day the report runs to for one venue, and why.
 *
 * A CLOSED DAY HAS NO ROW. The ingest refuses an empty Revel file -- it cannot
 * tell one from a truncated download -- so Firangi's Sunday never lands, and on
 * Monday morning its latest row is Saturday. Read naively that is "Revel late";
 * it is a venue that was shut. So closed weekdays are stepped over before the
 * latest row is judged.
 *
 * A LATE FILE CUTS THE WINDOWS, never pads them. Revel lands about 04:30; if it
 * has not, the report runs to the last day there IS, and says so, so both sides
 * of every comparison hold the same number of traded days.
 */
export function reportDay(
  yesterday: string, lastDataDate: string | null, closedWeekdays: number[],
): { day: string | null; status: DayStatus } {
  if (!lastDataDate) return { day: null, status: 'no_data' };
  if (lastDataDate >= yesterday) return { day: yesterday, status: 'ok' };

  const shut = new Set(closedWeekdays);
  let d = yesterday;
  for (let i = 0; i < 7 && d > lastDataDate && shut.has(weekdayOf(d)); i++) d = addDays(d, -1);
  if (lastDataDate >= d) {
    return { day: yesterday, status: shut.has(weekdayOf(yesterday)) ? 'closed' : 'ok' };
  }
  return { day: lastDataDate, status: 'late' };
}

export interface SalesDay {
  business_date: string;
  gross_sales: unknown;
  net_sales: unknown;
  item_discounts: unknown;
  order_discounts: unknown;
  total_transactions: unknown;
}

export interface SpanFigures {
  net_sales: number | null;
  covers: number | null;
  /**
   * The same covers by meal (Khai, 13 Oct 2026: "split lunch and dinner covers
   * with the total"). Null with covers. Brunch is its own meal, as everywhere
   * else in Sauron; Fat Prince's DAY and LEGACY shifts arrive as lunch and
   * dinner already (SHIFT_MAP).
   */
  covers_by_meal: Record<string, number> | null;
  spend_per_head: number | null;
  trading_days: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const within = (d: string, s: Span) => d >= s.start && d <= s.end;

/**
 * One span's totals. A zero-sales, zero-bill row is a closed day: it counts as
 * neither trade nor zero. A span with no trading day at all is NULL net sales --
 * "we were shut" and "we took nothing" are different answers.
 *
 * Covers are completed SevenRooms covers, null when SevenRooms holds nothing for
 * the span. Spend per head is food and beverage over covers, the dashboard's
 * definition, so the two never quote different figures for the same days.
 */
export function spanFigures(rows: SalesDay[], covers: Map<string, CoversSummary>, span: Span): SpanFigures {
  let net = 0, fb = 0, trading = 0;
  for (const r of rows) {
    if (!within(r.business_date, span)) continue;
    if (Number(r.gross_sales ?? 0) === 0 && Number(r.total_transactions ?? 0) === 0) continue;
    const f = salesFiguresOf(r as any);
    net += f.net_sales;
    fb += f.food_bev_sales;
    trading++;
  }
  let c = 0, seen = false;
  const byMeal: Record<string, number> = {};
  for (const [d, s] of covers) {
    if (!within(d, span)) continue;
    seen = true;
    c += s.covers;
    for (const [meal, n] of Object.entries(s.by_shift ?? {})) byMeal[meal] = (byMeal[meal] ?? 0) + n;
  }
  const coversOut = seen ? c : null;
  return {
    net_sales: trading > 0 ? round2(net) : null,
    covers: coversOut,
    covers_by_meal: seen ? byMeal : null,
    spend_per_head: trading > 0 && coversOut ? round2(fb / coversOut) : null,
    trading_days: trading,
  };
}

export interface ReportLine {
  current: Span;
  prior: Span;
  days: number;
  now: SpanFigures;
  then: SpanFigures;
  net_sales_change_pct: number | null;
  covers_change_pct: number | null;
}

export interface VenueDailyReport {
  venue_id: string;
  venue: string;
  slug: string;
  /** The morning it is for (Singapore date). */
  date: string;
  status: DayStatus;
  /** The last day the figures run to. Null only when the venue has no sales at all. */
  through: string | null;
  day: ReportLine | null;
  wtd: ReportLine | null;
  mtd: ReportLine | null;
  tonight: { closed: boolean; booked: number | null; booked_by_meal: Record<string, number> | null };
  /** The message as it would be sent. */
  text: string;
}

function line(rows: SalesDay[], covers: Map<string, CoversSummary>, c: Comparison): ReportLine {
  const now = spanFigures(rows, covers, c.current);
  const then = spanFigures(rows, covers, c.prior);
  return {
    current: c.current, prior: c.prior, days: c.days, now, then,
    net_sales_change_pct: movement(now.net_sales, then.net_sales).pct,
    covers_change_pct: movement(now.covers, then.covers).pct,
  };
}

/** Assemble one venue's report from rows already read. Pure, so it is tested. */
export function composeVenueReport(input: {
  venue: { id: string; name: string; slug: string };
  today: string;
  closedWeekdays: number[];
  rows: SalesDay[];
  covers: Map<string, CoversSummary>;
  lastDataDate: string | null;
}): VenueDailyReport {
  const { venue, today, closedWeekdays, rows, covers, lastDataDate } = input;
  const { day, status } = reportDay(addDays(today, -1), lastDataDate, closedWeekdays);
  const w = day ? reportWindows(day) : null;

  const closedTonight = closedWeekdays.includes(weekdayOf(today));
  const sevenRoomsSeen = covers.size > 0;
  const tonight = {
    closed: closedTonight,
    booked: closedTonight ? null : (covers.get(today)?.expected_covers ?? (sevenRoomsSeen ? 0 : null)),
    booked_by_meal: closedTonight ? null : (covers.get(today)?.expected_by_shift ?? (sevenRoomsSeen ? {} : null)),
  };

  const r: Omit<VenueDailyReport, 'text'> = {
    venue_id: venue.id, venue: venue.name, slug: venue.slug,
    date: today, status, through: day,
    day: w ? line(rows, covers, w.day) : null,
    // A one-day week or month is yesterday again, and printed twice it reads
    // as two facts. Left out until it holds more than one day.
    wtd: w && w.wtd.days > 1 ? line(rows, covers, w.wtd) : null,
    mtd: w && w.mtd.days > 1 ? line(rows, covers, w.mtd) : null,
    tonight,
  };
  return { ...r, text: reportText(r) };
}

// ---------------------------------------------------------------- text

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return { dow: DOW[d.getUTCDay()], day: d.getUTCDate(), mon: MON[d.getUTCMonth()] };
}

/** "Fri 10 Oct" */
export function dayLabel(date: string): string {
  const p = parts(date);
  return `${p.dow} ${p.day} ${p.mon}`;
}

/** "6–10 Oct", or "29 Sep–3 Oct" across a month end. */
export function spanLabel(s: Span): string {
  const a = parts(s.start), b = parts(s.end);
  return a.mon === b.mon ? `${a.day}–${b.day} ${b.mon}` : `${a.day} ${a.mon}–${b.day} ${b.mon}`;
}

const money = (v: number) => '$' + Math.round(v).toLocaleString('en-SG');
const pct = (p: number | null) => (p === null ? null : `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)}%`);

const MEAL_ORDER = ['brunch', 'lunch', 'dinner'];

/**
 * "lunch 8, dinner 13" -- every meal served in EITHER span, in the order of the
 * day, so a venue that does lunch shows "lunch 0" on a day it had none, and a
 * dinner-only venue is not told "dinner 21" beside a total of 21. Anything the
 * meals do not account for is named rather than dropped, so the parts always
 * add up to the total printed beside them.
 */
export function mealSplit(total: number, now: Record<string, number> | null, then: Record<string, number> | null = null): string | null {
  if (!now) return null;
  const meals = new Set([...Object.keys(now), ...Object.keys(then ?? {})].filter(m => (now[m] ?? 0) > 0 || ((then ?? {})[m] ?? 0) > 0));
  if (meals.size < 2) return null;
  const ordered = [...meals].sort((a, b) => {
    const ia = MEAL_ORDER.indexOf(a), ib = MEAL_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const parts = ordered.map(m => `${m} ${(now[m] ?? 0).toLocaleString('en-SG')}`);
  const other = total - ordered.reduce((n, m) => n + (now[m] ?? 0), 0);
  if (other > 0) parts.push(`other ${other.toLocaleString('en-SG')}`);
  return parts.join(', ');
}

function figuresText(l: ReportLine, priorLabel: string): string {
  if (l.now.net_sales === null) return 'no trade';
  const bits = [`${money(l.now.net_sales)}`];
  const s = pct(l.net_sales_change_pct);
  bits[0] += s ? ` (${s} vs ${priorLabel})` : ` (nothing to compare with ${priorLabel})`;
  if (l.now.covers !== null) {
    const c = pct(l.covers_change_pct);
    const split = mealSplit(l.now.covers, l.now.covers_by_meal, l.then.covers_by_meal);
    bits.push(`${l.now.covers.toLocaleString('en-SG')} covers${c ? ` (${c})` : ''}${split ? `: ${split}` : ''}`);
  }
  if (l.now.spend_per_head !== null && l.days === 1) bits.push(`${money(l.now.spend_per_head)} per head`);
  return bits.join(' · ');
}

/**
 * What the calendar did to a by-date month comparison, when it did anything.
 * Weekend days are worth far more than a Tuesday here, so "−6%" with one
 * Saturday fewer is mostly the calendar.
 */
export function calendarNote(l: Pick<ReportLine, 'current' | 'prior'>): string | null {
  const bits: string[] = [];
  const dNow = spanDays(l.current), dThen = spanDays(l.prior);
  if (dNow !== dThen) bits.push(`${dNow} days against ${dThen}`);
  const wNow = weekendDays(l.current.start, l.current.end), wThen = weekendDays(l.prior.start, l.prior.end);
  if (wNow !== wThen) bits.push(`${wNow} weekend day${wNow === 1 ? '' : 's'} against ${wThen}`);
  return bits.length ? `_Month to date has ${bits.join(' and ')}, so part of the change is the calendar._` : null;
}

/**
 * The message, in WhatsApp's own markup (*bold*). Kept to one fact per line so
 * it can become a template with one line per blank when WhatsApp is connected.
 */
export function reportText(r: Omit<VenueDailyReport, 'text'>): string {
  const out = [`*${r.venue}* · ${dayLabel(r.date)}`];

  if (r.status === 'no_data' || !r.day) {
    out.push('No sales have reached Sauron for this venue yet.');
  } else {
    if (r.status === 'closed') {
      out.push(`*Yesterday* (${dayLabel(r.day.current.start)}): closed`);
    } else if (r.status === 'late') {
      out.push(`_Revel's file for ${dayLabel(addDays(r.date, -1))} has not arrived. Figures run to ${dayLabel(r.day.current.start)}._`);
      out.push(`*${dayLabel(r.day.current.start)}*: ${figuresText(r.day, dayLabel(r.day.prior.start))}`);
    } else {
      out.push(`*Yesterday* (${dayLabel(r.day.current.start)}): ${figuresText(r.day, dayLabel(r.day.prior.start))}`);
    }
    if (r.wtd) out.push(`*Week to date* (${spanLabel(r.wtd.current)}): ${figuresText(r.wtd, spanLabel(r.wtd.prior))}`);
    if (r.mtd) {
      out.push(`*Month to date* (${spanLabel(r.mtd.current)}): ${figuresText(r.mtd, spanLabel(r.mtd.prior))}`);
      const note = calendarNote(r.mtd);
      if (note) out.push(note);
    }
  }

  // "Today", not "Tonight", now that the book is split by meal: lunch is today too.
  if (r.tonight.closed) out.push('*Today*: closed');
  else if (r.tonight.booked === null) out.push('*Today*: no SevenRooms data');
  else {
    const split = mealSplit(r.tonight.booked, r.tonight.booked_by_meal);
    out.push(`*Today*: ${r.tonight.booked.toLocaleString('en-SG')} covers booked${split ? `: ${split}` : ''}`);
  }

  out.push('_Sales are net: after discounts, with service charge, before GST._');
  return out.join('\n');
}
