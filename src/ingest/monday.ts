import { createHash } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { isPeriodClosed, closeDateFor, isSettled } from '../lib/accounting-period.js';
import { revelBoardDrift, alreadyDecided, DRIFT_WINDOW_DAYS } from '../lib/revel-drift.js';
import { selectAll } from '../lib/paged.js';

const MONDAY_API = 'https://api.monday.com/v2';

interface MondayColumnValues {
  [columnId: string]: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  created_at: string;
  column_values: MondayColumnValues;
}

interface MealPeriodData {
  food_sales: number;
  bev_sales: number;
  service_charge: number;
  covers: number;
  discounts: number;
  reservations: number;
  cancellations: number;
  /** Covers removed from a booking, NOT a discount amount. Confirmed by Khai. */
  reductions: number;
  walk_ins: number;
}

export interface ReconciliationResult {
  passed: boolean;
  mondayGross: number;
  revelGross: number;
  difference: number;
}

export interface IngestionResult {
  venue: string;
  date: string;
  action: 'inserted' | 'updated' | 'merged' | 'locked' | 'blocked' | 'skipped';
  reconciliation?: ReconciliationResult;
  error?: string;
}

const COLUMN_IDS = {
  brunch: {
    food_sales: 'dup__of_lunch_food_sales8',
    bev_sales: 'dup__of_lunch_bev_sales75',
    service_charge: 'numeric',
    covers: 'dup__of_lunch_covers0',
    discounts: 'dup__of_lunch_discounts',
    reservations: 'dup__of_lunch_res5',
    cancellations: 'dup__of_lunch_cxl___ns2',
    reductions: 'dup__of_lunch_reductions8',
    walk_ins: 'dup__of_lunch_walk_ins',
  },
  lunch: {
    food_sales: 'dup__of_lunch_bev_sales',
    bev_sales: 'numbers19',
    service_charge: 'numeric8',
    covers: 'numbers2',
    discounts: 'dup__of_dinner_discounts',
    reservations: 'numbers98',
    cancellations: 'numbers22',
    reductions: 'numbers46',
    walk_ins: 'numbers8',
  },
  dinner: {
    food_sales: 'dup__of_lunch_sales',
    bev_sales: 'numbers86',
    service_charge: 'numeric3',
    covers: 'numbers833',
    discounts: 'numbers32',
    reservations: 'dup__of_lunch_res',
    cancellations: 'dup__of_lunch_cxl___ns',
    reductions: 'dup__of_lunch_reductions',
    walk_ins: 'numbers83',
  },
  total_sc_manual: 'numbers768',
  /**
   * "Notes for Finance" -- free text, one per day, where the venues explain
   * anything odd. This is where they have been answering our reconciliation
   * questions all along: Neon Pigeon wrote "Extra Items $84.00 For beverage"
   * on 1 Aug 2026, which was exactly the eighty-four dollars we could not
   * account for. Read it, do not make people ask.
   */
  finance_notes: 'text7',
} as const;

const VENUE_BOARDS: Record<string, { venueId: string; boards: number[] }> = {
  'neon-pigeon': {
    venueId: '30f4ec07-afc6-4bb4-ba7c-10375b4f68c5',
    boards: [18394773435],
  },
  'fat-prince': {
    venueId: 'c0d03a78-7d28-4a4a-a908-d1719110e881',
    boards: [18394771274],
  },
  'super-firangi': {
    venueId: 'a0838494-04a6-4f04-8c1f-a8a2e01a3c07',
    boards: [18394735035],
  },
};

const JUNK_NAMES = new Set(['bluesheets_21feb_lunch', 'test 2', 'new item']);

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  january: '01', february: '02', march: '03', april: '04',
  june: '06', july: '07', august: '08', september: '09',
  october: '10', november: '11', december: '12',
};

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function validOrNull(y: number, m: number, d: number): string | null {
  // A typo'd year (e.g. "2925") is a syntactically valid date, so reject
  // anything outside the business's plausible range and let the caller fall
  // back to the item's created_at instead.
  if (y < 2015 || y > new Date().getFullYear() + 1) return null;
  if (!isValidDate(y, m, d)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDate(raw: string): string | null {
  const s = raw.trim()
    .replace(/[–—]/g, '-')
    .replace(/\s*\(.*\)$/, '')
    .replace(/[,]+/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/-+(mon|tue|wed|thu|fri|sat|sun)\w*\.?$/i, '')
    .replace(/\s+(mon|tue|wed|thu|fri|sat|sun|thr)\w*\.?$/i, '')
    .replace(/\.+$/, '')
    .trim();

  let m: RegExpMatchArray | null;

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validOrNull(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  m = s.match(/^(\d{2})-(\d{2})(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  m = s.match(/^(\d{4})-(\d{2})(\d{2})$/);
  if (m) return validOrNull(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{2})\s+(\d{2})(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validOrNull(+m[3], +m[2], +m[1]);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) return validOrNull(2000 + +m[3], +m[2], +m[1]);

  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]+)[\s-](\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    let year = +m[3];
    if (year < 100) year = 2000 + year;
    return validOrNull(year, +month, +m[1]);
  }

  return null;
}

function parseNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function getCol(item: MondayItem, colId: string): number {
  return parseNum(item.column_values[colId]);
}

/**
 * A free-text note from the board, or null if it says nothing.
 *
 * Most days read "NA". Storing that makes every row look like it carries an
 * explanation and buries the handful that do -- the same failure as an alert
 * that is always on. Placeholders become null so a note means a note.
 */
export function cleanFinanceNote(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (!text) return null;
  if (/^(n\.?\/?a\.?|nil|none|no|-+|\.+)$/i.test(text)) return null;
  return text;
}

function getText(item: MondayItem, colId: string): string | null {
  return cleanFinanceNote(item.column_values[colId]);
}

function extractPeriod(item: MondayItem, period: 'brunch' | 'lunch' | 'dinner'): MealPeriodData {
  const cols = COLUMN_IDS[period];
  return {
    food_sales: getCol(item, cols.food_sales),
    bev_sales: getCol(item, cols.bev_sales),
    service_charge: getCol(item, cols.service_charge),
    covers: getCol(item, cols.covers),
    discounts: getCol(item, cols.discounts),
    reservations: getCol(item, cols.reservations),
    cancellations: getCol(item, cols.cancellations),
    reductions: getCol(item, cols.reductions),
    walk_ins: getCol(item, cols.walk_ins),
  };
}

function hasMealData(p: MealPeriodData): boolean {
  return p.food_sales !== 0 || p.bev_sales !== 0 || p.covers !== 0;
}

function deriveTotals(mealPeriods: Record<string, MealPeriodData>, totalScManual: number) {
  let totalFood = 0, totalBev = 0, totalSC = 0, totalCovers = 0, totalDiscounts = 0;
  for (const p of Object.values(mealPeriods)) {
    totalFood += p.food_sales;
    totalBev += p.bev_sales;
    totalSC += p.service_charge;
    totalCovers += p.covers;
    totalDiscounts += p.discounts;
  }
  const grossSales = Math.round((totalFood + totalBev) * 100) / 100;
  const effectiveSC = totalSC > 0 ? totalSC : totalScManual;
  const netSales = Math.round((grossSales - totalDiscounts + effectiveSC) * 100) / 100;
  return { grossSales, netSales, totalCovers, totalDiscounts, effectiveSC };
}

/**
 * A fingerprint of every figure on the day, for the audit trail.
 *
 * IT USED TO FINGERPRINT NOTHING BUT THE PERIOD NAMES. This was
 * `JSON.stringify(mealPeriods, Object.keys(mealPeriods).sort())`, and an array
 * passed as the second argument is an ALLOW-LIST applied at every depth -- so
 * `food_sales`, `bev_sales` and the rest were filtered out of the nested
 * objects and the input was `{"dinner":{},"lunch":{}}` whatever the figures
 * said. Every correction made on the board after Sauron first saw a day
 * hashed the same as the original, and the sync skipped it as unchanged, hourly,
 * for two months. Fat Prince 17 Aug sat at $1,744 of food against $6,468 on the
 * board. BUILD_LOG 1.12.
 *
 * The hash is now a RECORD, not the decision. Whether a day changed is decided
 * by comparing the figures themselves (`figuresChanged`), so a hash format
 * change -- this one included -- can never again make a day look edited or
 * unedited.
 */
export function hashMealPeriods(mealPeriods: Record<string, MealPeriodData>): string {
  const canonical = Object.keys(mealPeriods).sort().map(period => {
    const p = mealPeriods[period] as unknown as Record<string, number>;
    return [period, Object.keys(p).sort().map(k => [k, p[k]])];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Whether any figure on the day differs from what is stored.
 *
 * Compared value by value, to the cent, with the same rule the post-close alert
 * uses to describe the change -- one definition of "changed", so the decision
 * and the alert cannot disagree about whether anything moved.
 */
export function figuresChanged(
  stored: Record<string, Partial<MealPeriodData>> | null | undefined,
  incoming: Record<string, Partial<MealPeriodData>>,
): boolean {
  return summarisePostLockChange(stored, incoming).length > 0;
}

export interface FieldChange {
  period: string;
  field: string;
  from: number;
  to: number;
}

/**
 * What actually changed between a locked snapshot and the incoming data.
 *
 * A post-lock alert on its own says "something changed on 30 July" and leaves
 * a person to go and diff two boards by eye. The difference between a $2
 * service-charge correction and a $4,000 revenue edit is the difference
 * between ignoring it and investigating it, so the alert has to carry it.
 *
 * Fields present on one side only are reported against 0, because a meal
 * period appearing or disappearing is itself the change worth seeing.
 */
export function summarisePostLockChange(
  oldPeriods: Record<string, Partial<MealPeriodData>> | null | undefined,
  newPeriods: Record<string, Partial<MealPeriodData>> | null | undefined,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const periods = new Set([...Object.keys(oldPeriods ?? {}), ...Object.keys(newPeriods ?? {})]);

  for (const period of periods) {
    const before = (oldPeriods?.[period] ?? {}) as Record<string, number>;
    const after = (newPeriods?.[period] ?? {}) as Record<string, number>;
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const field of fields) {
      const from = Number(before[field] ?? 0);
      const to = Number(after[field] ?? 0);
      // Cent tolerance: floating point, not a real edit.
      if (Math.abs(from - to) > 0.005) changes.push({ period, field, from, to });
    }
  }

  // Largest movement first -- the one worth looking at is rarely the first
  // one alphabetically.
  return changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
}

export function reconcileMondayVsRevel(
  mondayGross: number,
  revelGross: number,
): ReconciliationResult {
  const difference = Math.round(Math.abs(mondayGross - revelGross) * 100) / 100;
  return {
    passed: difference === 0,
    mondayGross,
    revelGross,
    difference,
  };
}

async function raiseAlert(alert: {
  venue_id: string;
  business_date: string;
  alert_type: 'mismatch' | 'post_lock_change' | 'reconciliation_failed';
  monday_gross?: number;
  revel_gross?: number;
  difference?: number;
  old_hash?: string;
  new_hash?: string;
  old_meal_periods?: Record<string, MealPeriodData>;
  new_meal_periods?: Record<string, MealPeriodData>;
}): Promise<void> {
  // Do not raise a second alert for something already open.
  //
  // The Monday board still holds the changed value, so every hourly run
  // re-detects the same rows and would insert an identical alert -- three
  // unresolved days become dozens of rows a day, and the table stops being
  // something a human can read. One open alert per (venue, date, type) until
  // somebody resolves it.
  const { data: open } = await supabase
    .from('reconciliation_alerts')
    .select('id')
    .eq('venue_id', alert.venue_id)
    .eq('business_date', alert.business_date)
    .eq('alert_type', alert.alert_type)
    .eq('resolved', false)
    .limit(1);

  if (open && open.length > 0) return;

  const { error } = await supabase
    .from('reconciliation_alerts')
    .insert(alert);
  if (error) {
    console.error(`  [ALERT DB ERROR] ${error.message}`);
  }
}

export async function fetchBoardItems(
  boardId: number,
  apiToken: string,
): Promise<MondayItem[]> {
  const allItems: MondayItem[] = [];
  let cursor: string | null = null;
  const LIMIT = 500;

  while (true) {
    const gqlQuery = cursor
      ? `query ($boardId: [ID!]!, $limit: Int!, $cursor: String!) {
          boards(ids: $boardId) {
            items_page(limit: $limit, cursor: $cursor) {
              cursor
              items { id name created_at column_values { id text } }
            }
          }
        }`
      : `query ($boardId: [ID!]!, $limit: Int!) {
          boards(ids: $boardId) {
            items_page(limit: $limit) {
              cursor
              items { id name created_at column_values { id text } }
            }
          }
        }`;

    const variables: Record<string, unknown> = {
      boardId: [String(boardId)],
      limit: LIMIT,
    };
    if (cursor) variables.cursor = cursor;

    // Monday returns intermittent 500s ("Internal Server Error") that lose the
    // whole run. BUILD_LOG 1.4 added retry-with-backoff for upserts and this
    // fetch never got it -- the same lesson as 4.2: a fix applied at one call
    // site is not a fix. Retries are restricted to transient failures so a
    // genuine query or auth error still fails fast.
    const MAX_ATTEMPTS = 4;
    let json!: {
      data?: { boards: Array<{ items_page: { cursor: string | null; items: Array<{
        id: string; name: string; created_at: string;
        column_values: Array<{ id: string; text: string | null }>;
      }> } }> };
      errors?: Array<{ message: string }>;
    };

    for (let attempt = 1; ; attempt++) {
      let transient = false;
      let failure = '';

      try {
        const res = await fetch(MONDAY_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': apiToken,
            'API-Version': '2024-10',
          },
          body: JSON.stringify({ query: gqlQuery, variables }),
        });

        if (!res.ok) {
          failure = `Monday.com API error: ${res.status} ${await res.text()}`;
          transient = res.status >= 500 || res.status === 429;
        } else {
          json = await res.json() as typeof json;
          if (json.errors?.length) {
            failure = `Monday.com GraphQL error: ${json.errors[0].message}`;
            // Monday reports upstream faults inside a 200 as a GraphQL error,
            // so the status code alone does not identify them.
            transient = /internal server error|timeout|temporarily/i.test(json.errors[0].message);
          }
        }
      } catch (e: any) {
        failure = `Monday.com request failed: ${e.message}`;
        transient = true; // network-level: no response was seen at all
      }

      if (!failure) break;
      if (!transient || attempt === MAX_ATTEMPTS) {
        throw new Error(`${failure}${transient ? ` (after ${MAX_ATTEMPTS} attempts)` : ''}`);
      }
      await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }

    const page = json.data!.boards[0].items_page;
    for (const item of page.items) {
      const colMap: MondayColumnValues = {};
      for (const cv of item.column_values) {
        colMap[cv.id] = cv.text;
      }
      allItems.push({
        id: item.id,
        name: item.name,
        created_at: item.created_at,
        column_values: colMap,
      });
    }

    cursor = page.cursor;
    if (!cursor || page.items.length < LIMIT) break;
  }

  return allItems;
}

export async function ingestMondayItems(
  venueSlug: string,
  items: MondayItem[],
  options: { dryRun?: boolean } = {},
): Promise<IngestionResult[]> {
  const config = VENUE_BOARDS[venueSlug];
  if (!config) throw new Error(`Unknown venue: ${venueSlug}`);
  const { venueId } = config;
  const results: IngestionResult[] = [];

  for (const item of items) {
    if (JUNK_NAMES.has(item.name.toLowerCase().trim())) continue;

    let date = parseDate(item.name);
    if (!date) {
      date = item.created_at.substring(0, 10);
    }

    const year = parseInt(date.substring(0, 4));
    if (year <= 2021) continue;

    const brunch = extractPeriod(item, 'brunch');
    const lunch = extractPeriod(item, 'lunch');
    const dinner = extractPeriod(item, 'dinner');

    const mealPeriods: Record<string, MealPeriodData> = {};
    if (hasMealData(brunch)) mealPeriods.brunch = brunch;
    if (hasMealData(lunch)) mealPeriods.lunch = lunch;
    if (hasMealData(dinner)) mealPeriods.dinner = dinner;

    if (Object.keys(mealPeriods).length === 0) continue;

    const totalScManual = getCol(item, COLUMN_IDS.total_sc_manual);
    const financeNotes = getText(item, COLUMN_IDS.finance_notes);
    const totals = deriveTotals(mealPeriods, totalScManual);
    // Deliberately excludes the note: adding an explanation is not a change to
    // the figures and must never read as one.
    const newHash = hashMealPeriods(mealPeriods);

    const { data: existing } = await supabase
      .from('daily_operations')
      .select('id, data_source, gross_sales, locked_at, meal_periods_hash, meal_periods, finance_notes')
      .eq('venue_id', venueId)
      .eq('business_date', date)
      .maybeSingle();

    // ── CLOSED PERIOD: reject changes, raise alert if data differs ──
    //
    // The gate is the accounting close, not `locked_at`. Locking on the first
    // exact match against Revel froze whatever we held at that instant and made
    // the venue's own later corrections unreachable -- the board got fixed, we
    // kept the wrong figure forever, and the alert said only that the two now
    // disagreed. BUILD_LOG 2.5.
    //
    // Only an EXISTING row is frozen. A closed month with no row at all is a
    // gap, and filling a gap is not the same as changing a settled figure.
    if (existing && isPeriodClosed(date)) {
      // Decided on the FIGURES, never the stored hash. Every closed day carries
      // a hash from the broken format, and comparing against it would raise a
      // "changed after close" alert for the whole of history on the first run.
      if (figuresChanged(existing.meal_periods, mealPeriods)) {
        // A person already looked at exactly this edit and decided to keep
        // Sauron's figures. Raising it again every hour would undo their
        // decision -- the reason Neon Pigeon 30 Jul reached 83 copies. A
        // further edit to the board is new, and is raised.
        // row-cap: the resolved alerts for one day of one venue.
        const { data: decided } = await supabase
          .from('reconciliation_alerts')
          .select('new_meal_periods')
          .eq('venue_id', venueId)
          .eq('business_date', date)
          .eq('alert_type', 'post_lock_change')
          .eq('resolved', true);
        if (alreadyDismissed(decided ?? [], mealPeriods)) continue;

        if (!options.dryRun) {
          await raiseAlert({
            venue_id: venueId,
            business_date: date,
            alert_type: 'post_lock_change',
            old_hash: existing.meal_periods_hash,
            new_hash: newHash,
            old_meal_periods: existing.meal_periods,
            new_meal_periods: mealPeriods,
          });
        }
        results.push({
          venue: venueSlug, date, action: 'blocked',
          error: `${date} is in a closed period (final from ${closeDateFor(date)}) — incoming data differs (alert raised)`,
        });
      }
      // Same hash = no change, nothing to do
      continue;
    }

    let action: IngestionResult['action'];
    let reconciliation: ReconciliationResult | undefined;

    if (existing && existing.data_source === 'revel') {
      // ── MERGE: Revel row exists, add meal periods ──
      reconciliation = (existing.gross_sales && totals.grossSales > 0)
        ? reconcileMondayVsRevel(totals.grossSales, existing.gross_sales)
        : undefined;

      if (!options.dryRun) {
        const updateData: Record<string, unknown> = {
          meal_periods: mealPeriods,
          meal_periods_hash: newHash,
          finance_notes: financeNotes,
          data_source: 'both',
        };

        // Lock if reconciliation passes (exact match)
        if (reconciliation?.passed) {
          updateData.locked_at = new Date().toISOString();
        }

        const { error } = await supabase
          .from('daily_operations')
          .update(updateData)
          .eq('id', existing.id);

        if (error) {
          results.push({ venue: venueSlug, date, action: 'skipped', reconciliation, error: error.message });
          continue;
        }

        // Only once Finance has had working days to reconcile it. A Friday
        // compared on Saturday disagrees because nobody has looked at it yet.
        if (reconciliation && !reconciliation.passed && isSettled(date)) {
          await raiseAlert({
            venue_id: venueId,
            business_date: date,
            alert_type: 'reconciliation_failed',
            monday_gross: reconciliation.mondayGross,
            revel_gross: reconciliation.revelGross,
            difference: reconciliation.difference,
          });
        }
      }
      action = reconciliation?.passed ? 'locked' : 'merged';

    } else if (existing && (existing.data_source === 'monday' || existing.data_source === 'both')) {
      // ── UPDATE: Monday/both row exists — overwrite meal periods ──
      if (!figuresChanged(existing.meal_periods, mealPeriods)) {
        // The figures have not moved, but the note may have. Someone writing an
        // explanation days later is exactly when we most want it, so it is
        // stored on its own rather than waiting for a figure to change.
        if (!options.dryRun && (existing.finance_notes ?? null) !== financeNotes) {
          await supabase
            .from('daily_operations')
            .update({ finance_notes: financeNotes })
            .eq('id', existing.id);
        }
        continue;
      }

      if (!options.dryRun) {
        const updateData: Record<string, unknown> = {
          meal_periods: mealPeriods,
          meal_periods_hash: newHash,
          finance_notes: financeNotes,
        };

        if (existing.data_source === 'monday') {
          updateData.gross_sales = totals.grossSales || null;
          updateData.net_sales = totals.netSales || null;
          updateData.item_discounts = totals.totalDiscounts;
          updateData.taxed_service_fee = totals.effectiveSC;
          updateData.total_guests = totals.totalCovers || null;
        }

        // If data_source is 'both', try reconciliation for locking
        if (existing.data_source === 'both' && existing.gross_sales && totals.grossSales > 0) {
          reconciliation = reconcileMondayVsRevel(totals.grossSales, existing.gross_sales);
          if (reconciliation.passed) {
            updateData.locked_at = new Date().toISOString();
          } else if (isSettled(date)) {
            // Only once Finance has had working days to reconcile it. Before
            // that a difference is expected, not a finding -- see isSettled.
            await raiseAlert({
              venue_id: venueId,
              business_date: date,
              alert_type: 'reconciliation_failed',
              monday_gross: reconciliation.mondayGross,
              revel_gross: reconciliation.revelGross,
              difference: reconciliation.difference,
            });
          }
        }

        const { error } = await supabase
          .from('daily_operations')
          .update(updateData)
          .eq('id', existing.id);

        if (error) {
          results.push({ venue: venueSlug, date, action: 'skipped', error: error.message });
          continue;
        }
      }
      action = (reconciliation?.passed) ? 'locked' : 'updated';

    } else {
      // ── INSERT: no existing row ──
      if (!options.dryRun) {
        const { error } = await supabase
          .from('daily_operations')
          .insert({
            venue_id: venueId,
            business_date: date,
            gross_sales: totals.grossSales || null,
            net_sales: totals.netSales || null,
            item_discounts: totals.totalDiscounts,
            taxed_service_fee: totals.effectiveSC,
            total_guests: totals.totalCovers || null,
            meal_periods: mealPeriods,
            meal_periods_hash: newHash,
            finance_notes: financeNotes,
            data_source: 'monday',
          });

        if (error) {
          results.push({ venue: venueSlug, date, action: 'skipped', error: error.message });
          continue;
        }
      }
      action = 'inserted';
    }

    results.push({ venue: venueSlug, date, action, reconciliation });
  }

  return results;
}

/**
 * Has a person already dismissed exactly this board edit?
 *
 * A "changed after close" alert compares the board with what Sauron holds, and
 * resolving it changes neither -- so without this, the next hourly run raises
 * it again. Matched on the FIGURES of the edit that was dismissed.
 */
export function alreadyDismissed(
  resolved: Array<{ new_meal_periods: unknown }>,
  incoming: Record<string, MealPeriodData>,
): boolean {
  return resolved.some(r => r.new_meal_periods && !figuresChanged(r.new_meal_periods as any, incoming));
}

/**
 * Take a closed day's board edit into Sauron, on a person's say-so.
 *
 * Closed months are not overwritten by the sync (BUILD_LOG 2.5, 1.12): an edit
 * after close becomes an alert instead, to be applied DELIBERATELY. This is that
 * deliberate step. It writes what an open-month update would have written --
 * the meal periods, and for a board-only day the totals derived from them --
 * and resolves every copy of the alert, so the next sync finds nothing to say.
 */
export async function applyPostLockChange(
  alertId: string,
  resolvedBy: string | null,
  notes: string | null,
): Promise<{ venue_id: string; business_date: string; resolved: number }> {
  const { data: alert, error } = await supabase
    .from('reconciliation_alerts')
    .select('venue_id, business_date, alert_type, new_meal_periods')
    .eq('id', alertId)
    .single();
  if (error || !alert) throw new Error('Alert not found');
  if (alert.alert_type !== 'post_lock_change' || !alert.new_meal_periods) {
    throw new Error('Only a "changed after close" alert carries board figures to apply');
  }

  // The NEWEST copy carries the board as it stands; a card groups copies raised
  // at different times, and the one it points at may hold an earlier edit.
  // row-cap: the alerts for one day of one venue; top-1.
  const { data: latest } = await supabase
    .from('reconciliation_alerts')
    .select('new_meal_periods')
    .eq('venue_id', alert.venue_id)
    .eq('business_date', alert.business_date)
    .eq('alert_type', 'post_lock_change')
    .order('created_at', { ascending: false })
    .limit(1);
  const mealPeriods = ((latest?.[0]?.new_meal_periods) ?? alert.new_meal_periods) as Record<string, MealPeriodData>;
  const { data: row } = await supabase
    .from('daily_operations')
    .select('id, data_source, taxed_service_fee')
    .eq('venue_id', alert.venue_id)
    .eq('business_date', alert.business_date)
    .maybeSingle();
  if (!row) throw new Error(`No stored day for ${alert.business_date}`);

  const update: Record<string, unknown> = {
    meal_periods: mealPeriods,
    meal_periods_hash: hashMealPeriods(mealPeriods),
  };
  if (row.data_source === 'monday') {
    // Board-only day: the sales figures come from the board, so they move too.
    const totals = deriveTotals(mealPeriods, Number(row.taxed_service_fee ?? 0));
    update.gross_sales = totals.grossSales || null;
    update.net_sales = totals.netSales || null;
    update.item_discounts = totals.totalDiscounts;
    update.taxed_service_fee = totals.effectiveSC;
    update.total_guests = totals.totalCovers || null;
  }
  const { error: writeError } = await supabase.from('daily_operations').update(update).eq('id', row.id);
  if (writeError) throw new Error(writeError.message);

  const { data: done, error: resolveError } = await supabase
    .from('reconciliation_alerts')
    .update({
      resolved: true,
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
      notes: 'Applied: the board\'s corrected figures were written to Sauron.' + (notes ? ' ' + notes : ''),
    })
    .eq('venue_id', alert.venue_id)
    .eq('business_date', alert.business_date)
    .eq('alert_type', 'post_lock_change')
    .eq('resolved', false)
    .select('id');
  if (resolveError) throw new Error(resolveError.message);

  return { venue_id: alert.venue_id, business_date: alert.business_date, resolved: done?.length ?? 0 };
}

export function getVenueBoards(): typeof VENUE_BOARDS {
  return VENUE_BOARDS;
}

/**
 * Every run, re-compare the recent days -- not only the ones whose board changed.
 *
 * A day that differs gets ONE open `reconciliation_failed` alert (raiseAlert
 * de-duplicates). A day that agrees again -- usually because somebody has
 * re-uploaded the day's Revel report -- has its open alert resolved here, so
 * the list holds only what still needs doing and nobody has to remember to
 * clear it. See src/lib/revel-drift.ts for why the board is the witness.
 */
export async function sweepRevelDrift(asOf: Date = new Date()): Promise<{ differ: number; resolved: number }> {
  const since = new Date(asOf.getTime() - DRIFT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  const { data: rows, error } = await selectAll(() => supabase
    .from('daily_operations')
    .select('venue_id, business_date, gross_sales, meal_periods')
    .eq('data_source', 'both')
    .gte('business_date', since));
  if (error) throw new Error(`revel drift sweep: ${error.message}`);

  const { differ, agree } = revelBoardDrift(rows as any[], asOf);

  const { data: alerts, error: alertError } = await selectAll(() => supabase
    .from('reconciliation_alerts')
    .select('id, venue_id, business_date, resolved, monday_gross, revel_gross')
    .eq('alert_type', 'reconciliation_failed')
    .gte('business_date', since));
  if (alertError) throw new Error(`revel drift sweep: ${alertError.message}`);
  const open = alerts.filter((a: any) => !a.resolved);
  const resolved = alerts.filter((a: any) => a.resolved);
  const openByDay = new Map(open.map((o: any) => [`${o.venue_id}|${o.business_date}`, o.id]));

  for (const d of differ) {
    const existing = openByDay.get(`${d.venue_id}|${d.business_date}`);
    // Somebody already resolved this exact difference -- leave their decision be.
    if (!existing && alreadyDecided(d, resolved)) continue;
    if (existing) {
      // Kept CURRENT, and filled in where an older alert was raised without the
      // figures. An alert that says "$67" and not of what against what cannot be
      // acted on -- Khai, 6 Oct 2026: "how to reconcile anything when there is
      // no reference".
      await supabase.from('reconciliation_alerts')
        .update({ monday_gross: d.monday_gross, revel_gross: d.revel_gross, difference: d.difference })
        .eq('id', existing);
      continue;
    }
    await raiseAlert({
      venue_id: d.venue_id,
      business_date: d.business_date,
      alert_type: 'reconciliation_failed',
      monday_gross: d.monday_gross,
      revel_gross: d.revel_gross,
      difference: d.difference,
    });
  }

  const agreeing = new Set(agree.map(a => `${a.venue_id}|${a.business_date}`));
  const toResolve = open.filter((o: any) => agreeing.has(`${o.venue_id}|${o.business_date}`)).map((o: any) => o.id);
  if (toResolve.length > 0) {
    const { error: resolveError } = await supabase
      .from('reconciliation_alerts')
      .update({
        resolved: true,
        resolved_at: asOf.toISOString(),
        notes: 'Resolved automatically: Revel and the Monday board now agree to the cent.',
      })
      .in('id', toResolve);
    if (resolveError) console.error(`  [ALERT DB ERROR] ${resolveError.message}`);
  }

  return { differ: differ.length, resolved: toResolve.length };
}
