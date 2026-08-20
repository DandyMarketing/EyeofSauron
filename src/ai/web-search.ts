import type Anthropic from '@anthropic-ai/sdk';

/**
 * External context, from Anthropic's server-side web search.
 *
 * WHY THIS REPLACED BRAVE. The first version called the Brave Search API from
 * our own handler and returned five snippets. It never ran once: the key was
 * never set, so every search the model attempted came back as the string
 * "Web search not configured" and the model wrote its answer without it. The
 * failure was invisible for as long as the feature existed.
 *
 * Brave was reconsidered rather than simply fixed, and lost on the thing that
 * matters most here -- PROVENANCE. Sauron's rule is that every figure comes
 * from a query tool, and an external number breaks it unless the reader can see
 * where it came from. Brave returns a description snippet with no link between
 * any particular number and any particular source, so the attribution would
 * have had to be inferred, by us, from prose. This tool returns CITATIONS: each
 * cited claim carries the url, the page title, and up to 150 characters of the
 * sentence it was taken from. That is the provenance record, supplied rather
 * than reconstructed, and it is the whole reason for the switch. (Brave is also
 * no longer free as of Feb 2026, which removed the other argument for it.)
 *
 * THE FIGURES IT PRODUCES ARE NOT WAREHOUSE FIGURES. Nothing here is
 * reconciled, nothing is about our venues, and a number from a trade blog has
 * no standing beside one Postgres computed. The system prompt says so; the
 * sources returned alongside the answer are what let a reader check.
 */

/**
 * Which version, and why this one.
 *
 * `web_search_20260209` adds dynamic filtering -- the model writes code that
 * filters results before they reach the context window, so a search costs far
 * fewer tokens than dumping five pages in. It is supported on Sonnet 5 (what we
 * run today) and Opus 5 (where the analysis path is heading).
 *
 * `web_search_20260318` exists and adds `response_inclusion`, which can drop
 * raw search blocks from the response to save output tokens. Not used: we WANT
 * those blocks, because they are how a search failure becomes visible.
 *
 * If a future model returns 400 asking for `allowed_callers`, that model does
 * not support programmatic tool calling and the fix is
 * `allowed_callers: ['direct']` -- which turns dynamic filtering off, not the
 * search.
 */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209' as const;

/**
 * A hard ceiling on searches per request, enforced by Anthropic rather than by
 * asking the model nicely.
 *
 * Five is chosen against the documented behaviour: a simple factual lookup uses
 * one to three, comparative research can use ten or more. Five allows a real
 * question and refuses a runaway. At $10 per 1,000 searches that caps the
 * search cost of any one question at five cents, which is the point -- the
 * Brave alternative was a card with no spending cap behind a tool the model can
 * call in a loop.
 */
export const MAX_SEARCHES_PER_REQUEST = 5;

/**
 * Singapore, because every venue is here and search results are localised.
 *
 * "Public holidays next month", "what is opening nearby", "is there a
 * convention on" all return a different and mostly useless web without this.
 */
export const SEARCH_LOCATION = {
  type: 'approximate' as const,
  city: 'Singapore',
  country: 'SG',
  timezone: 'Asia/Singapore',
};

/**
 * The tool definition sent with every request.
 *
 * `allowed_domains` is deliberately NOT set. It is the strongest guardrail
 * available here -- restrict searches to sources somebody has vetted and "a
 * blog said 30%" stops being possible -- but it is the wrong control for
 * general context like holidays and local events, which is most of what this
 * is for. It belongs on the benchmarks path, where an external NUMBER is the
 * point, not here.
 */
export function webSearchTool(): Anthropic.Messages.WebSearchTool20260209 {
  return {
    type: WEB_SEARCH_TOOL_TYPE,
    name: 'web_search',
    max_uses: MAX_SEARCHES_PER_REQUEST,
    user_location: SEARCH_LOCATION,
  };
}

/** One external source the answer actually cited. */
export interface WebSource {
  url: string;
  title: string | null;
  /** The sentence the claim was drawn from, up to 150 characters. */
  quote: string;
}

/**
 * The sources behind an answer, taken from the citations on its text blocks.
 *
 * Read from CITATIONS rather than from the search result blocks, and the
 * difference matters: result blocks list everything the search returned,
 * citations list what the answer actually leaned on. A reader checking a claim
 * wants the second. It is also the stable place to read from -- with dynamic
 * filtering the result blocks are nested inside code-execution output and carry
 * a `caller` field, while citations stay attached to the text either way.
 *
 * Deduplicated by url + quote, because the model cites the same passage more
 * than once in a paragraph and a list of six identical links is noise.
 */
export function extractSources(content: Anthropic.Messages.ContentBlock[]): WebSource[] {
  const seen = new Set<string>();
  const sources: WebSource[] = [];

  for (const block of content) {
    if (block.type !== 'text') continue;
    for (const citation of block.citations ?? []) {
      if (citation.type !== 'web_search_result_location') continue;
      const key = `${citation.url}|${citation.cited_text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        url: citation.url,
        title: citation.title,
        quote: citation.cited_text,
      });
    }
  }

  return sources;
}

/**
 * Search failures, which do NOT arrive as failures.
 *
 * A rate-limited or errored search returns HTTP 200 with an error object where
 * the results should be -- so from the outside it is indistinguishable from a
 * search that found nothing, and the model writes a confident answer with no
 * external context in it. That is the same shape as the Brave key never being
 * set, which went unnoticed for the life of the feature, so it is pulled out
 * and reported rather than left to be inferred.
 *
 * `error_code` is one of too_many_requests, invalid_tool_input,
 * max_uses_exceeded, query_too_long, request_too_large, unavailable. An empty
 * result list is NOT an error -- it means the search ran and matched nothing.
 */
export function searchErrors(content: Anthropic.Messages.ContentBlock[]): string[] {
  const errors: string[] = [];

  const visit = (blocks: any[]): void => {
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'web_search_tool_result') {
        const inner = block.content;
        // A list is results; a single object is the error case.
        if (inner && !Array.isArray(inner) && inner.type === 'web_search_tool_result_error') {
          errors.push(String(inner.error_code ?? 'unknown'));
        }
        continue;
      }

      // Dynamic filtering runs the search from inside code execution, so the
      // result blocks arrive nested rather than at the top level.
      if (Array.isArray(block.content)) visit(block.content);
    }
  };

  visit(content as any[]);
  return errors;
}

/** How many searches Anthropic actually billed for this response. */
export function searchRequestCount(usage: Anthropic.Messages.Usage | undefined): number {
  return usage?.server_tool_use?.web_search_requests ?? 0;
}

/**
 * What the model is told about external figures.
 *
 * This is a hint, not a control, and is written knowing that. The controls are
 * elsewhere: `max_uses` is enforced by Anthropic, and the citations returned
 * beside the answer let a reader check any external claim without trusting the
 * model to have labelled it. This closes the common case, where the model would
 * otherwise set a number it read on a blog beside one Postgres computed and
 * give them the same standing.
 */
export const EXTERNAL_CONTEXT_FRAMING = `
Web search is available for EXTERNAL context only: industry benchmarks, Singapore public holidays and local events, F&B trends, weather, competitor news. Never use it for anything about this business — every figure about our own venues comes from a query tool.

A number from the web and a number from the warehouse are not the same kind of thing, and must never be presented as though they were:
- A warehouse figure is OUR data, reconciled. State it plainly.
- A web figure is somebody else's claim about somebody else's business. Name the source in the sentence that uses it — "a 2026 industry survey puts casual dining food cost near 30%" — never a bare "the industry average is 30%".
- Never do arithmetic that mixes the two into a single number. Say "ours is 32%, that survey says 30%" and let the reader make the comparison; do not report "2 points above industry" as if it were a measured figure.
- If a search returns nothing useful, say so. Do not fill the gap from memory — a remembered benchmark is exactly the hallucination this system exists to prevent.`;
