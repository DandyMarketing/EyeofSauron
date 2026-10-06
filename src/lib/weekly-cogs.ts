/**
 * Food and beverage cost for a WEEK, from supplier bills rather than the P&L.
 *
 * I had this wrong. I said a cost percentage could only ever be monthly because
 * the P&L's finest grain is a month. Khai, 4 Oct 2026: "a weekly cogs is based
 * on the same week sales, invoices are uploaded at their best daily." He is
 * right, and the data says so -- `supplier_bills.bill_date` is a DATE, so the
 * purchases side already has daily resolution and only the ledger's roll-up
 * was monthly. The P&L was the limit of one source, not of the measurement.
 *
 * WHAT THIS BUYS AND WHAT IT COSTS. A week of purchases against the same week's
 * sales is a real operating number and it arrives six weeks before the ledger
 * closes. It is also noisier, for a reason that gets worse at a weekly grain
 * rather than better: a bill is PURCHASING, not consumption. One large delivery
 * lands entirely in the week it was invoiced, against sales that will happen
 * over the next three. Monthly, most of that averages out; weekly it does not,
 * and a single week can read 55% or 18% with nothing wrong at all.
 *
 * So this is built to be read as a TREND and says so, and the dashboard shows
 * the ledger figure beside it whenever both exist.
 *
 * COVERAGE IS THE CONTROL, AND IT IS NOT UNIFORM. Measured at Neon Pigeon for
 * June 2026, bills account for food purchases at roughly 100% and for COGS
 * Beverages at **0%** -- drink is bought on a card or coded to inventory and
 * journalled out later, so it never touches a bill. A weekly beverage cost from
 * bills would therefore read near zero and look like a triumph. Coverage is
 * computed against the last complete month's ledger for each account, returned
 * with every figure, and a figure under 70% covered is marked unusable rather
 * than shown small.
 *
 * CREDIT NOTES ARE ALREADY NEGATIVE in `supplier_bills` (migration 031), so
 * they net against bills by being summed. Applying a sign here would double the
 * correction -- the comment on the table says so and it is repeated because
 * this is the second place that could get it wrong.
 */

import { costBucket, type CostBucket } from './cost-ratios.js';
import { NON_SPEND_STATUSES } from '../parsers/xero/bills.js';

export interface BillLine {
  /** Xero's account UUID. Joins to profit_and_loss.account_id. */
  account_id: string | null;
  line_amount: number;
  bill_date: string;
  /**
   * The bill's Xero status. VOIDED and DELETED bills are stored, so a figure
   * that changed can be explained, and are never spend. The dashboard counted
   * them anyway: a Toho bill deleted and re-entered on 29 Sep 2026 was counted
   * twice ($161.10 + $147.80). The chat's bill tool had always excluded them.
   */
  status?: string | null;
}

/** What the P&L says about an account: its canonical name, section and line. */
export interface AccountInfo {
  name: string;
  raw?: string | null;
  section?: string | null;
  business_line?: string | null;
}

/**
 * account_id -> what the P&L knows about the account.
 *
 * A bare string is a canonical name taken to be COST OF SALES, kept for callers
 * that only ever hold cost-of-sales accounts. The dashboard passes the section,
 * because without it an operating expense named "Kitchen expenses" reads as food.
 */
export type AccountNames = Map<string, string | AccountInfo>;

/** The bucket a bill line lands in, 'unknown' when its account is not in the P&L. */
function bucketOfLine(l: BillLine, names: AccountNames): CostBucket | null | 'unknown' {
  const info = l.account_id ? names.get(l.account_id) : undefined;
  if (!info) return 'unknown';
  if (typeof info === 'string') return costBucket({ canonical: info, section: 'Cost of Sales' });
  return costBucket({ canonical: info.name, raw: info.raw, section: info.section, business_line: info.business_line });
}

const isSpend = (l: BillLine) => !NON_SPEND_STATUSES.has(String(l.status ?? '').toUpperCase());

export interface WeeklyCogsSide {
  cogs: number;
  sales: number;
  pct: number | null;
  /**
   * What share of this account the ledger says bills actually explain, measured
   * over the last complete month. Null when there is no ledger month to measure
   * against, which is itself a reason not to trust the figure.
   */
  coverage_pct: number | null;
  /** False when coverage is too low for the number to mean anything. */
  usable: boolean;
}

export interface WeeklyCogs {
  food: WeeklyCogsSide;
  beverage: WeeklyCogsSide;
  /** Sushi purchases, kept out of both percentages. See `costBucket`. */
  sushi: { cogs: number };
  /** Bill lines whose account could not be named at all. */
  unknown_account_total: number;
  caveats: string[];
}

/**
 * Below this, a bill-derived figure is not a measurement.
 *
 * 70% is a judgement and it is written down so it can be argued with. Above it
 * the shape of the week is right even if the level is a little low; below it
 * the number is mostly absence, and absence reported as a low food cost is the
 * most flattering way this product could lie.
 */
export const USABLE_COVERAGE_PCT = 70;

const round2 = (n: number) => Math.round(n * 100) / 100;

function side(cogs: number, sales: number, coverage: number | null): WeeklyCogsSide {
  return {
    cogs: round2(cogs),
    sales: round2(sales),
    pct: sales > 0 ? round2(cogs / sales * 100) : null,
    coverage_pct: coverage === null ? null : round2(coverage),
    usable: coverage !== null && coverage >= USABLE_COVERAGE_PCT,
  };
}

/**
 * Sum bill lines into food and beverage for a window.
 *
 * `names` resolves Xero's account UUID to the canonical account name, which is
 * then classified exactly as the P&L path classifies it -- one classifier, so
 * the weekly and monthly figures cannot disagree about what counts as food.
 */
export function weeklyCogs(
  lines: BillLine[],
  names: AccountNames,
  sales: { food_sales: number; beverage_sales: number; days?: { monday_board: number; none: number } },
  coverage: { food: number | null; beverage: number | null },
): WeeklyCogs {
  let food = 0, bev = 0, sushi = 0, unknown = 0;

  for (const l of lines) {
    if (!isSpend(l)) continue;
    const kind = bucketOfLine(l, names);
    if (kind === 'unknown') {
      // Counted, never dropped. A line we cannot name is a line we cannot say
      // is not food, and shrinking the numerator silently flatters the ratio.
      unknown += Number(l.line_amount);
      continue;
    }
    if (kind === 'food') food += Number(l.line_amount);
    else if (kind === 'beverage') bev += Number(l.line_amount);
    else if (kind === 'sushi') sushi += Number(l.line_amount);
  }

  const out: WeeklyCogs = {
    food: side(food, sales.food_sales, coverage.food),
    beverage: side(bev, sales.beverage_sales, coverage.beverage),
    sushi: { cogs: round2(sushi) },
    unknown_account_total: round2(unknown),
    caveats: [],
  };

  out.caveats.push(
    'From supplier bills, which carry a date, so this is PURCHASING in the period and not consumption. ' +
    'One large delivery lands entirely in the week it was invoiced against sales spread over the next three — ' +
    'weekly, that does not average out. Read the direction over several weeks, not the level of one.',
  );

  for (const [label, s] of [['Food', out.food], ['Beverage', out.beverage]] as const) {
    if (s.coverage_pct === null) {
      out.caveats.push(`${label}: no ledger month to measure coverage against, so there is no way to tell whether these bills are the whole story.`);
    } else if (!s.usable) {
      out.caveats.push(
        `${label}: bills explain only ${s.coverage_pct}% of this account in the ledger, so a weekly figure from them is ` +
        // Said of whichever side it is. It used to blame drink bought on a
        // card, and was printed under FOOD once food coverage fell too
        // (Neon Pigeon, September 2026: 66.9%) -- an explanation of the
        // wrong account, which is worse than none.
        'mostly absence: anything paid by card or bank transfer, or coded to inventory and journalled out later, never touches a bill. ' +
        'Do not quote this percentage — use the monthly ledger figure.',
      );
    }
  }

  // Short sales make every percentage read high by the missing share -- the
  // 301% defect. Withheld, never shown, and the reason given.
  const short = sales.days?.none ?? 0;
  if (short > 0) {
    out.food.pct = null;
    out.beverage.pct = null;
    out.caveats.push(
      `${short} day(s) in this window carried sales with no food/drink split from Revel or the Monday board, ` +
      'so the sales side is short and the percentages are withheld.',
    );
  }
  if ((sales.days?.monday_board ?? 0) > 0) {
    out.caveats.push(
      `Food and drink sales for ${sales.days!.monday_board} day(s) come from the Monday board rather than Revel.`,
    );
  }

  if (out.unknown_account_total !== 0) {
    out.caveats.push(
      `$${out.unknown_account_total.toFixed(2)} of bill lines could not be matched to a named account and are excluded ` +
      'from both figures. They are counted here rather than dropped, because a line nobody can name is a line nobody can rule out.',
    );
  }

  return out;
}

/**
 * How much of each account's ledger total the bills actually explain.
 *
 * MEASURED ON A COMPLETE MONTH, never on the week being reported. A part-month
 * has bills that have not been entered yet and a ledger that has not closed, so
 * measuring coverage there would compare two different kinds of incomplete and
 * produce a number that moves for reasons nobody can see.
 */
export function coverageFor(
  billLinesInMonth: BillLine[],
  names: AccountNames,
  ledgerByKind: { food: number; beverage: number },
): { food: number | null; beverage: number | null } {
  let food = 0, bev = 0;
  for (const l of billLinesInMonth) {
    if (!isSpend(l)) continue;
    const kind = bucketOfLine(l, names);
    if (kind === 'food') food += Number(l.line_amount);
    else if (kind === 'beverage') bev += Number(l.line_amount);
  }
  return {
    // Null, not zero, when the ledger has nothing to compare against: "we
    // cannot tell" and "the bills explain none of it" are different answers.
    food: ledgerByKind.food > 0 ? round2(food / ledgerByKind.food * 100) : null,
    beverage: ledgerByKind.beverage > 0 ? round2(bev / ledgerByKind.beverage * 100) : null,
  };
}
