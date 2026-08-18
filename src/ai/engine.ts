import Anthropic from '@anthropic-ai/sdk';
import { queryTools } from './tools.js';
import { handleToolCall } from './tool-handlers.js';
import { fetchNotes, formatNotes, KNOWLEDGE_FRAMING } from './knowledge.js';

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

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: question },
  ];

  let response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    tools: queryTools,
    messages,
  });

  // Tool use loop
  let rounds = 0;
  while (response.stop_reason === 'tool_use' && rounds++ < MAX_TOOL_ROUNDS) {
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

    response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: queryTools,
      messages,
    });
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
      const recovery = await client.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: MAX_TOKENS,
        system: `${systemPrompt}\n\n${reason} Answer the user now, concisely, using only the data already gathered in this conversation. Do not request more data. If you genuinely have nothing, say so plainly and suggest what to ask instead.`,
        messages,
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

  return { answer, toolCalls, charts };
}
