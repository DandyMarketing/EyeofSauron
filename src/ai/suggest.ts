/**
 * The next message, suggested (Khai, 23 Nov 2026: "suggest answers in the chat
 * like how claude does it now ... then pressing tab fills in"). After each
 * answer in Query and Plan, one short suggestion appears as grey text in the
 * empty box; Tab puts it in, and on a phone a chip does. Decided with Khai:
 * one suggestion, both pages, written by Haiku 5.5 (about US$0.0005 each).
 *
 * A SUGGESTION IS NEVER SENT AND NEVER A FIGURE. It only fills the box for the
 * person to edit or send, and it may not introduce a number the answer did not
 * contain -- in Plan above all, where a suggested reply is a decision the
 * person makes, not one the model makes for them. `cleanSuggestion()` is the
 * control on shape; the prompt is the hint on content.
 */

export const SUGGEST_MODEL = process.env.SAURON_MODEL_SUGGEST || 'claude-haiku-5-5';
export const SUGGEST_MAX_CHARS = 120;
const ANSWER_CHARS = 6000;

export type SuggestPage = 'chat' | 'plan';

export function suggestPrompt(page: SuggestPage, question: string, answer: string): { system: string; user: string } {
  const role = page === 'plan'
    ? 'The person is planning a restaurant event with a planner that asks them one question at a time. Suggest a short, natural REPLY to the planner\'s last question, in the person\'s voice. Offer a sensible starting position they can edit, never a final decision dressed up as fact.'
    : 'The person runs restaurants and is asking an analytics assistant about their venues\' sales, covers, costs and guests. Suggest the single most useful FOLLOW-UP QUESTION they would ask next, in their voice.';
  return {
    system:
      `${role}\n` +
      `Rules: one line, under ${SUGGEST_MAX_CHARS} characters. No figures, dates or names that do not appear in the exchange below. ` +
      'No quotation marks, no preamble, no explanation. Output only the message itself.',
    // The END of a long answer is where its question or next step sits.
    user: `The person said:\n${question.slice(0, 1500)}\n\nThe ${page === 'plan' ? 'planner' : 'assistant'} answered:\n${answer.length > ANSWER_CHARS ? '...' + answer.slice(-ANSWER_CHARS) : answer}`,
  };
}

/** One clean line, or null when the model wrote nothing usable. */
export function cleanSuggestion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  s = s.replace(/^(suggestion|reply|follow-up|next)\s*:\s*/i, '').replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (s.length < 3) return null;
  if (s.length > SUGGEST_MAX_CHARS) {
    const cut = s.slice(0, SUGGEST_MAX_CHARS);
    s = cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trim() + '…';
  }
  return s;
}
