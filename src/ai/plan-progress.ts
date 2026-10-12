import { PLAYBOOK, type PlaybookRow, type Stage } from './event-playbook.js';

/**
 * How far a planning conversation has got, as something a person can SEE.
 *
 * Khai, 12 Oct 2026, after a New Year's Eve plan ran eight exchanges: "It keeps
 * asking without sign of progress." Every answer ended in a new question and
 * nothing on screen said what the previous answers had settled, so a
 * conversation that WAS moving felt like an interrogation going nowhere.
 *
 * MEASURED BY A SECOND PASS, NOT CLAIMED BY THE PLANNER. The planner saying
 * "we have settled six things" is the model marking its own homework. A cheap
 * forced-tool call reads the transcript against the playbook's twenty decisions
 * and says which are settled, in the person's own words -- the same two-pass
 * shape as the draft and the recommendation engine. It is still a model's
 * reading, so the panel says "as read from the conversation", and every key is
 * checked against the playbook before it is shown.
 */

/** Short names for the panel. The playbook's `decision` line is the full one. */
export const DECISION_LABELS: Record<string, string> = {
  objective: 'Objective & target',
  target_demographic: 'Who it is for',
  audience_motivation: 'Why they come',
  usp_and_differentiation: 'What makes it different',
  venue_fit: 'Venue fit',
  scope: 'One event or several',
  date_and_why: 'Date',
  competing_events: 'What else is on',
  product_shape: 'Product (ticket, walk-in)',
  partner_terms: 'Partner terms',
  price_and_basis: 'Price',
  cost_build_and_breakeven: 'Costs & break-even',
  ad_spend: 'Paid budget',
  campaign_length: 'Campaign length',
  channels: 'Channels',
  alternative_channels: 'Other channels',
  content_plan: 'Content schedule',
  direct_outreach: 'Direct outreach',
  owners_and_deadlines: 'Owners & deadlines',
  abort_condition: 'Abort condition',
};

export const STAGE_LABELS: Record<Stage, string> = {
  point: 'The point',
  shape: 'The shape',
  money: 'The money',
  campaign: 'The campaign',
  follow_through: 'Follow-through',
};

const KEYS = PLAYBOOK.map(r => r.key);

/** The forced tool the second pass fills in. */
export function progressTool() {
  return {
    name: 'record_plan_progress',
    description: 'Record which planning decisions the conversation has settled, which do not apply, and what is waiting on somebody outside it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        settled: {
          type: 'array',
          description: 'Decisions the PERSON has actually settled -- said, or agreed to when the director proposed it. A question asked but not answered is NOT settled. A direction ("it is ticketed") settles what it settles and no more.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: KEYS },
              summary: { type: 'string', description: 'What was settled, in at most twelve words, in the conversation\'s own terms. Figures only if they appear in the transcript.' },
            },
            required: ['key', 'summary'],
          },
        },
        not_applicable: {
          type: 'array',
          description: 'Decisions that plainly do not apply to this event (e.g. partner_terms with no partner, scope with one venue). Leave out anything merely unsettled.',
          items: { type: 'string', enum: KEYS },
        },
        waiting_on: {
          type: 'array',
          description: 'Things that cannot be settled in the conversation because they need somebody outside it: a call, a quote, a signature. At most six.',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'What, in at most ten words.' },
              who: { type: 'string', description: 'Who it is with, if the conversation says.' },
            },
            required: ['item'],
          },
        },
        next: { type: 'string', enum: KEYS, description: 'The one unsettled decision the conversation is on now, or should be.' },
      },
      required: ['settled', 'not_applicable', 'waiting_on'],
    },
  };
}

export interface PlanProgress {
  settled: Array<{ key: string; label: string; stage: Stage; summary: string }>;
  open: Array<{ key: string; label: string; stage: Stage; blocking: boolean }>;
  not_applicable: string[];
  waiting_on: Array<{ item: string; who: string | null }>;
  next: { key: string; label: string } | null;
  /** Settled out of the decisions that apply. */
  counts: { settled: number; applicable: number };
  stages: Array<{ stage: Stage; label: string; settled: number; applicable: number }>;
}

/**
 * Turn the second pass's output into the panel's figures.
 *
 * Pure, and defensive: the input came from a model, so an unknown key is
 * dropped rather than shown, a key settled twice counts once, and a key both
 * settled and "not applicable" counts as settled.
 */
export function summariseProgress(raw: unknown, rows: PlaybookRow[] = PLAYBOOK): PlanProgress {
  const r = (raw ?? {}) as any;
  const byKey = new Map(rows.map(row => [row.key, row]));
  const label = (k: string) => DECISION_LABELS[k] ?? k;

  const settledMap = new Map<string, string>();
  for (const s of Array.isArray(r.settled) ? r.settled : []) {
    if (s && byKey.has(s.key) && !settledMap.has(s.key)) settledMap.set(s.key, String(s.summary ?? '').trim());
  }
  const na = new Set<string>(
    (Array.isArray(r.not_applicable) ? r.not_applicable : []).filter((k: string) => byKey.has(k) && !settledMap.has(k)),
  );

  const settled = rows.filter(row => settledMap.has(row.key))
    .map(row => ({ key: row.key, label: label(row.key), stage: row.stage, summary: settledMap.get(row.key)! }));
  const open = rows.filter(row => !settledMap.has(row.key) && !na.has(row.key))
    .map(row => ({ key: row.key, label: label(row.key), stage: row.stage, blocking: row.blocking }));

  const stageOrder: Stage[] = ['point', 'shape', 'money', 'campaign', 'follow_through'];
  const stages = stageOrder.map(stage => {
    const applicable = rows.filter(row => row.stage === stage && !na.has(row.key));
    return {
      stage, label: STAGE_LABELS[stage],
      settled: applicable.filter(row => settledMap.has(row.key)).length,
      applicable: applicable.length,
    };
  }).filter(s => s.applicable > 0);

  const nextKey = typeof r.next === 'string' && byKey.has(r.next) && !settledMap.has(r.next)
    ? r.next : (open.find(o => o.blocking)?.key ?? null);

  const waiting = (Array.isArray(r.waiting_on) ? r.waiting_on : [])
    .filter((w: any) => w && typeof w.item === 'string' && w.item.trim())
    .slice(0, 6)
    .map((w: any) => ({ item: w.item.trim(), who: typeof w.who === 'string' && w.who.trim() ? w.who.trim() : null }));

  return {
    settled, open, not_applicable: [...na], waiting_on: waiting,
    next: nextKey ? { key: nextKey, label: label(nextKey) } : null,
    counts: { settled: settled.length, applicable: settled.length + open.length },
    stages,
  };
}

/**
 * The transcript as the second passes read it. The person is named as such:
 * the page calls the AGENT "Planner", and labelling the person PLANNER here made
 * a draft attribute the person's words to the agent ("planner confirmed").
 */
export function planTranscript(history: Array<{ role: string; content: string }>): string {
  return history
    .map(m => `${m.role === 'user' ? 'THE PERSON PLANNING' : 'THE DIRECTOR (you)'}: ${m.content}`)
    .join('\n\n');
}
