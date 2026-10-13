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
  usp_and_differentiation: 'Selling point & what to push',
  venue_fit: 'Venue fit',
  scope: 'One event or several',
  date_and_why: 'Date',
  competing_events: 'What else is on',
  product_shape: 'Product (ticket, walk-in)',
  partner_terms: 'Partner terms',
  price_and_basis: 'Price',
  cost_build_and_breakeven: 'Costs & break-even',
  ad_spend: 'Money for ads',
  campaign_length: 'Campaign length',
  channels: 'Channels',
  alternative_channels: 'Other channels',
  content_plan: 'Content schedule',
  direct_outreach: 'Direct outreach',
  owners_and_deadlines: 'Owners & deadlines',
  abort_condition: 'Abort condition',
};

/**
 * One line on what each decision actually asks, for the board's open list.
 * Khai, 12 Oct 2026: "elaborate on this a little bit but keep everything one
 * line so people know what it is about specifically". Plain words, no
 * figures, at most 60 characters -- a test holds that.
 */
export const DECISION_HINTS: Record<string, string> = {
  objective: 'The number that proves it worked, vs a normal night',
  target_demographic: 'Exactly which guests: who, what they spend',
  audience_motivation: 'Why they give up their night for this',
  usp_and_differentiation: 'What sets it apart, and the draw to push hardest',
  venue_fit: 'Why it belongs in this room and not another',
  scope: 'One event across venues, or separate ones sharing a date',
  date_and_why: 'The date, and whether it fills or spends a night',
  competing_events: 'What else that night pulls the same people away',
  product_shape: 'What a guest buys: ticket, set menu, table, walk-in',
  partner_terms: 'What each partner gives, gets and owes, in writing',
  price_and_basis: 'The price, checked against food and drink averages',
  cost_build_and_breakeven: 'Every cost, and the covers needed to break even',
  ad_spend: 'Paid ads: how much, what it buys, who signs it off',
  campaign_length: 'How many weeks of promotion, and what each week does',
  channels: 'Each channel in or out (IG, TikTok, email) and which books',
  alternative_channels: 'Borrowed trust: communities, clubs, concierges, institutions',
  content_plan: 'Every post with a date: what goes out when',
  direct_outreach: 'Who gets a personal message, and on which days',
  owners_and_deadlines: 'A person and a date against every task',
  abort_condition: 'Bookings needed by when, and what we do if short',
};

export const STAGE_LABELS: Record<Stage, string> = {
  point: 'The point',
  shape: 'The shape',
  money: 'The money',
  campaign: 'The campaign',
  follow_through: 'Follow-through',
};

const KEYS = PLAYBOOK.map(r => r.key);

/**
 * What each decision MEANS, for the reader. Given only the keys it guessed:
 * "four tickets, not one wristband" was filed under price, when it is scope.
 */
export function decisionGuide(rows: PlaybookRow[] = PLAYBOOK): string {
  return rows.map(r => `- ${r.key} (${DECISION_LABELS[r.key] ?? r.key}): ${r.decision}`).join('\n');
}

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
          description: 'Decisions the PERSON has actually settled -- said, or agreed to when the director proposed it. A question asked but not answered is NOT settled. A direction ("it is ticketed") settles what it settles and no more. A CHOICE THAT IS MADE IS SETTLED even if its fee, quote or signature is still pending -- the pending part goes in waiting_on, so one outstanding quote does not hold a decision open. Likewise a decision whose only missing piece has been PARKED as a task with an owner and a date because nobody can supply it yet -- the DJ not yet booked, a landlord not yet reached -- is SETTLED, with the task in waiting_on. Never list a parked task as the thing missing in partial. A decision that came up only in passing inside another one (channels mentioned inside the ad budget) is NOT settled: it goes in partial.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: KEYS },
              summary: { type: 'string', description: 'What was settled, in at most twelve words, in the conversation\'s own terms. Figures only if they appear in the transcript.' },
            },
            required: ['key', 'summary'],
          },
        },
        partial: {
          description: 'Decisions the conversation has touched but not settled: something is agreed, one named thing is missing. Only for decisions not in settled.',
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: KEYS },
              agreed: { type: 'string', description: 'What IS agreed, at most twelve words.' },
              missing: { type: 'string', description: 'The one thing still missing, at most twelve words: "the Instagram plan, and which channel brings bookings".' },
            },
            required: ['key', 'agreed', 'missing'],
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
        reopened: {
          type: 'array',
          description: 'Only when there is a PREVIOUS READING: decisions it counted as settled that the conversation has since genuinely reopened -- the person changed it, or new facts broke it. Missing it on this read is NOT a reason. Each needs the reason in the conversation\'s words.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: KEYS },
              why: { type: 'string', description: 'What reopened it, at most fifteen words: "late door changed from $80 to $60".' },
            },
            required: ['key', 'why'],
          },
        },
        next: { type: 'string', enum: KEYS, description: 'The one unsettled decision the conversation is on now, or should be.' },
      },
      required: ['settled', 'not_applicable', 'waiting_on'],
    },
  };
}

export interface PlanProgress {
  settled: Array<{ key: string; label: string; stage: Stage; summary: string; by_you?: boolean }>;
  open: Array<{ key: string; label: string; hint: string; stage: Stage; blocking: boolean; partial?: { agreed: string; missing: string } }>;
  not_applicable: string[];
  waiting_on: Array<{ item: string; who: string | null }>;
  next: { key: string; label: string } | null;
  /** Settled out of the decisions that apply. */
  counts: { settled: number; applicable: number };
  stages: Array<{ stage: Stage; label: string; settled: number; applicable: number }>;
  /** Settled on the previous reading, reopened by the conversation since, with why. */
  reopened: Array<{ key: string; label: string; why: string }>;
}

export interface PreviousReading {
  settled: Array<{ key: string; summary: string }>;
  not_applicable: string[];
}

/**
 * The previous reading, as it came back from the browser, checked. Unknown
 * keys are dropped and summaries trimmed; anything malformed is no previous
 * reading at all, which only means this read starts fresh.
 */
export function cleanPrevious(raw: unknown, rows: PlaybookRow[] = PLAYBOOK): PreviousReading | null {
  const r = raw as any;
  if (!r || typeof r !== 'object') return null;
  const known = new Set(rows.map(x => x.key));
  const settled = (Array.isArray(r.settled) ? r.settled : [])
    .filter((x: any) => x && known.has(x.key))
    .map((x: any) => ({ key: String(x.key), summary: String(x.summary ?? '').slice(0, 200) }));
  const na = (Array.isArray(r.not_applicable) ? r.not_applicable : []).filter((k: any) => typeof k === 'string' && known.has(k));
  return settled.length || na.length ? { settled, not_applicable: na } : null;
}

/**
 * Carry the previous reading forward.
 *
 * Khai, 13 Oct 2026: "progress kept fluctuating 20/20 then after one response
 * went to this". Every reading started from nothing, so two reads of the same
 * long conversation disagreed -- and the planner said "hit Create" on one read
 * while the next blocked the draft. A decision settled once now STAYS settled
 * (keeping its summary unless the new read has a fresher one) and a decision
 * judged not to apply stays that way, unless the reader names it as reopened
 * with a reason. So the count moves only when the plan does, and when it goes
 * down the board says why.
 */
export function withPrevious(raw: unknown, previous: PreviousReading | null): unknown {
  if (!previous) return raw;
  const r = { ...((raw ?? {}) as any) };
  const reopened = new Set<string>((Array.isArray(r.reopened) ? r.reopened : [])
    .filter((x: any) => x && typeof x.key === 'string' && String(x.why ?? '').trim())
    .map((x: any) => x.key));
  const settled: Array<{ key: string; summary: string }> = Array.isArray(r.settled) ? [...r.settled] : [];
  const has = new Set(settled.map(x => x?.key));
  for (const p of previous.settled) {
    if (!has.has(p.key) && !reopened.has(p.key)) { settled.push(p); has.add(p.key); }
  }
  const na = new Set<string>(Array.isArray(r.not_applicable) ? r.not_applicable : []);
  for (const k of previous.not_applicable) if (!has.has(k) && !reopened.has(k)) na.add(k);
  r.settled = settled;
  r.not_applicable = [...na];
  return r;
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

  const manual = new Set<string>(Array.isArray(r.manual) ? r.manual : []);
  const settled = rows.filter(row => settledMap.has(row.key))
    .map(row => ({
      key: row.key, label: label(row.key), stage: row.stage, summary: settledMap.get(row.key)!,
      ...(manual.has(row.key) ? { by_you: true } : {}),
    }));
  const partials = new Map<string, { agreed: string; missing: string }>();
  for (const pt of Array.isArray(r.partial) ? r.partial : []) {
    if (pt && byKey.has(pt.key) && !settledMap.has(pt.key) && !partials.has(pt.key) && String(pt.missing ?? '').trim()) {
      partials.set(pt.key, { agreed: String(pt.agreed ?? '').trim(), missing: String(pt.missing).trim() });
    }
  }
  const open = rows.filter(row => !settledMap.has(row.key) && !na.has(row.key))
    .map(row => ({
      key: row.key, label: label(row.key), hint: DECISION_HINTS[row.key] ?? '', stage: row.stage, blocking: row.blocking,
      ...(partials.has(row.key) ? { partial: partials.get(row.key)! } : {}),
    }));

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

  const reopened = (Array.isArray(r.reopened) ? r.reopened : [])
    .filter((x: any) => x && byKey.has(x.key) && !settledMap.has(x.key) && String(x.why ?? '').trim())
    .map((x: any) => ({ key: x.key, label: label(x.key), why: String(x.why).trim().slice(0, 200) }));

  return {
    reopened,
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

/**
 * What the board says, handed to the planner with the next message.
 *
 * Khai, 13 Oct 2026, on the New Year's Eve plan: the board showed Channels and
 * Other channels open while the planner told him "every blocking decision is
 * closed" and then "CONFIRMED". The board was right -- channels had only come
 * up inside the ad budget, and the Instagram plan, TikTok and email were never
 * asked about. The planner could not see the board, so the two disagreed and
 * the planner was the one that was wrong.
 *
 * Keys come from the browser, so each is checked against the playbook and an
 * unknown one is dropped. Empty when nothing blocking is open. A HINT, not a
 * control -- the control is that only the Create button writes anything.
 */
export function boardNote(openKeys: unknown, rows: PlaybookRow[] = PLAYBOOK): string {
  const byKey = new Map(rows.map(r => [r.key, r]));
  // Each entry is a key, or { key, missing } when the board knows what is
  // missing -- then the planner asks for exactly that.
  const missing = new Map<string, string>();
  const keys: string[] = [];
  for (const e of Array.isArray(openKeys) ? openKeys : []) {
    const k = typeof e === 'string' ? e : (e && typeof (e as any).key === 'string' ? (e as any).key : null);
    if (!k || !byKey.has(k) || !byKey.get(k)!.blocking) continue;
    keys.push(k);
    const m = typeof e === 'object' && e ? String((e as any).missing ?? '').trim().slice(0, 200) : '';
    if (m && !missing.has(k)) missing.set(k, m);
  }
  const unique = [...new Set(keys)].slice(0, 20);
  if (unique.length === 0) return '';
  const lines = unique.map(k => `- ${DECISION_LABELS[k] ?? k}: ${byKey.get(k)!.decision}${missing.has(k) ? ` MISSING: ${missing.get(k)}` : ''}`);
  return `\n\n[PROGRESS BOARD -- read from this conversation by a second pass, shown to the person. Still open and blocking:\n${lines.join('\n')}\nWhile anything is listed here, do not call the plan ready, complete, locked or confirmed, and do not say every blocking decision is closed. Answer the message above first, then take the next of these.]`;
}

/**
 * What is saved on the conversation (migration 056): the board's last reading,
 * already merged, and the decisions the person marked by hand.
 */
export interface StoredProgress { reading: unknown; manual: string[] }

export function parseStored(raw: unknown, rows: PlaybookRow[] = PLAYBOOK): StoredProgress | null {
  const r = raw as any;
  if (!r || typeof r !== 'object') return null;
  const known = new Set(rows.map(x => x.key));
  const manual = (Array.isArray(r.manual) ? r.manual : []).filter((k: any) => typeof k === 'string' && known.has(k));
  return { reading: r.reading ?? null, manual: [...new Set<string>(manual)] };
}

/**
 * The person's hand marks, laid over a reading. Khai, 13 Oct 2026: the board
 * is a model's reading of the chat, and the person is the one who knows what
 * is settled -- so a decision they mark as decided IS decided. It cannot be
 * reopened by a later reading, only by the person taking the mark off.
 */
export function applyManual(raw: unknown, manual: string[]): unknown {
  if (!manual.length) return raw;
  const r = { ...((raw ?? {}) as any) };
  const marked = new Set(manual);
  const settled: Array<{ key: string; summary: string }> = (Array.isArray(r.settled) ? r.settled : []).filter((x: any) => x && x.key);
  const has = new Set(settled.map(x => x.key));
  for (const k of manual) if (!has.has(k)) settled.push({ key: k, summary: 'Marked as decided by you' });
  r.settled = settled;
  r.not_applicable = (Array.isArray(r.not_applicable) ? r.not_applicable : []).filter((k: string) => !marked.has(k));
  r.partial = (Array.isArray(r.partial) ? r.partial : []).filter((x: any) => !marked.has(x?.key));
  r.reopened = (Array.isArray(r.reopened) ? r.reopened : []).filter((x: any) => !marked.has(x?.key));
  if (marked.has(r.next)) delete r.next;
  r.manual = manual;
  return r;
}

/** Add or remove one hand mark. Unknown keys change nothing. */
export function toggleManual(manual: string[], key: string, decided: boolean, rows: PlaybookRow[] = PLAYBOOK): string[] {
  if (!rows.some(r => r.key === key)) return manual;
  const set = new Set(manual);
  if (decided) set.add(key); else set.delete(key);
  return [...set];
}
