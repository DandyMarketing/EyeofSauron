/**
 * The admin page's usage figures, from ai_usage_summary() rows (migration 065).
 * Pure, so the arithmetic is tested without a database.
 */

export interface SummaryRow {
  user_id: string | null;
  feature: 'query' | 'plan' | 'system';
  model: string;
  calls: number;
  answers: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  web_searches: number;
  cost_usd: number;
  unpriced: number;
}

export interface Spend {
  /** Answers given: a Query answer or a Plan reply, however many calls it took. */
  answers: number;
  /** Every call to the AI, including the planner's passes and titles. */
  calls: number;
  cost_usd: number;
  /** Calls whose model has no price in ai-pricing.ts, so cost_usd is short. */
  unpriced: number;
}

export interface PersonUsage extends Spend {
  by_feature: Partial<Record<'query' | 'plan' | 'system', Spend>>;
  by_model: Record<string, Spend>;
}

export interface UsageSummary {
  month: { key: string; label: string; from: string; to: string };
  people: Record<string, PersonUsage>;
  system: PersonUsage | null;
  total: Spend;
}

const SGT = '+08:00';

/**
 * A calendar month in SINGAPORE time, as [from, to). "2026-10" is 1 Oct 00:00
 * to 1 Nov 00:00 SGT -- an answer at 7am on the 1st belongs to the new month,
 * as it does on the venue's clock, though it is still the 31st in UTC.
 */
export function monthWindow(key: string | null | undefined, today: string): { key: string; label: string; from: string; to: string } {
  const valid = typeof key === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
  const k = valid ? key! : today.slice(0, 7);
  const [y, m] = k.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-SG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { key: k, label, from: `${k}-01T00:00:00${SGT}`, to: `${next}-01T00:00:00${SGT}` };
}

const empty = (): Spend => ({ answers: 0, calls: 0, cost_usd: 0, unpriced: 0 });

function add(s: Spend, r: SummaryRow): void {
  s.answers += Number(r.answers) || 0;
  s.calls += Number(r.calls) || 0;
  s.cost_usd += Number(r.cost_usd) || 0;
  s.unpriced += Number(r.unpriced) || 0;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

function tidy<T extends Spend>(s: T): T { s.cost_usd = round(s.cost_usd); return s; }

/**
 * Per person, plus System (no one signed in) and the total. Answers are added
 * across models, which is right because the engine uses ONE model per answer
 * (the purpose is chosen once per request) -- except a rescue on the recovery
 * model, which can count an answer twice. A small overstatement of answers,
 * never of cost.
 */
export function summariseUsage(rows: SummaryRow[], month: UsageSummary['month']): UsageSummary {
  const people: Record<string, PersonUsage> = {};
  let system: PersonUsage | null = null;
  const total = empty();

  for (const r of rows) {
    const who = r.user_id
      ? (people[r.user_id] ??= { ...empty(), by_feature: {}, by_model: {} })
      : (system ??= { ...empty(), by_feature: {}, by_model: {} });
    add(who, r);
    add((who.by_feature[r.feature] ??= empty()), r);
    add((who.by_model[r.model] ??= empty()), r);
    add(total, r);
  }

  for (const p of [...Object.values(people), ...(system ? [system] : [])]) {
    tidy(p);
    Object.values(p.by_feature).forEach(s => tidy(s!));
    Object.values(p.by_model).forEach(tidy);
  }
  return { month, people, system, total: tidy(total) };
}
