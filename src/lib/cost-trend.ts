/**
 * Food and beverage cost percentage, month by month.
 *
 * WHY A LINE AND NOT A FIGURE. A cost-of-sales line in a P&L is PURCHASES in
 * the period, not consumption, unless the venue posts a stock movement. A large
 * delivery near a month end lands against sales it has not produced yet, so one
 * month can read 40% and the next 31% with nothing wrong in either. The brief
 * already says to read the trend over a quarter; a single number on a dashboard
 * invites exactly the opposite, because it looks like a measurement.
 *
 * Over six months the delivery noise mostly cancels and what is left is drift,
 * which is the thing worth acting on and the thing nobody can see from one
 * month at a time.
 *
 * A MONTH WITH NO LEDGER IS A GAP, NOT A ZERO. Plotting an unclosed or
 * uningested month as 0% draws a collapse in the most important cost line in
 * the business. It is also not interpolated: joining the points either side
 * draws a straight line through a month nobody measured, which is a claim about
 * data that does not exist.
 *
 * THE CLASSIFICATION HAS TO BE STABLE FOR A TREND TO MEAN ANYTHING. If an
 * account is mapped to food in one month and unmapped in another, the line
 * moves for a reason that is not the kitchen. `unclassified_total` is carried
 * per point for exactly that reason, and the note says so when it changes.
 */

import { costRatios, type PLRow, type SalesSplit } from './cost-ratios.js';

export interface MonthInput {
  /** 'YYYY-MM-01' — the first of the month, as the P&L keys it. */
  start: string;
  rows: PLRow[];
  sales: SalesSplit;
}

export interface CostPoint {
  month: string;
  /** 'Sep' — short, because six of them share a 320-unit axis. */
  label: string;
  food_pct: number | null;
  beverage_pct: number | null;
  food_cogs: number;
  beverage_cogs: number;
  unclassified_total: number;
  /**
   * False when the month has no P&L at all. Distinct from a month with a P&L
   * and no sales, which has costs and no denominator — those are different
   * facts and only one of them is a missing feed.
   */
  available: boolean;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The last `count` complete months, oldest first, ending with the one before `today`. */
export function trailingMonths(today: string, count = 6): string[] {
  const d = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`trailingMonths: "${today}" is not a date`);

  const out: string[] = [];
  // Start from the month BEFORE the current one: a month in progress has
  // partial purchases against partial sales and is not comparable to a closed
  // one. It would also always be the last point, so it would look like the
  // trend rather than like an artefact.
  for (let i = count; i >= 1; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 10));
  }
  return out;
}

export function costTrend(months: MonthInput[]): CostPoint[] {
  return months.map(m => {
    const available = m.rows.length > 0;
    const r = costRatios(m.rows, m.sales);
    const monthIndex = Number(m.start.slice(5, 7)) - 1;
    return {
      month: m.start.slice(0, 7),
      label: MONTH_LABELS[monthIndex] ?? m.start.slice(5, 7),
      food_pct: available ? r.food.pct : null,
      beverage_pct: available ? r.beverage.pct : null,
      food_cogs: r.food.cogs,
      beverage_cogs: r.beverage.cogs,
      unclassified_total: r.unclassified_total,
      available,
    };
  });
}

/**
 * What the line actually shows, in a sentence, computed rather than left to be
 * read off the picture.
 *
 * MEASURED FIRST-TO-LAST ON THE POINTS THAT EXIST, not on the whole span: with
 * a missing month in the middle, "since May" would be wrong if May is a gap.
 * Points, not percent — a move from 30% to 34% is four POINTS and a 13% rise,
 * and calling it 13% invites somebody to apply it to a different base.
 */
export function trendNote(points: CostPoint[]): string {
  const real = points.filter(p => p.available && p.food_pct !== null);
  if (real.length < 2) {
    return real.length === 1
      ? 'Only one month has a closed P&L, so there is no trend to read yet.'
      : 'No closed P&L months in this span, so there is nothing to plot. The figures are missing, not zero.';
  }

  const first = real[0], last = real[real.length - 1];
  const move = Math.round((last.food_pct! - first.food_pct!) * 10) / 10;
  const dir = move > 0.2 ? 'up' : move < -0.2 ? 'down' : 'flat';

  let out = dir === 'flat'
    ? `Food cost has held near ${last.food_pct}% since ${first.label}.`
    : `Food cost is ${dir} ${Math.abs(move)} points since ${first.label}, at ${last.food_pct}%.`;

  if (last.beverage_pct !== null) out += ` Beverage is at ${last.beverage_pct}%.`;

  const missing = points.filter(p => !p.available).map(p => p.label);
  if (missing.length) {
    out += ` ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no closed P&L and ${missing.length === 1 ? 'is' : 'are'} left as a gap rather than a zero.`;
  }

  /**
   * A classification that changes between months moves the line for a reason
   * that is not the kitchen, and it is invisible from the shape. Reported when
   * it is material rather than whenever it is non-zero, because packaging sits
   * in cost of sales legitimately and every month will have some.
   */
  const unclassified = real.filter(p => p.unclassified_total > 0);
  if (unclassified.length > 0 && unclassified.length < real.length) {
    out += ` Note that ${unclassified.map(p => p.label).join(', ')} ${unclassified.length === 1 ? 'has' : 'have'} ` +
           'cost-of-sales accounts that are neither food nor beverage and are excluded, so those months are not ' +
           'measured on quite the same basis as the rest.';
  }

  return out;
}
