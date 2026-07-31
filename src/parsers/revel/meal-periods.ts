import type { HourlySalesData, MealPeriodSummary } from './types.js';

// Before 5pm (hours 0-16) = lunch/brunch
// 5pm onwards (hours 17-23, 0-2 next day) = dinner
const DINNER_START = 17; // 5pm

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
    if (h.hour < DINNER_START) {
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
