/**
 * Watching the booking channels, because one of them died for four months and
 * nobody saw it.
 *
 * Measured 26 Aug 2026 at Neon Pigeon. Google Reserve ran 86 bookings in
 * January 2025, then 43, then 5, then 1. The booking widget ran 186, then 133,
 * then 32, then 24, then 14. Both online paths, together, from February to
 * June. Total bookings fell from an average of 481 a month to 391 and new
 * guests from ~272 to ~208 -- roughly 360 lost bookings, cushioned only because
 * business shifted to the phone and to landing pages.
 *
 * It was not hidden. Nobody was looking at booking channel by month, so there
 * was nothing for it to be hidden from. A week-on-week comparison would never
 * have caught it either: a 20% decline spread across four months is invisible
 * at that resolution, which is why this checks a MONTH against a trailing
 * baseline rather than against last week.
 *
 * WHY MEDIAN AND NOT MEAN for the baseline. One exceptional month -- a
 * festive December, a venue takeover -- drags a mean and hides the next real
 * drop underneath it. The same reason query_post_patterns ranks by median.
 *
 * WHY THE CURRENT MONTH MUST BE COMPLETE. A part-month always looks like a
 * collapse, and an alarm that cries wolf on the 3rd of every month is one
 * nobody reads by March. Same rule as lastCompleteWeek().
 */

/** A channel's bookings in one month at one venue. */
export interface ChannelMonth {
  month: string;
  channel: string;
  bookings: number;
}

export interface ChannelAlert {
  channel: string;
  month: string;
  bookings: number;
  /** Median of the trailing months, which is what "normal" means here. */
  baseline: number;
  drop_pct: number;
  severity: 'collapsed' | 'down';
}

/**
 * Below this, a channel is not worth alarming about.
 *
 * A channel that normally carries eight bookings a month can halve for
 * completely ordinary reasons, and an alert on it is noise that trains people
 * to ignore the ones that matter.
 */
export const MATERIAL_MONTHLY_BOOKINGS = 20;

/** Half of normal. Big enough to be real, small enough to catch it early. */
export const DOWN_RATIO = 0.5;

/** Effectively gone. Google hit 1 against a baseline near 90. */
export const COLLAPSED_RATIO = 0.15;

/** How many months of history define "normal". */
export const BASELINE_MONTHS = 6;

/**
 * The last month that has actually finished.
 *
 * A month in progress is always down on its own baseline, because it is not
 * over yet.
 */
export function lastCompleteMonth(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`lastCompleteMonth: "${today}" is not a date`);

  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().split('T')[0];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Collapse two labels for one channel into one channel.
 *
 * NOT tidiness -- it is the difference between an alert and a false alarm.
 * SevenRooms renamed "Google" to "Google Reserve Integration" partway through
 * the period, and compared raw the old label falls from 519 to 24 while a new
 * one appears from nowhere. That reads as a channel dying and is a channel
 * being relabelled. Exactly the account_map problem: the same thing under two
 * names must be mapped, never compared as written.
 *
 * Deliberately conservative -- only families that are large enough to matter
 * and unambiguous enough to be safe. Everything else keeps its own name and is
 * filtered out by the materiality floor if it is small.
 */
export function normaliseChannel(bookedBy: string | null | undefined, isWalkIn: boolean): string {
  if (isWalkIn) return 'Walk In';

  const raw = (bookedBy ?? '').trim();
  if (!raw) return 'Unknown';

  const lower = raw.toLowerCase();
  if (lower.includes('google')) return 'Google';
  if (lower.includes('widget')) return 'Booking Widget';
  if (lower.includes('landing page')) return 'Landing Page';
  if (lower.startsWith('online menu')) return 'Online Menu';

  return raw;
}

/**
 * Channels that have fallen off a cliff in the given month.
 *
 * Returns an empty array when everything is normal, which is the usual and
 * correct outcome -- a monitor that always has something to say is one nobody
 * believes, the same argument as the recommendation engine's permission to
 * report a quiet week.
 */
export function channelAlerts(rows: ChannelMonth[], month: string): ChannelAlert[] {
  const byChannel = new Map<string, ChannelMonth[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channel) ?? [];
    list.push(row);
    byChannel.set(row.channel, list);
  }

  const alerts: ChannelAlert[] = [];

  for (const [channel, months] of byChannel) {
    const current = months.find(m => m.month === month);
    if (!current) continue;

    // Strictly before, most recent first, capped at the baseline length.
    const trailing = months
      .filter(m => m.month < month)
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, BASELINE_MONTHS)
      .map(m => m.bookings);

    // Fewer than half a baseline is not enough history to call anything
    // abnormal -- a new channel is not a broken one.
    if (trailing.length < Math.ceil(BASELINE_MONTHS / 2)) continue;

    const baseline = median(trailing);
    if (baseline < MATERIAL_MONTHLY_BOOKINGS) continue;

    const ratio = current.bookings / baseline;
    if (ratio >= DOWN_RATIO) continue;

    alerts.push({
      channel,
      month,
      bookings: current.bookings,
      baseline,
      drop_pct: Math.round((1 - ratio) * 1000) / 10,
      severity: ratio <= COLLAPSED_RATIO ? 'collapsed' : 'down',
    });
  }

  // Worst first: a collapse outranks a decline, then by how much was lost.
  return alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'collapsed' ? -1 : 1;
    return (b.baseline - b.bookings) - (a.baseline - a.bookings);
  });
}

/**
 * What an alert means, in words, including the thing that is easy to get wrong.
 *
 * A channel at zero is more often an integration that broke than demand that
 * vanished, and saying so points the first hour of investigation in the right
 * direction. It is also worth naming the alternative -- a rename -- because
 * this system has already seen one.
 */
export function describeAlert(alert: ChannelAlert): string {
  const scale = alert.severity === 'collapsed'
    ? `has all but stopped — ${alert.bookings} against a normal ${alert.baseline}`
    : `is down ${alert.drop_pct}% — ${alert.bookings} against a normal ${alert.baseline}`;

  const cause = alert.severity === 'collapsed'
    ? ' A channel at or near zero is usually an integration that broke or a listing that was taken down, not demand disappearing. Check that it still works before looking for a market explanation — and check it has not simply been renamed, which has happened here before.'
    : '';

  return `${alert.channel} ${scale} in ${alert.month}.${cause}`;
}
