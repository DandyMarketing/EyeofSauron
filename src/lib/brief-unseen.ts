/**
 * How many items in the weekly brief this person has not opened yet -- the
 * number on the "Weekly brief" menu link (Khai, 13 Oct 2026: "no one actually
 * knows it's there").
 *
 * Pure: the caller passes the recommendations this reader is ALLOWED to see,
 * already filtered by venue and role exactly as the brief page filters them,
 * so the badge can never count something the page would withhold.
 *
 * Only the LATEST week counts. Advice from a month ago is not news, and a new
 * person who has never opened the brief should see this week's number, not
 * the whole archive. Dismissed advice is not counted: somebody already
 * decided it was not worth reading.
 */
export interface BriefItem { period_end: string; generated_at: string; status?: string | null }

export function unseenCount(items: BriefItem[], seenAt: string | null): number {
  if (!items.length) return 0;
  const latest = items.reduce((m, r) => (r.period_end > m ? r.period_end : m), items[0].period_end);
  const seen = seenAt ? Date.parse(seenAt) : NaN;
  return items.filter(r =>
    r.period_end === latest &&
    r.status !== 'dismissed' &&
    (Number.isNaN(seen) || Date.parse(r.generated_at) > seen),
  ).length;
}
