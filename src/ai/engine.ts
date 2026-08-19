import Anthropic from '@anthropic-ai/sdk';
import { queryTools } from './tools.js';
import { handleToolCall } from './tool-handlers.js';
import { fetchNotes, formatNotes, KNOWLEDGE_FRAMING } from './knowledge.js';
import {
  webSearchTool,
  extractSources,
  searchErrors,
  searchRequestCount,
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

When answering:
- Always query the data first. Never state a number from memory.
- If data isn't available for the requested date/venue, say so clearly.
- Format currency as SGD with $ prefix.
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

// 2048 was too tight once answers began carrying tables and chart commentary.
// Running out mid-response is what produced empty replies: the turn ends with
// stop_reason 'max_tokens' and, if the model was still emitting tool calls,
// no text block at all.
// 4096 was too tight for an analytical answer that also has to interpret a
// chart: the model would spend the budget on tool calls, get cut off before
// writing anything, and the user got a blank recovery message instead of the
// analysis it had already done the work for.
const MAX_TOKENS = 8192;

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

export async function askSauron(
  question: string,
  history: ChatMessage[] = [],
  venueFilter?: string[],
): Promise<QueryResult> {
  const toolCalls: QueryResult['toolCalls'] = [];
  const charts: QueryResult['charts'] = [];

  const today = getSingaporeDate();
  let systemPrompt = `${SYSTEM_PROMPT_BASE}\n\nToday's date is ${today}. When a user says "yesterday", they mean ${new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0]}. When a user says "July 23" without a year, assume the current year.`;
  // The tool layer is the actual control; this only keeps the model from
  // promising data it will then be refused. An empty list means no venues at
  // all, which must not read as "no restriction".
  if (venueFilter && venueFilter.length > 0) {
    systemPrompt += `\n\nIMPORTANT: This user only has access to these venues: ${venueFilter.join(', ')}. Only query and discuss data for these venues. If asked about other venues, say you don't have access.`;
  } else if (venueFilter) {
    systemPrompt += `\n\nIMPORTANT: This user has not been assigned to any venue, so no venue data is available to them. Do not attempt to query venue data. Tell them their account has no venue access yet and to contact HQ.`;
  }

  // Notes are scoped to the caller's venues. They used to be selected
  // unfiltered and appended here, one line below the text telling the user
  // which venues they may see -- so a venue manager received every other
  // venue's notes, which are free text and could say anything.
  const notes = await fetchNotes(venueFilter ?? null);
  const notesText = formatNotes(notes, today);
  if (notesText) {
    systemPrompt += `\n${KNOWLEDGE_FRAMING}\n\n${notesText}`;
  }

  systemPrompt += `\n${EXTERNAL_CONTEXT_FRAMING}`;

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

  /**
   * Every request goes through here so nothing has to remember to account for
   * a response. Sources, search count and search failures were being collected
   * in one place and missed in another the first time this was written.
   */
  const send = async (opts: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}) => {
    const r = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
      ...opts,
    });

    sources.push(...extractSources(r.content));
    searches += searchRequestCount(r.usage);

    // A failed search returns HTTP 200 with an error object where the results
    // should be, so it is invisible unless it is said out loud. The model
    // carries on and writes an answer with no external context in it, which
    // reads exactly like an answer that did not need any.
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

    messages.push({ role: 'user', content: toolResults });

    response = await send();
  }

  let answer = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('\n');

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
        system: `${systemPrompt}\n\n${reason} Answer the user now, concisely, using only the data already gathered in this conversation. Do not request more data. If you genuinely have nothing, say so plainly and suggest what to ask instead.`,
      });
      answer = recovery.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('\n');
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
  }

  // Deduplicated across the whole turn: `extractSources` dedupes within one
  // response, and the same page is commonly cited in several of them.
  const seen = new Set<string>();
  const uniqueSources = sources.filter(s => {
    const key = `${s.url}|${s.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { answer, toolCalls, charts, sources: uniqueSources };
}
