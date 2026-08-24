import Anthropic from '@anthropic-ai/sdk';
import { queryTools } from './tools.js';
import { handleToolCall } from './tool-handlers.js';
import { fetchNotes, formatNotes, KNOWLEDGE_FRAMING } from './knowledge.js';
import { modelFor, isModelFeatureError, usageLine, type Purpose } from './model-policy.js';
import {
  webSearchTool,
  extractSources,
  searchErrors,
  searchRequestCount,
  isWebSearchConfigError,
  nextContainerId,
  isMissingContainerError,
  joinText,
  mergeSources,
  EXTERNAL_CONTEXT_FRAMING,
  type WebSource,
} from './web-search.js';

const client = new Anthropic();

function getSingaporeDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

const SYSTEM_PROMPT_BASE = `You are Sauron, an AI business advisor for The Dandy Collection — a multi-venue food & beverage group in Singapore. You have access to real operational data from the company's venues.

Your role:
- Answer questions about venue performance using real data (never guess or hallucinate numbers)
- Provide actionable recommendations backed by the data you query
- Compare venues to surface benchmarking insights
- Be concise, specific, and practical — this is for busy operators

Current venues: Neon Pigeon, Fat Prince, Firangi Superstar

Key context:
- Singapore GST is 9%
- All venues charge a 10% service fee
- "Gross Sales" = product sales before discounts/tax
- "Net to Account For" = total cash+card collected (gross - discounts + service fee + tax)

Two per-unit metrics that are NOT interchangeable — always distinguish them:
- "Average check" = revenue per BILL (per transaction). It rises simply because parties are larger, so it says as much about table mix as about how well the venue sells.
- "Average spend per cover" (also called spend per head) = revenue per PERSON. This is the real productivity measure: it is what a guest is worth, independent of party size.
A venue seating big groups can post a high average check and an ordinary spend per cover. When comparing venues or meal periods, lead with spend per cover and quote average check alongside it — reporting only average check will mislead. If spend per cover is unavailable, say so rather than substituting average check for it.
Transactions are BILLS, never people. Never describe a transaction count as covers.
- Sales definitions are the business's, not the textbook ones. GROSS SALES = food + beverage + the 10% service charge. NET SALES = gross sales less discounts. FOOD & BEVERAGE SALES = food + beverage alone, and is the only basis cost percentages may be measured against. Service charge sits INSIDE gross and net sales; never add it on top.
- When someone asks about "sales" without saying which, answer with NET SALES and say the words "net sales" — a bare figure invites the reader to compare it against a different basis. Quote another basis when the question is about cost or margin, and name that one too.
- Spend per head, food/beverage split and discount rate are all measured on FOOD & BEVERAGE SALES. Spend per head therefore does not match Revel's own "Average Sale Per Guest", which uses net sales over Revel's paid-guest count — different numerator, different denominator, both deliberate. Never reconcile the two or present one as the other.
- COGS in Revel is always 0. Cost data comes from the Xero P&L via query_profit_and_loss; ingredient-level food cost from Zeemart is not yet connected.
- Revel/POS figures and Xero P&L figures will NOT tie exactly: different basis, and the ledger includes what the POS never sees. When both appear in one answer, say which source each came from rather than reconciling them silently.
- Data is daily granularity from Revel POS

SHOW THE DATA, DO NOT NARRATE IT. A paragraph containing six figures is the
hardest possible way to read six figures, and this is for busy operators who
are usually on a phone between services. Default to a visual form:

- A TABLE for anything with more than about three numbers, or any comparison —
  venues side by side, a cost breakdown, a supplier list, product mix, a ranking
  of posts, a month against the month before. Write it as a markdown table; the
  app renders it properly. Lead with the table, then say in a sentence or two
  what it shows and what to do about it.
- A CHART via create_chart whenever the metric is one it supports AND the
  question is about movement over time or across venues. It re-queries the
  warehouse itself, so the picture is always real data.
- create_chart covers sales, covers, spend per head, walk-ins, no-shows and
  Instagram only. It cannot plot P&L lines, supplier bills, product mix or post
  categories — for those, build a markdown table rather than describing the
  numbers in prose or claiming a chart you cannot draw.
- Prose alone is right for a single figure, a yes/no, or a recommendation with
  no numbers in it. Do not wrap one number in a table.

Never make the reader hold several numbers in their head to follow you. If you
find yourself writing "X was A, Y was B and Z was C", that is a table.

When answering:
- Always query the data first. Never state a number from memory.
- If data isn't available for the requested date/venue, say so clearly.
- Format currency as SGD with $ prefix.
- Use METRIC units, always — °C, km, kg, litres, m². Singapore is metric, as is most of the world. If an external source reports imperial, convert it and lead with the metric figure; give the original in brackets only when the source's exact wording matters.
- Use brief bullet points for recommendations.`;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface QueryResult {
  answer: string;
  toolCalls: Array<{ name: string; input: Record<string, any> }>;
  /** SVG charts produced by create_chart, in the order the model asked for them. */
  charts: Array<{ title: string; svg: string }>;
  /**
   * External pages the answer cited, if it searched the web.
   *
   * Rendered beside the answer so an external claim can be checked without
   * trusting the model to have labelled it as external. A warehouse figure has
   * no entry here and needs none -- it came from our own data.
   */
  sources: WebSource[];
}

// The output ceiling now comes from the model policy, because it depends on the
// purpose -- thinking tokens count towards output, so the deepest-thinking path
// needs the most room. See ModelChoice.maxTokens.
//
// History kept, because each number was paid for. 2048 was too tight once
// answers began carrying tables and chart commentary: running out mid-response
// produced EMPTY replies, since the turn ends with stop_reason 'max_tokens' and,
// if the model was still emitting tool calls, no text block at all. 4096 was too
// tight for an analytical answer that also had to interpret a chart. 8192 was
// too tight once thinking was switched on -- the first recommendation run
// returned exactly 8192 output tokens with a 3,449-character answer behind it.

// Ceiling on tool rounds. Nothing legitimate needs more, and without it a model
// that keeps querying spins until the request times out with no answer.
const MAX_TOOL_ROUNDS = 12;

/**
 * Ceiling on `pause_turn` continuations.
 *
 * A long server-side search can pause mid-turn; the documented way to resume is
 * to send the paused assistant message back unchanged. That is not a tool
 * round -- no query of ours ran -- so it needs its own counter, and it needs a
 * ceiling for the same reason MAX_TOOL_ROUNDS has one: a resume that keeps
 * pausing would otherwise loop until the request times out.
 */
const MAX_PAUSE_CONTINUATIONS = 4;


/**
 * Strip the conversation cache marker from wherever it currently sits.
 *
 * A request allows four cache_control breakpoints; an agentic loop would want
 * one per round. So exactly one travels with the conversation's tail.
 */
function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as any[]) {
      if (block && typeof block === 'object' && 'cache_control' in block) {
        delete block.cache_control;
      }
    }
  }
}

/** Put the marker on the last content block of the newest message. */
function markLastBlockForCaching(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const block = last.content[last.content.length - 1] as any;
  if (block && typeof block === 'object') {
    block.cache_control = { type: 'ephemeral' };
  }
}

export async function askSauron(
  question: string,
  history: ChatMessage[] = [],
  venueFilter?: string[],
  purpose: Purpose = 'chat',
): Promise<QueryResult> {
  /**
   * Chosen ONCE, before the first call, and used for every turn.
   *
   * Not tidiness: prompt caches are model-scoped, so switching model
   * mid-conversation discards the whole cached prefix. It is also the only
   * honest split available -- the tool loop's first round is routing and its
   * last is analysis, through the same call site.
   */
  const choice = modelFor(purpose);
  const toolCalls: QueryResult['toolCalls'] = [];
  const charts: QueryResult['charts'] = [];

  const today = getSingaporeDate();

  /**
   * TWO SYSTEM BLOCKS, ordered by how often they change. This is the whole of
   * the caching design; the marker is the easy part.
   *
   * A prompt cache is a PREFIX match, and the request renders tools -> system
   * -> messages. So a breakpoint on the first system block caches every tool
   * definition and the standing instructions together -- and that prefix is
   * identical for every user, every venue and every question.
   *
   * It was previously one string built by concatenation: base prompt, then
   * today's date, then a conditional venue paragraph, then the notes. Every one
   * of those is a documented cache-killer, and the venue paragraph is the worst
   * -- it made the prefix per-user, so no two people could ever share an entry.
   * Sorting the volatile parts BELOW the breakpoint is what makes caching work
   * at all.
   */
  const stableSystem = `${SYSTEM_PROMPT_BASE}\n${EXTERNAL_CONTEXT_FRAMING}`;

  let volatileSystem = `Today's date is ${today}. When a user says "yesterday", they mean ${new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0]}. When a user says "July 23" without a year, assume the current year.`;

  // The tool layer is the actual control; this only keeps the model from
  // promising data it will then be refused. An empty list means no venues at
  // all, which must not read as "no restriction".
  if (venueFilter && venueFilter.length > 0) {
    volatileSystem += `\n\nIMPORTANT: This user only has access to these venues: ${venueFilter.join(', ')}. Only query and discuss data for these venues. If asked about other venues, say you don't have access.`;
  } else if (venueFilter) {
    volatileSystem += `\n\nIMPORTANT: This user has not been assigned to any venue, so no venue data is available to them. Do not attempt to query venue data. Tell them their account has no venue access yet and to contact HQ.`;
  }

  // Notes are scoped to the caller's venues. They used to be selected
  // unfiltered and appended here, one line below the text telling the user
  // which venues they may see -- so a venue manager received every other
  // venue's notes, which are free text and could say anything.
  const notes = await fetchNotes(venueFilter ?? null);
  const notesText = formatNotes(notes, today);
  if (notesText) {
    volatileSystem += `\n${KNOWLEDGE_FRAMING}\n\n${notesText}`;
  }

  const systemBlocks = (extra?: string): Anthropic.Messages.TextBlockParam[] => [
    { type: 'text', text: stableSystem, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: extra ? `${volatileSystem}\n\n${extra}` : volatileSystem },
  ];

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: question },
  ];

  /**
   * Our query tools plus Anthropic's server-side web search.
   *
   * The search runs on Anthropic's side: we never see the query leave, and the
   * results arrive as blocks in the response rather than through
   * handleToolCall. What comes back to us is the part worth having -- the
   * citations behind whatever the answer claims.
   */
  const tools: Anthropic.Messages.ToolUnion[] = [...queryTools, webSearchTool()];

  const sources: WebSource[] = [];
  let searches = 0;
  /** Set when the API refuses the search tool, so we stop sending it. */
  let searchDisabled = false;

  /**
   * Every request goes through here so nothing has to remember to account for
   * a response. Sources, search count and search failures were being collected
   * in one place and missed in another the first time this was written.
   */
  /**
   * Set when the API refuses `thinking` or `output_config`, so we stop sending
   * them. Both are documented for these models and neither can be verified
   * without calling the API; if one is refused the answer should get shallower,
   * not stop. Same rule as the web search tool.
   */
  let featuresDisabled = false;

  /**
   * The code execution container the web search's dynamic filtering ran in.
   *
   * Once a search has run, every later request in the turn must name it or the
   * API rejects the whole request with "container_id is required when there are
   * pending tool uses generated by code execution with tools". Carried across
   * rounds because only some responses report it.
   */
  let containerId: string | null = null;

  /**
   * Every request goes through here, so nothing has to remember to account for
   * a response. Sources, search count, search failures and token usage were
   * being collected in one place and missed in another the first time this was
   * written.
   */
  const send = async (
    opts: { tools?: Anthropic.Messages.ToolUnion[]; extraSystem?: string } = {},
  ): Promise<Anthropic.Message> => {
    const build = (withTools: Anthropic.Messages.ToolUnion[]) => {
      const params: any = {
        model: choice.model,
        max_tokens: choice.maxTokens,
        system: systemBlocks(opts.extraSystem),
        messages,
        tools: withTools,
      };

      // Not optional once a search has run — see nextContainerId().
      if (containerId) params.container = containerId;

      if (!featuresDisabled) {
        /**
         * Adaptive, NEVER budget_tokens. The older
         * `{type:'enabled', budget_tokens}` form is rejected with a 400 on
         * Opus 5 and Sonnet 5 -- a stale prior that would take the chat down
         * rather than degrade it.
         *
         * Toggling thinking does not invalidate the tools+system cache, so
         * this costs nothing at the prefix.
         */
        if (choice.thinking) params.thinking = { type: 'adaptive' };
        if (choice.effort) params.output_config = { effort: choice.effort };
      }

      return params;
    };

    const activeTools = () =>
      opts.tools ?? (searchDisabled ? queryTools : tools);

    /**
     * STREAMED, always, and not for the progress display -- we discard every
     * event and take the final message.
     *
     * The SDK refuses a non-streaming request whose `max_tokens` could take it
     * past ten minutes, and raising the recommendation ceiling to 32,768
     * crossed that line:
     *
     *   Streaming is required for operations that may take longer than 10
     *   minutes.
     *
     * The threshold is an internal estimate, not a documented number, so
     * "pick a max_tokens just under it" is a guess that breaks silently the
     * next time a model's throughput estimate changes. Streaming removes the
     * question entirely and costs nothing here.
     *
     * finalMessage() returns a Message, so `container`, `usage` and
     * `stop_reason` all survive -- checked against the SDK's own types rather
     * than assumed, because the container fix depends on it.
     */
    const call = (params: any): Promise<Anthropic.Message> =>
      client.messages.stream(params).finalMessage() as Promise<Anthropic.Message>;

    let r: Anthropic.Message;
    try {
      r = await call(build(activeTools()));
    } catch (e) {
      /**
       * Two optional enrichments, two fallbacks, one rule: a feature that is
       * refused must cost the feature and never the product.
       *
       * `country: 'SG'` was a valid ISO code the API rejected, and because the
       * web search tool ships on every request it failed EVERY question --
       * including ones that never touch the web. `thinking` and
       * `output_config` are the same shape: documented, unverifiable without
       * calling the API, sent every time.
       */
      if (!featuresDisabled && isModelFeatureError(e)) {
        featuresDisabled = true;
        console.error(
          `[model] ${choice.model} refused thinking/effort — retrying without them, answers will be shallower: ` +
          `${String((e as any)?.message ?? e).slice(0, 300)}`,
        );
        r = await call(build(activeTools()));
      } else if (!searchDisabled && !opts.tools && isWebSearchConfigError(e)) {
        /**
         * Only on the FIRST failure, and never when the caller pinned the tool
         * list. Once a search has run its results are in `messages`, and
         * removing the tool that produced them fails for a different reason.
         */
        searchDisabled = true;
        console.error(
          `[engine] WEB SEARCH DISABLED for this request — the API rejected the tool definition: ` +
          `${String((e as any)?.message ?? e).slice(0, 300)}`,
        );
        console.error('[engine] Answering from the warehouse only. Fix the tool config in src/ai/web-search.ts.');
        r = await call(build(queryTools));
      } else {
        /**
         * No retry, but never silently. This failure threw away three complete
         * Opus analyses and arrived looking like an ordinary 400; if the
         * container tracking above ever stops working, it should say which
         * failure it is rather than leaving it to be diagnosed again.
         */
        if (isMissingContainerError(e)) {
          console.error(
            `[engine] MISSING CODE EXECUTION CONTAINER after ${searches} search(es). ` +
            `A web search ran dynamic filtering and this request did not name its container ` +
            `(tracked id: ${containerId ?? 'none captured'}). See nextContainerId() in src/ai/web-search.ts.`,
          );
        }
        throw e;
      }
    }

    /**
     * Captured BEFORE anything else can throw, and on every response.
     *
     * A container created by one round is required by the next, so losing it
     * anywhere in this function breaks the round after — which is how three
     * complete analyses were thrown away.
     */
    containerId = nextContainerId(containerId, r);

    sources.push(...extractSources(r.content));
    searches += searchRequestCount(r.usage);
    // Logged on every call, because a cache that silently stopped working
    // shows up as a bill months later and nothing else.
    console.log(usageLine(choice.model, r.usage));

    /**
     * Hitting the ceiling is a TRUNCATED answer, and it looks like a finished
     * one from the outside.
     *
     * It went unnoticed on the first recommendation run because the only
     * evidence was `out=8192` matching the limit exactly -- which you have to
     * already suspect to spot. In the chat a user might notice a reply stopping
     * mid-sentence; in a proactive briefing nobody is reading it as it arrives,
     * and the structuring pass will faithfully record whatever survived.
     */
    if (r.stop_reason === 'max_tokens') {
      console.error(
        `[model] TRUNCATED — hit the ${choice.maxTokens}-token ceiling for purpose "${purpose}". ` +
        `Thinking counts towards this, so raise maxTokens in model-policy.ts rather than lowering effort.`,
      );
    }

    // A failed search returns HTTP 200 with an error object where the results
    // should be, so it is invisible unless it is said out loud.
    for (const code of searchErrors(r.content)) {
      console.warn(`[engine] web search failed: ${code}`);
    }

    return r;
  };


  let response = await send();

  // Tool use loop
  let rounds = 0;
  let pauses = 0;

  for (;;) {
    /**
     * A paused turn is not a tool round -- none of our tools ran. Resume by
     * sending the assistant message back unchanged and adding nothing after
     * it; a "continue" message here would be read as a new instruction.
     */
    if (response.stop_reason === 'pause_turn') {
      if (pauses++ >= MAX_PAUSE_CONTINUATIONS) {
        console.warn(`[engine] gave up after ${pauses} paused turns`);
        break;
      }
      messages.push({ role: 'assistant', content: response.content });
      response = await send();
      continue;
    }

    if (response.stop_reason !== 'tool_use') break;
    if (rounds++ >= MAX_TOOL_ROUNDS) break;

    /**
     * Pushed back UNCHANGED, and that is load-bearing now rather than merely
     * tidy: a turn carrying web results includes `encrypted_content` that the
     * API decrypts to restore those results on the next call. Rebuilding this
     * array, or dropping blocks we do not recognise, fails the request with a
     * 400 rather than degrading quietly.
     *
     * This is also the turn shape that arrives when the model calls web search
     * and one of our tools together: the API defers the search, hands back our
     * tool calls, and runs the search once we answer them.
     */
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        toolCalls.push({ name: block.name, input: block.input as Record<string, any> });
        const result = await handleToolCall(block.name, block.input as Record<string, any>, venueFilter);

        // create_chart returns rendered SVG. Pull it out for the client and
        // strip it before the result goes back to the model -- a chart is
        // several KB of markup that would burn context to no purpose, since
        // the model already gets a numeric summary alongside it.
        let forModel = result;
        if (block.name === 'create_chart') {
          try {
            const parsed = JSON.parse(result);
            if (parsed.__chart_svg) {
              charts.push({ title: parsed.title ?? 'Chart', svg: parsed.__chart_svg });
              delete parsed.__chart_svg;
              forModel = JSON.stringify(parsed);
            }
          } catch {
            // Malformed result: pass it through untouched rather than losing it.
          }
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: forModel });
      }
    }

    /**
     * Cache the conversation as it grows, by MOVING one breakpoint rather than
     * adding one per round.
     *
     * By round twelve the accumulated tool results dwarf the system prompt, so
     * this is the larger half of the saving. But a request allows at most FOUR
     * cache_control markers, and a twelve-round loop would want twelve -- so
     * the marker is stripped from wherever it was and set on the newest block.
     * Earlier positions stay readable as cache entries; only the write point
     * moves.
     *
     * KNOWN LIMIT: a breakpoint looks back at most 20 content blocks for a
     * prior entry. A single round with more than 20 tool_use/tool_result blocks
     * would miss and silently pay full price -- visible as cache_hit dropping
     * in the usage line, which is why that is logged on every call.
     */
    moveCacheBreakpoint(messages);
    messages.push({ role: 'user', content: toolResults });
    markLastBlockForCaching(messages);

    response = await send();
  }

  let answer = joinText(response.content);

  // An empty answer is never acceptable -- it renders as a blank bubble with no
  // clue what went wrong. Recover by asking for a reply from the data already
  // gathered, with tools withheld so it must respond in prose.
  //
  // `messages` is safe to reuse: the loop only appends a response once it is a
  // complete tool_use turn, so a truncated final response was never added.
  let recoveryError: string | null = null;

  if (!answer.trim()) {
    const reason = response.stop_reason === 'max_tokens'
      ? 'The previous reply was cut off before it finished.'
      : rounds >= MAX_TOOL_ROUNDS
        ? 'You have run enough queries.'
        : 'No reply was produced.';

    try {
      /**
       * Query tools are withheld so the model must answer in prose rather than
       * running another lap. Web search is NOT withheld, and that is not an
       * oversight: `messages` may hold search results whose encrypted content
       * the API decrypts on the way in, and removing the tool that produced
       * them risks a 400 on the one request whose whole job is to rescue a
       * turn that already went wrong. The instruction below is what stops it
       * searching again.
       */
      const recovery = await send({
        tools: [webSearchTool()],
        // Appended BELOW the cache breakpoint, so rescuing a turn does not
        // rebuild the whole cached prefix.
        extraSystem: `${reason} Answer the user now, concisely, using only the data already gathered in this conversation. Do not request more data. If you genuinely have nothing, say so plainly and suggest what to ask instead.`,
      });
      answer = joinText(recovery.content);
    } catch (e: any) {
      // Was swallowed entirely, which left the user with "could not compose a
      // reply" and left us with nothing to look at. The likely causes -- the
      // conversation outgrowing the context window after a dozen rounds of
      // tool results, or a transient API error -- are indistinguishable from
      // the outside and both fixable, but only if they are visible.
      recoveryError = String(e?.message ?? e);
      console.error(`[engine] recovery reply failed after ${rounds} tool rounds: ${recoveryError}`);
    }
  }

  if (!answer.trim()) {
    answer = toolCalls.length > 0
      // Say which of the two it was. "Ask again" is the right advice after a
      // transient error and useless advice after running out of query rounds,
      // where the fix is a narrower question -- and the person on the other end
      // cannot tell them apart.
      ? `I queried the warehouse (${[...new Set(toolCalls.map(t => t.name.replace(/_/g, ' ')))].join(', ')}) but could not compose a reply. ${
          rounds >= MAX_TOOL_ROUNDS
            ? 'That question needed more separate queries than I am allowed in one go. Try asking about one venue, or a shorter period, and I can build up from there.'
            : 'Please ask again — that looked like a temporary fault rather than a problem with the question.'
        }`
      : 'I could not produce a reply to that. Please try rephrasing the question.';
  }

  /**
   * Said out loud because searches are billed per search on top of tokens, and
   * because a feature nobody can see the cost of is one nobody notices has run
   * away. The Brave version this replaced was never configured and reported
   * nothing, so it looked identical to a feature that was simply never needed.
   */
  if (searches > 0) {
    console.log(`[engine] ${searches} web search(es), ${sources.length} cited source(s)`);
    // Searching and citing nothing is the state worth noticing: the answer
    // leans on the web and the reader has no way to check it, which is the
    // exact thing the switch away from Brave was meant to buy.
    if (sources.length === 0) {
      console.warn('[engine] searched but returned NO citations — external claims in this answer are unverifiable by the reader.');
    }
  }

  // Folded across the whole turn: `extractSources` groups within one response,
  // and the same page is commonly cited in several of them.
  return { answer, toolCalls, charts, sources: mergeSources(sources) };
}
