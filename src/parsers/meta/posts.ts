/**
 * Turning Meta's media responses into rows, without the network.
 *
 * Kept separate from the fetching so the awkward parts -- which day a late
 * post belongs to, which metrics a media type actually carries -- can be
 * tested against real shapes rather than reasoned about.
 */

/** Singapore is UTC+8, and a trading day starts at 3am, matching Revel. */
const SGT_OFFSET_HOURS = 8;
const DAY_STARTS_AT_HOUR = 3;

export interface PostRow {
  post_id: string;
  published_at: string;
  business_date: string;
  media_type: string | null;
  permalink: string | null;
  caption: string | null;
  metrics: Record<string, number>;
}

/**
 * The trading day a timestamp belongs to.
 *
 * A post at 1am Sunday belongs to SATURDAY: that is the service it came out
 * of, and it is the night whose covers and revenue it should sit beside.
 * Filing it on Sunday would put the busiest posts of the week against the
 * quietest trading day, and the correlation would read backwards.
 */
export function businessDateOf(publishedAt: string): string {
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) {
    throw new Error(`businessDateOf: unreadable timestamp ${JSON.stringify(publishedAt)}`);
  }
  const shifted = t + (SGT_OFFSET_HOURS - DAY_STARTS_AT_HOUR) * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * Metrics out of an insights response, keyed by Meta's own names.
 *
 * Handles both shapes it returns: `values[0].value` for a plain series and
 * `total_value.value` for the aggregate form. A metric it did not report is
 * simply absent -- storing zero would claim a post got no saves when the truth
 * is that Meta does not report saves for that media type.
 */
export function metricsFrom(insights: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of insights?.data ?? []) {
    if (typeof entry?.name !== 'string') continue;
    const direct = entry?.values?.[0]?.value;
    const total = entry?.total_value?.value;
    const value = typeof direct === 'number' ? direct : typeof total === 'number' ? total : null;
    if (value !== null) out[entry.name] = value;
  }
  return out;
}

/**
 * One media item into a row. Null when it has nothing usable -- an item with no
 * id or no timestamp cannot be stored or joined to anything.
 */
export function toPostRow(media: any, metrics: Record<string, number> = {}): PostRow | null {
  if (!media?.id || !media?.timestamp) return null;

  let business_date: string;
  try {
    business_date = businessDateOf(media.timestamp);
  } catch {
    return null;
  }

  return {
    post_id: String(media.id),
    published_at: new Date(media.timestamp).toISOString(),
    business_date,
    media_type: typeof media.media_type === 'string' ? media.media_type : null,
    permalink: typeof media.permalink === 'string' ? media.permalink : null,
    // Captions are long and people paste whole menus into them. Enough to
    // recognise which post is meant, not enough to bloat every query.
    caption: typeof media.caption === 'string' ? media.caption.slice(0, 2000) : null,
    metrics,
  };
}

/**
 * Which media in a page still need an insights call.
 *
 * The listing is one call for up to a hundred posts; insights are one call
 * EACH. So this is the whole cost of a post backfill, and getting it wrong in
 * either direction hurts: fetch too much and Meta blocks the app again, fetch
 * too little and the warehouse holds posts with no numbers on them.
 *
 * Two reasons to fetch, and a post only has to satisfy one:
 *
 * - we have no usable metrics for it, whether because it is new or because an
 *   earlier attempt came back empty; or
 * - it is younger than the refresh cutoff, so its figures are still moving and
 *   whatever we stored is already out of date.
 *
 * Everything else has settled and we already have it. Re-reading a two-year-old
 * post cannot change a number.
 */
export function selectForInsights(
  items: any[],
  haveMetricsFor: Set<string>,
  refreshCutoffIso: string,
): any[] {
  return items.filter(item => {
    if (!item?.id || !item?.timestamp) return false;
    if (!haveMetricsFor.has(String(item.id))) return true;
    return new Date(item.timestamp).toISOString() >= refreshCutoffIso;
  });
}

/**
 * Whether paging has reached far enough back to stop.
 *
 * Meta returns media newest first, so the moment a page contains anything older
 * than the cutoff, every later page is older still. An empty page also means
 * stop -- it is the account running out of history, which is the ordinary end
 * of a backfill rather than a fault.
 */
export function pageReachesBack(items: any[], cutoffIso: string): boolean {
  if (items.length === 0) return true;
  return items.some(item => {
    if (!item?.timestamp) return false;
    const t = new Date(item.timestamp).getTime();
    return !Number.isNaN(t) && new Date(t).toISOString() < cutoffIso;
  });
}

/**
 * Which metrics to ask for, by media type.
 *
 * Asking a still image for video views fails the whole request, and Meta
 * rejects an entire insights call when one metric does not apply -- the same
 * trap as the account-level metrics. So the list is narrowed per type rather
 * than sent hopefully.
 */
export function metricsForMediaType(mediaType: string | null): string[] {
  const common = ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'];
  switch (mediaType) {
    case 'VIDEO':
    case 'REELS':
      return [...common, 'views'];
    case 'CAROUSEL_ALBUM':
    case 'IMAGE':
    default:
      return common;
  }
}
