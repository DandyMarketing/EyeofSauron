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

import { costBucket, isSushiSales, type CostBucket } from './cost-ratios.js';
import { NON_SPEND_STATUSES } from '../parsers/xero/bills.js';
import { COUNTED_SALES_STATUSES } from '../parsers/xero/sales-invoices.js';

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

/**
 * Whether a period's invoices can all be in yet.
 *
 * Khai, 6 Oct 2026: "the invoice should reach within the week". A bill is
 * entered in Xero up to seven days after its date, so on the Monday after a
 * week ends that week is missing whatever was uploaded late, reads LOW, and
 * rises over the following days. Nothing said so, and a low food cost is the
 * flattering direction to be wrong in. The same three venues showed it on the
 * first check: Angra, Wine Heritage and Mr Vino on Monday's board, not yet in
 * Xero.
 *
 *   in_progress  the period has not ended
 *   provisional  it has ended, and invoices dated in it may still arrive
 *   final        seven days have passed since it ended
 */
export interface CostSettlement {
  status: 'in_progress' | 'provisional' | 'final';
  /** The first day the figure is final. */
  final_on: string;
}

/** Days after a period ends that its invoices may still be entered. */
export const INVOICE_ARRIVAL_DAYS = 7;

export function costSettlement(periodEnd: string, today: string): CostSettlement {
  const end = new Date(`${periodEnd}T00:00:00Z`);
  const finalOn = new Date(end);
  // Seven days to be entered, plus the daily Xero pull the morning after.
  finalOn.setUTCDate(finalOn.getUTCDate() + INVOICE_ARRIVAL_DAYS + 1);
  const final_on = finalOn.toISOString().slice(0, 10);
  if (today <= periodEnd) return { status: 'in_progress', final_on };
  return { status: today >= final_on ? 'final' : 'provisional', final_on };
}

/**
 * Stock moved between sister venues, in one venue's terms.
 *
 * Khai, 6 Oct 2026: a transfer "should be counted as cost and also credit so if
 * Neon Pigeon buys for FP then it should minus from NP and + to FP". The
 * receiving venue already carries it -- the transfer arrives there as a bill
 * from the sending company. The sender's own purchase bill is still in ITS
 * bills, so without this the same stock is cost at both venues.
 *
 * ONLY FOOD AND DRINK. Sister companies also bill each other for PR fees, booth
 * fees, glassware and uniforms (about $57,000 against $5,600 of stock over
 * twelve months); those are real costs at the receiver and are not credited
 * back. "Transfers are usually food and beverage products" -- so a line counts
 * when the RECEIVER coded it to food, drink or sushi cost of sales.
 *
 * WEEKLY ONLY. The monthly P&L is not adjusted: no venue books transfers to a
 * separate income account, so the sender most likely credits its own COGS
 * already, and subtracting again would count the credit twice.
 */
export interface TransferTotals {
  /** Received from sister venues: already in this venue's bills, reported for clarity. */
  in: { food: number; beverage: number; sushi: number };
  /** Sent to sister venues: taken OFF this venue's food and beverage cost. */
  out: { food: number; beverage: number };
}

export interface TransferLine extends BillLine {
  /** The venue whose bills this line is in. */
  receiver_venue_id: string;
  /** The venue whose company sent it, from sister_companies (exact name). */
  sender_venue_id: string;
}

/**
 * Per-venue transfer totals from the bill lines that sister companies sent.
 *
 * `namesByVenue` is each RECEIVER's account map: the line is classified by the
 * account the receiver coded it to, which is the only coding we can see.
 * Sushi received is taken off the sender's FOOD: the sender has no sushi line
 * of its own, and sushi is food.
 */
export function transferTotals(
  lines: TransferLine[],
  namesByVenue: Map<string, AccountNames>,
): Map<string, TransferTotals> {
  const out = new Map<string, TransferTotals>();
  const of = (venueId: string) => {
    let t = out.get(venueId);
    if (!t) out.set(venueId, t = { in: { food: 0, beverage: 0, sushi: 0 }, out: { food: 0, beverage: 0 } });
    return t;
  };
  for (const l of lines) {
    if (!isSpend(l)) continue;
    // A venue's own company billing itself (tips, petty items) is not a transfer.
    if (l.sender_venue_id === l.receiver_venue_id) continue;
    const kind = bucketOfLine(l, namesByVenue.get(l.receiver_venue_id) ?? new Map());
    if (kind !== 'food' && kind !== 'beverage' && kind !== 'sushi') continue;
    const amount = Number(l.line_amount);
    of(l.receiver_venue_id).in[kind] += amount;
    of(l.sender_venue_id).out[kind === 'beverage' ? 'beverage' : 'food'] += amount;
  }
  for (const t of out.values()) {
    for (const k of ['food', 'beverage', 'sushi'] as const) t.in[k] = round2(t.in[k]);
    for (const k of ['food', 'beverage'] as const) t.out[k] = round2(t.out[k]);
  }
  return out;
}

export interface WeeklySushi {
  cogs: number;
  sales: number | null;
  pct: number | null;
  cost_coverage_pct: number | null;
  sales_coverage_pct: number | null;
}

/** A sales invoice line, as the dashboard reads it. */
export interface SalesLine {
  account_id: string | null;
  /** Ex-GST, credits already negative. */
  net_amount: number;
  status?: string | null;
}

/**
 * Sushi sales in a set of sales invoice lines: lines coded to an income account
 * that `isSushiSales` recognises, on invoices that are in the ledger
 * (AUTHORISED or PAID -- a draft is not a sale yet).
 */
export function sushiSalesOf(lines: SalesLine[], names: AccountNames): number {
  let total = 0;
  for (const l of lines) {
    if (!COUNTED_SALES_STATUSES.has(String(l.status ?? '').toUpperCase())) continue;
    const info = l.account_id ? names.get(l.account_id) : undefined;
    if (!info || typeof info === 'string') continue;
    if (!isSushiSales({ section: info.section ?? '', business_line: info.business_line ?? undefined, canonical_account: info.name, account_name: info.raw ?? info.name })) continue;
    total += Number(l.net_amount);
  }
  return round2(total);
}

export interface WeeklyCogs {
  /** Set by the caller, which knows the period and today. */
  settlement?: CostSettlement;
  /** Stock moved to and from sister venues in the window, when there was any. */
  transfers?: TransferTotals;
  food: WeeklyCogsSide;
  beverage: WeeklyCogsSide;
  /**
   * Sushi, on its own and out of both percentages. Cost from bills; SALES from
   * Xero sales invoices (sushi is invoiced, never rung through Revel). Each side
   * carries its coverage against the last complete month's ledger, and the % is
   * given only when both are usable. `sales` is null when sales invoices are not
   * loaded at all -- unknown, not zero.
   */
  sushi: WeeklySushi;
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
  transfers?: TransferTotals,
  /** Sushi sales for the window and the coverage of both sushi sides; absent if sales invoices are not loaded. */
  sushiInput?: { sales: number | null; sales_coverage: number | null; cost_coverage: number | null },
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

  // Stock sent to a sister venue is that venue's cost, not this one's.
  if (transfers) {
    food -= transfers.out.food;
    bev -= transfers.out.beverage;
  }

  const out: WeeklyCogs = {
    food: side(food, sales.food_sales, coverage.food),
    beverage: side(bev, sales.beverage_sales, coverage.beverage),
    sushi: (() => {
      const cost_coverage_pct = sushiInput?.cost_coverage ?? null;
      const sales_coverage_pct = sushiInput?.sales_coverage ?? null;
      const salesFig = sushiInput?.sales ?? null;
      const usable = (c: number | null) => c !== null && c >= USABLE_COVERAGE_PCT;
      return {
        cogs: round2(sushi),
        sales: salesFig,
        pct: salesFig !== null && salesFig > 0 && usable(cost_coverage_pct) && usable(sales_coverage_pct)
          ? round2(sushi / salesFig * 100) : null,
        cost_coverage_pct,
        sales_coverage_pct,
      };
    })(),
    unknown_account_total: round2(unknown),
    caveats: [],
  };

  const money = (n: number) => '$' + n.toFixed(2);
  if (transfers) {
    const sent = transfers.out.food + transfers.out.beverage;
    const got = transfers.in.food + transfers.in.beverage + transfers.in.sushi;
    if (got !== 0 || sent !== 0) out.transfers = transfers;
    if (got !== 0) {
      out.caveats.push(
        `Includes ${money(got)} of stock received from sister venues (food ${money(transfers.in.food)}, ` +
        `drink ${money(transfers.in.beverage)}${transfers.in.sushi ? `, sushi ${money(transfers.in.sushi)}` : ''}), ` +
        'counted here because this venue used it.',
      );
    }
    if (sent !== 0) {
      out.caveats.push(
        `${money(sent)} of stock sent to sister venues (food ${money(transfers.out.food)}, drink ${money(transfers.out.beverage)}) ` +
        'has been taken off: it is their cost, not this venue\'s. The monthly P&L figure is not adjusted.',
      );
    }
  }

  // What the figure IS (purchasing, not consumption) is said once, in the
  // panel's own note. It used to be repeated here as the first caveat, so the
  // panel read the same explanation twice in different words.

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
  ledgerByKind: { food: number; beverage: number; sushi?: number },
): { food: number | null; beverage: number | null; sushi: number | null } {
  let food = 0, bev = 0, sushi = 0;
  for (const l of billLinesInMonth) {
    if (!isSpend(l)) continue;
    const kind = bucketOfLine(l, names);
    if (kind === 'food') food += Number(l.line_amount);
    else if (kind === 'beverage') bev += Number(l.line_amount);
    else if (kind === 'sushi') sushi += Number(l.line_amount);
  }
  // Null, not zero, when the ledger has nothing to compare against: "we
  // cannot tell" and "the bills explain none of it" are different answers.
  const of = (part: number, whole: number | undefined) => (whole && whole > 0 ? round2(part / whole * 100) : null);
  return {
    food: of(food, ledgerByKind.food),
    beverage: of(bev, ledgerByKind.beverage),
    sushi: of(sushi, ledgerByKind.sushi),
  };
}
