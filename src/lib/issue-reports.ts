/**
 * "Report this issue" (Khai, 13 Oct 2026, with Sauron in daily use by the
 * team): a button under every answer that sends the whole conversation to the
 * admins, so a wrong answer, a question it could not answer, or an error can be
 * reviewed -- by Khai, and with Claude -- and fixed at the cause.
 *
 * Pure: what a report may contain, checked, and the text a report becomes when
 * it is copied out for review. The reading and writing is in server.ts.
 */

export const REPORT_KINDS = ['wrong', 'cannot_answer', 'error', 'other'] as const;
export type ReportKind = typeof REPORT_KINDS[number];

export const KIND_LABELS: Record<ReportKind, string> = {
  wrong: 'Answered incorrectly',
  cannot_answer: 'Could not answer',
  error: 'Showed an error',
  other: 'Something else',
};

export const REPORT_STATUSES = ['new', 'looking', 'fixed', 'wont_fix'] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

export interface ReportInput {
  kind: ReportKind;
  page: 'chat' | 'plan';
  comment: string | null;
  conversation_id: string | null;
  question: string | null;
  answer: string | null;
  error: string | null;
  context: { model?: string; user_agent?: string; url?: string; app_version?: string };
  /**
   * The conversation as it was on the person's screen. The saved conversation
   * misses exactly what usually needs reporting: an answer that errored is
   * never saved, and a chat whose first answer failed has no saved record.
   */
  screen: ScreenMessage[];
}

export interface ScreenMessage { role: 'user' | 'assistant'; content: string }

/** Nothing shorter is a description of a problem. */
export const MIN_DESCRIPTION = 3;

function cleanScreen(raw: unknown): ScreenMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-300).flatMap((m: any) => {
    const content = text(m?.content, 20000);
    if (!content || (m.role !== 'user' && m.role !== 'assistant')) return [];
    return [{ role: m.role, content }];
  });
}

/**
 * Whether the screen shows the admins something the saved conversation does
 * not: nothing was saved, or the person asked more than was saved. Counted on
 * questions because a saved answer is markdown and the screen shows it
 * rendered, so the two never match as text.
 */
export function screenAddsToSaved(saved: Array<{ role: string }>, screen: ScreenMessage[]): boolean {
  if (!screen.length) return false;
  const asked = (xs: Array<{ role: string }>) => xs.filter(m => m.role === 'user').length;
  return saved.length === 0 || asked(screen) > asked(saved);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (x: unknown, max: number): string | null =>
  typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null;

/**
 * What came back from a browser, checked. A browser can send anything, so the
 * kind and page are from fixed lists, ids are ids, and every text has a ceiling.
 * Null for something that is not a report at all.
 */
export function cleanReportInput(raw: any): ReportInput | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!(REPORT_KINDS as readonly string[]).includes(raw.kind)) return null;
  if (raw.page !== 'chat' && raw.page !== 'plan') return null;
  const ctx = raw.context && typeof raw.context === 'object' ? raw.context : {};
  return {
    kind: raw.kind,
    page: raw.page,
    comment: text(raw.comment, 4000),
    conversation_id: typeof raw.conversation_id === 'string' && UUID.test(raw.conversation_id) ? raw.conversation_id : null,
    question: text(raw.question, 20000),
    answer: text(raw.answer, 40000),
    error: text(raw.error, 4000),
    screen: cleanScreen(raw.screen),
    context: {
      ...(text(ctx.model, 80) ? { model: text(ctx.model, 80)! } : {}),
      ...(text(ctx.user_agent, 300) ? { user_agent: text(ctx.user_agent, 300)! } : {}),
      ...(text(ctx.url, 300) ? { url: text(ctx.url, 300)! } : {}),
      ...(text(ctx.app_version, 80) ? { app_version: text(ctx.app_version, 80)! } : {}),
    },
  };
}

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  at?: string | null;
  tool_trace?: Array<{ name: string; input?: unknown; result?: string; ms?: number }> | null;
  /** How the answer ran: models, stop reasons, tokens, time, rounds, rescue. */
  run?: {
    purpose?: string; model_chosen?: string; rounds?: number; ms?: number; out_of_time?: boolean;
    rescued?: string | null; recovery_error?: string | null; web_searches?: number; charts?: string[];
    calls?: Array<{ model: string; effort?: string; stop_reason: string | null; input_tokens: number | null; output_tokens: number | null; cache_read?: number | null; ms: number; rescue?: boolean }>;
  } | null;
}

export interface StoredReport {
  id: string;
  created_at: string;
  reporter_name: string | null;
  reporter_email: string | null;
  kind: ReportKind;
  page: 'chat' | 'plan';
  comment: string | null;
  question: string | null;
  answer: string | null;
  error: string | null;
  transcript: TranscriptEntry[];
  context: Record<string, unknown> | null;
  status: ReportStatus;
  admin_notes: string | null;
}

/**
 * The report as one block of text, for "Copy for Claude": everything needed to
 * find the cause without access to the database -- what was asked, what came
 * back, and for every answer which data tools ran, with what input, what they
 * returned and how long they took. That last part is usually where a wrong
 * answer comes from (the 10 Oct brunch read the whole day's bookings, visible
 * only in the tool's input).
 */
export function reportMarkdown(r: StoredReport): string {
  const lines: string[] = [];
  lines.push(`# Sauron issue report ${r.id}`);
  lines.push('');
  lines.push(`- **When:** ${r.created_at}`);
  lines.push(`- **Reported by:** ${r.reporter_name || '—'}${r.reporter_email ? ` <${r.reporter_email}>` : ''}`);
  lines.push(`- **Problem:** ${KIND_LABELS[r.kind] ?? r.kind}`);
  lines.push(`- **Where:** ${r.page === 'plan' ? 'Event planner' : 'Chat'}`);
  lines.push(`- **Status:** ${r.status}`);
  const ctx = r.context ?? {};
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'plan_progress' || k === 'screen') continue;
    lines.push(`- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  if (r.comment) { lines.push('', '## What they said', '', r.comment); }
  if (r.error) { lines.push('', '## Error shown', '', '```', r.error, '```'); }
  if (r.question) { lines.push('', '## The question reported', '', r.question); }
  if (r.answer) { lines.push('', '## The answer reported', '', r.answer); }
  if (r.transcript?.length) {
    lines.push('', `## Whole conversation (${r.transcript.length} messages)`);
    r.transcript.forEach((m, i) => {
      lines.push('', `### ${i + 1}. ${m.role === 'user' ? 'Question' : 'Sauron'}${m.at ? ` — ${m.at}` : ''}`, '', m.content || '(empty)');
      if (m.run) {
        const rn = m.run;
        lines.push('', `- How it ran: ${rn.rounds ?? 0} tool round(s), ${((rn.ms ?? 0) / 1000).toFixed(1)}s, purpose ${rn.purpose ?? '—'}` +
          `${rn.out_of_time ? ', RAN OUT OF TIME' : ''}${rn.rescued ? `, rescued (${rn.rescued})` : ''}${rn.recovery_error ? `, rescue failed: ${rn.recovery_error}` : ''}` +
          `${rn.web_searches ? `, ${rn.web_searches} web search(es)` : ''}${rn.charts?.length ? `, charts: ${rn.charts.join('; ')}` : ''}`);
        for (const c of rn.calls ?? []) {
          lines.push(`  - call: ${c.model}${c.effort ? ` (${c.effort})` : ''}, stop ${c.stop_reason ?? '—'}, in ${c.input_tokens ?? '—'} / out ${c.output_tokens ?? '—'} tokens${c.cache_read ? `, cache read ${c.cache_read}` : ''}, ${c.ms} ms${c.rescue ? ', RESCUE' : ''}`);
        }
      }
      for (const t of m.tool_trace ?? []) {
        lines.push('', `- Tool \`${t.name}\`${typeof t.ms === 'number' ? ` (${t.ms} ms)` : ''}`);
        lines.push(`  - input: \`${JSON.stringify(t.input ?? {})}\``);
        if (t.result) lines.push('  - returned:', '', '```json', t.result, '```');
      }
    });
  }
  const screen: ScreenMessage[] = Array.isArray((ctx as any).screen) ? (ctx as any).screen : [];
  if (screenAddsToSaved(r.transcript ?? [], screen)) {
    lines.push('', `## On their screen (${screen.length} messages)`, '',
      r.transcript?.length
        ? '_More than was saved: an exchange that failed is never saved. Text as the page showed it._'
        : '_Nothing of this conversation was saved, so this is the only record. Text as the page showed it._');
    screen.forEach((m, i) => lines.push('', `### ${i + 1}. ${m.role === 'user' ? 'Question' : 'Sauron'}`, '', m.content));
  }
  if (ctx && (ctx as any).plan_progress) {
    lines.push('', '## Plan progress board at the time', '', '```json', JSON.stringify((ctx as any).plan_progress, null, 1).slice(0, 12000), '```');
  }
  if (r.admin_notes) { lines.push('', '## Admin notes', '', r.admin_notes); }
  return lines.join('\n');
}
