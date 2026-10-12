import type { HourlySalesData, MealPeriodSummary } from './types.js';

// 6am to 4:59pm = lunch/brunch
// 5pm onwards, through midnight to 5:59am = dinner
const DINNER_START = 17; // 5pm

/**
 * Where a business day begins, in clock hours.
 *
 * REVEL'S BUSINESS DAY RUNS PAST MIDNIGHT. Neon Pigeon's 10 Oct 2026 report
 * carries 12 AM and 1 AM rows ($214 and $14) and its 11 Oct report carries
 * none: the Saturday shift's last bills, filed under Saturday. So an hour
 * before this is the END of the shift, not the start of the day.
 *
 * Stored as clock hours 0-23, those rows sorted FIRST -- before lunch -- and
 * the hour list appeared to stop at 11 PM (Khai, 12 Oct 2026: "the sales
 * figures stops at 12am never beyond that"). They were also labelled lunch,
 * because 1 AM is before 5 PM, though this file's own comment said dinner.
 * No venue trades between 6 AM and its lunch service, so 6 AM is a safe line.
 */
export const SERVICE_DAY_START = 6;

/** Clock hour -> position in the shift: 12 AM-5 AM come after 11 PM. */
export function serviceOrder(hour: number): number {
  return hour < SERVICE_DAY_START ? hour + 24 : hour;
}

/** Lunch side of the day, or dinner (which runs on past midnight). */
export function isDaytime(hour: number): boolean {
  return hour >= SERVICE_DAY_START && hour < DINNER_START;
}

interface MealPeriodConfig {
  venueSlug: string;
  businessDate: string; // YYYY-MM-DD
}

function getDayOfWeek(dateStr: string): number {
  const d = new Date(dateStr + 'T12:00:00');
  return d.getDay(); // 0=Sun, 6=Sat
}

function getLunchLabel(config: MealPeriodConfig): 'lunch' | 'brunch' {
  const dow = getDayOfWeek(config.businessDate);
  const isSat = dow === 6;
  const isSun = dow === 0;

  if (config.venueSlug === 'fat-prince' && (isSat || isSun)) return 'brunch';
  if (config.venueSlug === 'super-firangi' && isSat) return 'brunch';

  return 'lunch';
}

export function deriveMealPeriods(
  data: HourlySalesData,
  config: MealPeriodConfig,
): MealPeriodSummary[] {
  const lunchLabel = getLunchLabel(config);

  let lunchTx = 0, lunchItems = 0, lunchSales = 0;
  let dinnerTx = 0, dinnerItems = 0, dinnerSales = 0;

  for (const h of data.hours) {
    if (isDaytime(h.hour)) {
      lunchTx += h.transactions;
      lunchItems += h.items;
      lunchSales += h.sales;
    } else {
      dinnerTx += h.transactions;
      dinnerItems += h.items;
      dinnerSales += h.sales;
    }
  }

  const totalSales = lunchSales + dinnerSales;
  const periods: MealPeriodSummary[] = [];

  if (lunchTx > 0 || lunchSales > 0) {
    periods.push({
      period: lunchLabel,
      transactions: lunchTx,
      items: lunchItems,
      sales: lunchSales,
      pctSales: totalSales > 0 ? Number((lunchSales / totalSales * 100).toFixed(1)) : 0,
      avgCheck: lunchTx > 0 ? Number((lunchSales / lunchTx).toFixed(2)) : null,
    });
  }

  if (dinnerTx > 0 || dinnerSales > 0) {
    periods.push({
      period: 'dinner',
      transactions: dinnerTx,
      items: dinnerItems,
      sales: dinnerSales,
      pctSales: totalSales > 0 ? Number((dinnerSales / totalSales * 100).toFixed(1)) : 0,
      avgCheck: dinnerTx > 0 ? Number((dinnerSales / dinnerTx).toFixed(2)) : null,
    });
  }

  return periods;
}
