/**
 * Has Revel moved since Sauron loaded the day?
 *
 * Sauron loads each day's Revel report once, at 04:26, and Revel keeps
 * accepting changes to that day for days afterwards. Measured 6 Oct 2026 at Fat
 * Prince: a fully-discounted "Prince Care" bill added to Sat 1 Aug on Mon 3 Aug,
 * and $67 of food and drink added to Wed 30 Sep's lunch on Mon 5 Oct. Revel's
 * auto-delivery cannot resend a past day and its API is refused on cost, so the
 * correction is a manual re-upload. This finds the days that need one.
 *
 * THE MONDAY BOARD IS THE WITNESS. Finance corrects it from Revel after the fact,
 * so when Revel moves, the board moves with it and Sauron's Revel copy does not.
 * Comparing the two every run -- not only when the board changes -- is what
 * catches it. The old check ran only at the moment of a board edit, and only if
 * the day was already settled; 1 Aug was edited on the Monday after, before it
 * had settled, and was never looked at again.
 *
 * Only SETTLED days are judged: before that the board is still being filled in,
 * and a difference is the work in progress, not a finding.
 */
import { isSettled } from './accounting-period.js';

export interface DriftRow {
  venue_id: string;
  business_date: string;
  /** Revel's food + beverage, as Sauron loaded it. */
  gross_sales: number | string | null;
  meal_periods: unknown;
}

export interface DriftFinding {
  venue_id: string;
  business_date: string;
  monday_gross: number;
  revel_gross: number;
  difference: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Food + drink on the board, or null if the board has none for the day. */
export function boardFoodBev(mealPeriods: unknown): number | null {
  if (!mealPeriods || typeof mealPeriods !== 'object' || Array.isArray(mealPeriods)) return null;
  let total = 0, any = false;
  for (const p of Object.values(mealPeriods as Record<string, any>)) {
    if (!p || typeof p !== 'object') continue;
    if (p.food_sales != null || p.bev_sales != null) any = true;
    total += Number(p.food_sales ?? 0) + Number(p.bev_sales ?? 0);
  }
  return any ? round2(total) : null;
}

/**
 * Split the days into those that disagree and those that agree. Days without
 * both a board and a Revel figure, and days not yet settled, are in neither:
 * there is nothing to judge.
 */
export function revelBoardDrift(rows: DriftRow[], asOf: Date = new Date()): {
  differ: DriftFinding[];
  agree: Array<{ venue_id: string; business_date: string }>;
} {
  const differ: DriftFinding[] = [];
  const agree: Array<{ venue_id: string; business_date: string }> = [];
  for (const r of rows) {
    const board = boardFoodBev(r.meal_periods);
    if (board === null || r.gross_sales === null || r.gross_sales === undefined) continue;
    if (!isSettled(r.business_date, asOf)) continue;
    const revel = round2(Number(r.gross_sales));
    const difference = round2(board - revel);
    if (Math.abs(difference) < 0.005) agree.push({ venue_id: r.venue_id, business_date: r.business_date });
    else differ.push({ venue_id: r.venue_id, business_date: r.business_date, monday_gross: board, revel_gross: revel, difference });
  }
  return { differ, agree };
}

export interface ResolvedAlert {
  venue_id: string;
  business_date: string;
  monday_gross: number | string | null;
  revel_gross: number | string | null;
}

/**
 * Has a person already decided about this difference?
 *
 * Some differences are correct and stay: something sold and never rung through
 * the POS is on the board and will never be in Revel. Once somebody resolves
 * that, raising it again every hour would teach them to stop reading the list.
 * So a resolved alert for the day stands -- UNLESS it recorded figures and the
 * figures have since moved, which is new information about the day and is
 * raised afresh. One resolved without figures (raised before they were kept)
 * stands as it is: somebody looked at the day.
 */
export function alreadyDecided(finding: DriftFinding, resolved: ResolvedAlert[]): boolean {
  const same = (a: number | string | null, b: number) => a !== null && Math.abs(Number(a) - b) < 0.005;
  return resolved.some(r =>
    r.venue_id === finding.venue_id && r.business_date === finding.business_date &&
    ((r.monday_gross === null && r.revel_gross === null) ||
     (same(r.monday_gross, finding.monday_gross) && same(r.revel_gross, finding.revel_gross))));
}

/**
 * Does a board edit made after close agree with Revel to the cent?
 *
 * The test for applying a "changed after close" edit without a second look:
 * when the corrected board equals what Revel says for the day, the edit is the
 * board catching up with the POS, and taking it is not a judgement. Only days
 * holding BOTH sources qualify; a board-only day has nothing to check it with.
 */
export function boardMatchesRevel(
  newMealPeriods: unknown,
  row: { data_source: string | null; gross_sales: number | string | null } | undefined,
): boolean {
  if (!row || row.data_source !== 'both' || row.gross_sales === null || row.gross_sales === undefined) return false;
  const board = boardFoodBev(newMealPeriods);
  return board !== null && Math.abs(board - Number(row.gross_sales)) < 0.005;
}

/** How far back the sweep looks. Five weeks covers a month's close with room. */
export const DRIFT_WINDOW_DAYS = 35;
