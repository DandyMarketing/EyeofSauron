/**
 * Advice nobody asked for, which is the hard half.
 *
 * A question carries its own scope: someone asking "how were covers last week"
 * has told you what matters to them. A proactive engine has none of that. It
 * has to decide what is worth saying, to whom, and -- the part that decides
 * whether the feature survives -- when to say nothing at all.
 *
 * THE FAILURE MODE IS NOT A WRONG RECOMMENDATION, IT IS A BORING ONE. A wrong
 * one gets argued with, which is engagement. Three obvious observations every
 * Monday morning -- "covers were down on Tuesday", "food cost rose slightly" --
 * teach a manager that this thing has nothing to tell them, and they stop
 * reading it inside a month. CLAUDE.md says exactly this: a weak proactive
 * suggestion teaches people to ignore the feature. Everything below is arranged
 * against that.
 */

/** The domains a recommendation can be about. Mirrored in the tool's enum. */
export const RECOMMENDATION_DOMAINS = [
  'sales',
  'marketing',
  'cost',
  'labour',
  'covers',
  'product',
  'other',
] as const;

/**
 * Ceiling per venue per run.
 *
 * Three is a briefing; ten is a report, and a report is something you read
 * later, which means never. The cap is also what forces a ranking decision --
 * without it the model lists everything it noticed and the best finding sits
 * seventh.
 */
export const MAX_PER_RUN = 3;

/**
 * How far back a repeat is suppressed.
 *
 * Four weeks, because the run is weekly: the same advice four Mondays running
 * is the single fastest way to become wallpaper. Beyond that a recurrence is
 * genuine news -- a problem that was fixed in March and returned in September
 * is a finding, not a duplicate.
 */
export const SUPPRESSION_DAYS = 28;

/** Words that carry no meaning for deciding whether two headlines are the same. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'were', 'with', 'your', 'you',
]);

/**
 * A headline reduced to what it is ABOUT, so a repeat can be recognised.
 *
 * NUMBERS ARE STRIPPED, and that is the whole point rather than a
 * simplification. "Beverage margin is down 4 points" and "beverage margin is
 * down 6 points" are the same recommendation with a refreshed figure, and a
 * fingerprint that included the number would treat the second as new and say it
 * again next week. Suppressing on the SUBJECT is what makes the suppression
 * work at all.
 *
 * Word order is kept: "move brunch to Sunday" and "move Sunday to brunch" are
 * not the same instruction, and a sorted bag of words would say they are.
 */
export function fingerprint(headline: string): string {
  return headline
    .toLowerCase()
    // Numbers, percentages, currency: the part that legitimately changes.
    .replace(/[$£€]?\d[\d,.]*%?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .join(' ')
    .trim();
}

/**
 * The last COMPLETE Monday-to-Sunday week before a given date.
 *
 * Complete, and that is the point. A run on Wednesday that reviewed
 * "the last seven days" would compare four trading days against seven and
 * report a collapse in covers every single time. Weeks are also the unit an
 * F&B operator already thinks in -- a quiet Tuesday is a Tuesday, and only a
 * quiet week is news.
 *
 * If today IS a Monday, the week that just ended is yesterday's. Run it Monday
 * morning and the briefing is about the week the reader just worked.
 */
export function lastCompleteWeek(today: string): { start: string; end: string } {
  const date = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`lastCompleteWeek: "${today}" is not a date`);

  // getUTCDay: 0 = Sunday. Days back to the most recent Monday, where a Monday
  // is 0 days back from itself.
  const sinceMonday = (date.getUTCDay() + 6) % 7;

  const end = new Date(date);
  end.setUTCDate(end.getUTCDate() - sinceMonday - 1);   // the Sunday before
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);             // that week's Monday

  const iso = (d: Date) => d.toISOString().split('T')[0];
  return { start: iso(start), end: iso(end) };
}

export interface Recommendation {
  headline: string;
  body: string;
  domain: string;
  confidence: number;
}

/**
 * The standing brief.
 *
 * Written as instructions to an analyst rather than a template to fill in,
 * because a template produces the same three sections every week whether or not
 * there is anything in them.
 */
export function analysisBrief(
  venueName: string,
  periodStart: string,
  periodEnd: string,
  recentHeadlines: string[],
): string {
  const alreadySaid = recentHeadlines.length > 0
    ? `\n\nYOU HAVE ALREADY TOLD THIS VENUE THE FOLLOWING in the last ${SUPPRESSION_DAYS} days. Do not raise any of them again unless something has MATERIALLY changed — and if it has, say what changed and why it is worth hearing twice:\n${recentHeadlines.map(h => `- ${h}`).join('\n')}`
    : '';

  return `You are preparing this week's briefing for the person who runs ${venueName}. Nobody asked you a question. You are deciding what they most need to know.

The period under review is ${periodStart} to ${periodEnd}. Compare it against the weeks before it, and against the rest of the group.

Find at most ${MAX_PER_RUN} things worth their attention, ranked by how much money or risk is attached. Fewer is better than padding.

WHAT MAKES SOMETHING WORTH SAYING:
- It is actionable. "Tuesdays are quiet" is an observation; "the Tuesday set menu is drawing half the covers of the Wednesday one, consider moving it" is advice. Only the second is worth sending.
- It is not obvious to someone who was there. They worked the service. They know it was quiet. What they cannot see is the pattern across eight weeks, or how it compares to the sister venues, or that the drop is concentrated in one category.
- It is specific enough to be wrong. Say what you would expect to change if they acted, so that next month somebody can check.

WHAT TO LOOK AT — do not stop at the first thing you find:
- Sales and product mix: what moved, what stalled, what is quietly carrying the menu.
- Covers, walk-ins, no-shows: demand and how much of it converted.
- Cost and margin: food and beverage cost against the P&L, supplier concentration.
- Marketing: what was posted, what it was ABOUT (category and flags), and how it performed. This dimension is new and largely unexamined — there is likely more here than anywhere else.
- Anything that broke pattern. A trend that reversed is more interesting than one that continued.

HARD RULES:
- Every figure comes from a query tool. Never state a number from memory, and never estimate one.
- Cross-venue comparison is COMPARATIVE ONLY. You may say "your food cost is four points above the group average" or "you are third of three on spend per head". You may NOT name another venue's raw figures — not their P&L, not their sales, not their margin. The venue leader you are writing to is not cleared for another venue's books.
- Correlation is never cause. Posts are not assigned to categories at random and Tuesdays are not randomly quiet. Say "weeks where X happened have looked better", never "X causes Y".
- If the data behind a claim is thin — three posts, one week, a category with four rows — say the sample is small in the body. A confident claim resting on four rows is worse than no claim.
- Draw a chart wherever the metric supports one, and put figures in a table rather than in a sentence. This is read on a phone between services.

IF THERE IS NOTHING WORTH SAYING, SAY SO AND STOP. A quiet week where everything ran to pattern is a real outcome and reporting it as such is honest. Do not manufacture three findings because three were asked for — an engine that always has something to say is one nobody believes.${alreadySaid}

Write your findings as prose with the figures and charts included. They will be structured afterwards.`;
}

/**
 * The tool that turns the analysis into rows.
 *
 * A SECOND, FORCED CALL rather than asking the analyst to end with JSON. The
 * classifier settled this: a forced tool means the API enforces the schema,
 * and there is no prose to strip before parsing. It also keeps the analytical
 * pass free to write naturally, which is where the quality is.
 */
export function recommendationTool() {
  return {
    name: 'record_recommendations',
    description: 'Record the recommendations from an analysis. One entry per distinct recommendation, in the order they were made.',
    input_schema: {
      type: 'object' as const,
      properties: {
        recommendations: {
          type: 'array',
          maxItems: MAX_PER_RUN,
          description: `The recommendations, most important first. EMPTY if the analysis concluded there was nothing worth raising — that is a valid and useful outcome, never pad it.`,
          items: {
            type: 'object',
            properties: {
              headline: {
                type: 'string',
                description: 'One line, and it must be the ACTION not the observation. "Move the Tuesday set menu to Wednesday", never "Tuesdays are quiet". No figures in the headline — they belong in the body.',
              },
              body: {
                type: 'string',
                description: 'Markdown. The reasoning, the figures that support it, and what you would expect to change if they acted. Keep tables and charts from the analysis. Say if the sample is small.',
              },
              domain: {
                type: 'string',
                enum: [...RECOMMENDATION_DOMAINS],
                description: 'What the recommendation is about.',
              },
              confidence: {
                type: 'number',
                description: '0 to 1, and it should actually vary. An eight-week margin trend is 0.9; one unusual Tuesday is 0.4. An engine that presents everything at full confidence teaches people to discount all of it.',
              },
            },
            required: ['headline', 'body', 'domain', 'confidence'],
          },
        },
      },
      required: ['recommendations'],
    },
  };
}

/**
 * Validate the structured output, or explain why it cannot be stored.
 *
 * Rejects rather than repairs, for the reason the classifier rejects an unknown
 * category: a guess at what was meant is exactly the silent wrong answer this
 * codebase keeps finding. An empty list is VALID and is not an error -- it is
 * the engine saying the week was quiet.
 */
export function parseRecommendations(
  raw: unknown,
): { ok: true; value: Recommendation[] } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'response was not an object' };
  }

  const list = (raw as Record<string, unknown>).recommendations;
  if (!Array.isArray(list)) {
    return { ok: false, reason: 'no recommendations array returned' };
  }

  if (list.length > MAX_PER_RUN) {
    return { ok: false, reason: `${list.length} recommendations returned, the cap is ${MAX_PER_RUN}` };
  }

  const value: Recommendation[] = [];

  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object') {
      return { ok: false, reason: `recommendation ${i + 1} was not an object` };
    }
    const r = item as Record<string, unknown>;

    const headline = typeof r.headline === 'string' ? r.headline.trim() : '';
    if (!headline) return { ok: false, reason: `recommendation ${i + 1} has no headline` };

    const body = typeof r.body === 'string' ? r.body.trim() : '';
    if (!body) return { ok: false, reason: `recommendation ${i + 1} ("${headline}") has no body` };

    const domain = typeof r.domain === 'string' ? r.domain.trim().toLowerCase() : '';
    if (!(RECOMMENDATION_DOMAINS as readonly string[]).includes(domain)) {
      return { ok: false, reason: `recommendation ${i + 1} has domain "${domain}", which is not one of the ${RECOMMENDATION_DOMAINS.length} defined values` };
    }

    const confidence = Number(r.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: `recommendation ${i + 1} has confidence ${r.confidence}, expected 0 to 1` };
    }

    value.push({
      headline,
      body,
      domain,
      confidence: Math.round(confidence * 100) / 100,
    });
  }

  return { ok: true, value };
}

/**
 * Names of OTHER venues found in a recommendation, which must not be there.
 *
 * WHY THIS IS CODE AND NOT JUST A LINE IN THE BRIEF. Benchmarking is the
 * product's edge, so the analysis has to see every venue -- run it scoped to one
 * and it cannot compare anything. But the reader is cleared for one venue. The
 * brief tells the model to keep comparisons anonymous, and CLAUDE.md is explicit
 * that an instruction in a prompt is a hint rather than a control. This is the
 * control, and it sits in the same place as enforceVenueScope: server-side,
 * after the model has spoken, before anything is stored.
 *
 * THE RULE IT ENFORCES is CLAUDE.md's likely resolution of an open decision:
 * comparative figures yes, another venue's identity no. "Your food cost is four
 * points above the group average" is fine. "Fat Prince runs 28%" is not.
 *
 * WHAT IT DOES NOT CATCH, stated plainly because a guard nobody knows the edges
 * of is worse than none: it matches NAMES. A model that writes "the venue on
 * Craig Road" or "our Indian restaurant" would pass. It fails closed on the
 * common case and is not a substitute for the venue filter on the query tools.
 *
 * Legal entity names are included in the terms because two of the three tell
 * you nothing about the venue -- "Potus" and "20 Craig Road" would not be
 * recognised as a leak by anyone reading quickly.
 */
export function namesOtherVenues(text: string, forbiddenTerms: string[]): string[] {
  const found: string[] = [];
  const haystack = text.toLowerCase();

  for (const term of forbiddenTerms) {
    const needle = term.trim().toLowerCase();
    if (needle.length < 3) continue;  // too short to match on safely
    if (haystack.includes(needle)) found.push(term);
  }

  return found;
}

/**
 * Drop anything we have already said recently.
 *
 * BELT AND BRACES WITH THE PROMPT, deliberately. The brief lists what was said
 * before and asks the model not to repeat it -- that is a hint, and hints are
 * followed most of the time. This is the control. The same split as the venue
 * filter: the prompt keeps the model from PROMISING something it will then be
 * refused, and the code is what actually refuses.
 */
export function suppressRepeats(
  candidates: Recommendation[],
  recentFingerprints: Iterable<string>,
): { kept: Recommendation[]; suppressed: Recommendation[] } {
  const seen = new Set(recentFingerprints);
  const kept: Recommendation[] = [];
  const suppressed: Recommendation[] = [];

  for (const candidate of candidates) {
    const fp = fingerprint(candidate.headline);
    // Also guards against one run returning the same advice twice.
    if (seen.has(fp)) {
      suppressed.push(candidate);
      continue;
    }
    seen.add(fp);
    kept.push(candidate);
  }

  return { kept, suppressed };
}
