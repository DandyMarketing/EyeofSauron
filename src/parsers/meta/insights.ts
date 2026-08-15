/**
 * Meta Insights response normaliser.
 *
 * Turns Meta's per-metric time series into one row per (date, metric), keyed
 * to the day the figure actually describes.
 *
 * THE DATE IS THE DANGEROUS PART. Meta returns each daily value with an
 * `end_time`, and end_time is the *end* of the window -- the figure for
 * Monday arrives stamped with Tuesday's timestamp. Storing it verbatim shifts
 * every metric forward by a day, which is invisible in isolation and
 * catastrophic in a join: a campaign's reach would line up against the wrong
 * night's covers, and the correlation would look real. That is the same class
 * of defect as the UTC weekday bug in charts.ts, with a worse blast radius
 * because it is cross-source.
 */

export interface InsightRow {
  business_date: string;
  metric: string;
  value: number;
}

interface MetaValue { value?: unknown; end_time?: string }
interface MetaMetric { name?: string; period?: string; values?: MetaValue[] }

/**
 * The day a value describes, given Meta's end_time.
 *
 * end_time marks the close of the period, so a daily figure is stamped with
 * the following day. Subtract one day to get the day it covers.
 *
 * Computed in UTC deliberately: `new Date('2026-08-10T07:00:00+0000')` read
 * back with local getters shifts the date on any server not on UTC, which is
 * exactly the bug this function exists to avoid reintroducing.
 */
export function dayFromEndTime(endTime: string): string | null {
  const t = Date.parse(endTime);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Meta sends numbers, numeric strings, and occasionally objects for structured metrics. */
export function coerceValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  // A breakdown object (by age, by country) is not a daily scalar. Skipped
  // rather than flattened to a wrong single number.
  return null;
}

/**
 * Normalise an Insights payload.
 *
 * Unreadable entries are skipped rather than defaulted. A metric that silently
 * becomes 0 reads as "no reach that day", which is a finding about the
 * business rather than a parsing failure -- the exact mistake recorded in
 * BUILD_LOG 1.1.
 */
export function normaliseInsights(payload: any): InsightRow[] {
  const metrics: MetaMetric[] = payload?.data ?? [];
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new Error('Meta insights response contained no data array — treating as a failed fetch, not an empty day');
  }

  const rows: InsightRow[] = [];
  for (const metric of metrics) {
    const name = (metric.name ?? '').trim();
    if (!name) continue;
    // Only daily series belong in social_daily. A lifetime or 28-day metric
    // stored against a single date would be read as that day's figure.
    if (metric.period && metric.period !== 'day') continue;

    for (const entry of metric.values ?? []) {
      if (!entry.end_time) continue;
      const date = dayFromEndTime(entry.end_time);
      const value = coerceValue(entry.value);
      if (date === null || value === null) continue;
      rows.push({ business_date: date, metric: name, value });
    }
  }

  if (rows.length === 0) {
    throw new Error('Meta insights response parsed to zero usable rows — treating as a failed fetch');
  }
  return rows;
}

/**
 * Days in the requested range that came back with nothing.
 *
 * Surfaced rather than inferred. Stories metrics expire from Meta after about
 * 24 hours and cannot be backfilled, so a gap here is permanent -- it needs to
 * be visible at the time it happens, not discovered months later when someone
 * asks why a week looks quiet.
 */
export function missingDays(rows: InsightRow[], fromDate: string, toDate: string): string[] {
  const present = new Set(rows.map(r => r.business_date));
  const missing: string[] = [];
  for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (!present.has(day)) missing.push(day);
  }
  return missing;
}
