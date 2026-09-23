/**
 * Part-to-whole: what something is MADE of, and whether that is changing.
 *
 * WHY IT IS A SEPARATE SHAPE FROM A TIME SERIES. Everything `create_chart`
 * drew until now was one number over time -- net sales by week, covers by
 * month. The questions the briefings had moved on to are not that shape at all:
 * where guests came from, how many were on their second visit, which booking
 * channel carried the month. Those are categories summing to a whole, and there
 * was no way to draw one, so the engine drew nothing. A briefing with no visual
 * is what sent somebody looking.
 *
 * ONE DATA SHAPE, TWO PICTURES. A pie is a single bucket; a hundred-percent
 * stacked bar is the same buckets laid side by side. They answer different
 * questions and share every line of preparation below:
 *
 *   pie          what is the mix RIGHT NOW
 *   stacked_pct  is the mix MOVING
 *
 * The second is nearly always the better one for a briefing, because a single
 * period against nothing is a coin toss -- the argument `baselineOf()` already
 * makes for revenue. The pie earns its place when the reader needs the mix
 * itself rather than its movement, and when the slices are comparable.
 *
 * THE SHARE TRAP, WHICH IS THE REASON THIS FILE HAS TESTS. A percentage rises
 * when its numerator grows OR when the denominator shrinks, and those are
 * opposite news. A venue that stops attracting new guests posts a RISING
 * returning-guest share on its way down, and a hundred-percent stacked chart
 * draws that as an improving trend in a reassuring colour. `shareTrap()`
 * catches it and the caveat travels with the spec.
 */

export interface Slice {
  label: string;
  value: number;
}

export interface Bucket {
  /** The period, for a stacked chart. A pie has exactly one and it is the range. */
  label: string;
  slices: Slice[];
}

/**
 * Six, from the same reasoning everywhere: part-to-whole reads at a glance or
 * not at all. Past six the slices are slivers nobody can compare, and the chart
 * has quietly become a badly formatted table. The overflow folds into "Other"
 * rather than being dropped -- a dropped category makes the percentages stop
 * summing to a hundred, which is worse than an uninformative slice.
 */
export const MAX_SLICES = 6;

/**
 * Below this many items in a bucket, its shares are noise.
 *
 * Retention is the case that forces a number: CLAUDE.md records the cross-venue
 * count as small enough that a week's movement in it is usually noise. Thirty
 * is not a statistical threshold, it is the point below which one large party
 * moves a share by several points on its own.
 */
export const LOW_SAMPLE = 30;

const round1 = (n: number) => Math.round(n * 10) / 10;

export const bucketTotal = (b: Bucket): number =>
  b.slices.reduce((sum, s) => sum + s.value, 0);

/**
 * One fixed category order across every bucket, with the overflow folded.
 *
 * THE ORDER IS COMPUTED ONCE, ACROSS THE WHOLE RANGE, and that is the whole
 * point of this function rather than a tidiness. If each bucket sorted its own
 * slices, a category would change colour and position from one month to the
 * next the moment two of them crossed over -- so the chart would show movement
 * that is an artefact of sorting, in the one chart type whose entire job is
 * showing movement. Colour follows the category, never its rank.
 *
 * Every bucket comes back carrying EVERY category, zero-filled where absent. A
 * missing category and a category that fell to zero look identical once drawn,
 * and the second one is the finding -- Neon Pigeon's two online booking paths
 * went to nothing for four months and nobody saw it.
 */
export function alignBuckets(
  buckets: Bucket[],
  max: number = MAX_SLICES,
): { categories: string[]; buckets: Bucket[] } {
  const totals = new Map<string, number>();
  for (const b of buckets) {
    for (const s of b.slices) {
      totals.set(s.label, (totals.get(s.label) ?? 0) + s.value);
    }
  }

  const ranked = [...totals.entries()]
    // Value first, then name, so a tie does not reorder between two runs of the
    // same query -- a chart that reshuffles on refresh reads as a data change.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);

  const keep = ranked.length > max ? ranked.slice(0, max - 1) : ranked;
  const folded = ranked.length > max;
  const categories = folded ? [...keep, 'Other'] : keep;

  const out = buckets.map(b => {
    const byLabel = new Map(b.slices.map(s => [s.label, s.value]));
    const slices: Slice[] = keep.map(label => ({ label, value: byLabel.get(label) ?? 0 }));

    if (folded) {
      const other = b.slices
        .filter(s => !keep.includes(s.label))
        .reduce((sum, s) => sum + s.value, 0);
      slices.push({ label: 'Other', value: other });
    }

    return { label: b.label, slices };
  });

  return { categories, buckets: out };
}

/**
 * A bucket's slices as percentages of that bucket.
 *
 * An empty bucket returns zeros rather than nulls: on a hundred-percent stacked
 * chart a month with no trade is a gap in the axis, and the renderer decides
 * that from the total, which travels separately. Returning NaN here would put
 * "NaN%" in a tooltip.
 */
export function toPercent(slices: Slice[]): Slice[] {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return slices.map(s => ({ label: s.label, value: 0 }));
  return slices.map(s => ({ label: s.label, value: round1((s.value / total) * 100) }));
}

/**
 * The share that rose because the denominator fell.
 *
 * Compares the first and last buckets that have any data. A category whose
 * SHARE went up while the bucket TOTAL went down is the trap: on the chart it
 * is a band getting fatter, which every reader takes as growth, and underneath
 * it the count may have fallen too.
 *
 * Returns the sentence to print, or null when nothing qualifies. Deliberately
 * silent in the ordinary case -- a caveat that fires every time is one nobody
 * reads, the same argument as the recommendation engine's quiet week.
 */
export function shareTrap(buckets: Bucket[]): string | null {
  const withData = buckets.filter(b => bucketTotal(b) > 0);
  if (withData.length < 2) return null;

  const first = withData[0];
  const last = withData[withData.length - 1];
  const firstTotal = bucketTotal(first);
  const lastTotal = bucketTotal(last);

  // A total that held or grew cannot produce this illusion.
  if (lastTotal >= firstTotal) return null;

  const firstPct = new Map(toPercent(first.slices).map(s => [s.label, s.value]));
  const lastPct = new Map(toPercent(last.slices).map(s => [s.label, s.value]));

  const risen = [...lastPct.entries()]
    .filter(([label, pct]) => pct > (firstPct.get(label) ?? 0))
    .map(([label]) => label);

  if (risen.length === 0) return null;

  const drop = round1(((firstTotal - lastTotal) / firstTotal) * 100);
  const names = risen.length === 1 ? `${risen[0]}'s share` : `the shares of ${risen.join(', ')}`;

  return (
    `THE TOTAL FELL ${drop}% ACROSS THIS RANGE (${Math.round(firstTotal)} to ${Math.round(lastTotal)}), ` +
    `so ${names} rose partly or wholly because the denominator shrank. A share going up while the ` +
    `total goes down is not an improvement — quote the COUNTS alongside it and say which moved.`
  );
}

/** Buckets too thin for their shares to mean anything, by label. */
export function lowSampleBuckets(buckets: Bucket[], threshold: number = LOW_SAMPLE): string[] {
  return buckets.filter(b => {
    const t = bucketTotal(b);
    return t > 0 && t < threshold;
  }).map(b => b.label);
}

/**
 * Whether a pie is the wrong picture for this particular mix.
 *
 * Not a ban -- the caller asked for a pie and gets one -- but a sentence saying
 * what it cannot show, which travels with the answer the way the coverage
 * percentage travels with a supplier breakdown. The case that matters here is
 * real and specific: guest source runs about 85% new, 12% returning, 3%
 * crossed, and three points of arc is eleven degrees. A reader cannot see the
 * number that matters move, and the number that matters is the only reason
 * anybody asked.
 */
export function pieFitNote(slices: Slice[]): string | null {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return null;

  const pcts = slices.map(s => (s.value / total) * 100);
  const biggest = Math.max(...pcts);
  const slivers = pcts.filter(p => p > 0 && p < 5).length;

  if (biggest >= 70) {
    return (
      `ONE SLICE IS ${Math.round(biggest)}% OF THIS PIE, so the rest are slivers and a few points of ` +
      `movement in them is a few degrees of arc nobody can see. The mix is readable here; a CHANGE in ` +
      `it is not. If the question is whether this is moving, ask for the stacked version over months ` +
      `instead and say so rather than reading a trend off one pie.`
    );
  }

  if (slivers >= 2) {
    return (
      `${slivers} slices are under 5% and cannot be compared by eye. Quote their figures in words or a ` +
      `table — do not ask the reader to judge them from the picture.`
    );
  }

  return null;
}
