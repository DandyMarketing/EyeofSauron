/**
 * The draft's number fields, made safe for the events table.
 *
 * Khai, 13 Oct 2026: Create failed outright with `invalid input syntax for
 * type integer: "NA - break-even expressed as revenue: ..."` -- the draft had
 * written a sentence into break_even_covers. One bad field must not lose the
 * whole event, and a sentence must not be stored as a number either. So: a real
 * number passes; "$24,000" or "1,200" is read as the number it plainly is; text
 * is stored as nothing and NAMED, so the person sees what did not carry over.
 */

const NUMBER_FIELDS: Array<[key: string, label: string, integer: boolean]> = [
  ['target_net_sales', 'target sales', false],
  ['target_covers', 'target covers', true],
  ['target_spend_per_head', 'target spend per head', false],
  ['baseline_net_sales', 'baseline sales', false],
  ['baseline_covers', 'baseline covers', true],
  ['baseline_spend_per_head', 'baseline spend per head', false],
  ['price', 'price', false],
  ['price_basis_food_avg', 'food average', false],
  ['price_basis_bev_avg', 'drink average', false],
  ['cost_total', 'cost total', false],
  ['break_even_covers', 'break-even covers', true],
  ['ad_budget', 'ad budget', false],
];

export function toNumber(v: unknown, integer: boolean): { value: number | null; dropped: boolean } {
  if (v === null || v === undefined || v === '') return { value: null, dropped: false };
  let n: number | null = null;
  if (typeof v === 'number') n = Number.isFinite(v) ? v : null;
  else if (typeof v === 'string' && /^\s*\$?\s*-?[\d,]+(\.\d+)?\s*$/.test(v)) n = Number(v.replace(/[$,\s]/g, ''));
  if (n === null || !Number.isFinite(n)) return { value: null, dropped: true };
  return { value: integer ? Math.round(n) : n, dropped: false };
}

export function cleanEventNumbers(d: Record<string, unknown>): { values: Record<string, number | null>; dropped: string[] } {
  const values: Record<string, number | null> = {};
  const dropped: string[] = [];
  for (const [key, label, integer] of NUMBER_FIELDS) {
    const r = toNumber(d?.[key], integer);
    values[key] = r.value;
    if (r.dropped) dropped.push(label);
  }
  return { values, dropped };
}

/**
 * Every field of a fresh draft checked against the kind of cell it goes in,
 * the moment it is written (Khai, 13 Oct 2026: "make sure the right text is
 * put into the right type of cell"). The tool's schema says which field is a
 * number, a date or a list, but a model can still write a sentence where a
 * number belongs -- so this is the control, and the schema is the hint.
 *
 * A value in the wrong shape is CLEARED and NAMED in `notes`, shown on the
 * draft before anything is saved. Nothing is guessed: "$30,000" is plainly a
 * number; "about 200" is not, and is cleared rather than read as 200.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_FIELDS = ['name', 'occasion', 'concept_type', 'partner', 'format', 'demographic', 'concept', 'usp',
  'venue_fit', 'baseline_basis', 'ad_plan', 'abort_condition', 'brief'];

export function cleanDraft(raw: unknown): { draft: Record<string, any>; notes: string[] } {
  const d: Record<string, any> = raw && typeof raw === 'object' ? { ...(raw as any) } : {};
  const notes: string[] = [];
  const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback?: T) =>
    (allowed as readonly string[]).includes(String(v)) ? (v as T) : fallback;

  for (const k of TEXT_FIELDS) {
    if (d[k] === undefined || d[k] === null) continue;
    const t = text(d[k]);
    if (t === undefined) { delete d[k]; notes.push(`${k.replace(/_/g, ' ')}: not text, left empty`); } else d[k] = t;
  }
  for (const k of ['start_date', 'end_date']) {
    if (d[k] !== undefined && !(typeof d[k] === 'string' && DATE.test(d[k]))) {
      notes.push(`${k === 'start_date' ? 'Start' : 'End'} date: "${String(d[k]).slice(0, 40)}" is not a date, left empty`);
      delete d[k];
    }
  }
  const nums = cleanEventNumbers(d);
  for (const [k, v] of Object.entries(nums.values)) { if (v === null) delete d[k]; else d[k] = v; }
  for (const label of nums.dropped) notes.push(`${label[0].toUpperCase()}${label.slice(1)}: the draft wrote words, not a number, left empty`);

  d.venue_slugs = (Array.isArray(d.venue_slugs) ? d.venue_slugs : []).filter((x: unknown) => typeof x === 'string');

  // A number inside a list: cleared on that row, counted once per list.
  const numIn = (rows: any[], keys: Array<[string, boolean]>, what: string) => {
    let bad = 0;
    for (const r of rows) for (const [k, integer] of keys) {
      if (r[k] === undefined || r[k] === null) continue;
      const n = toNumber(r[k], integer);
      if (n.dropped) { delete r[k]; bad++; } else r[k] = n.value;
    }
    if (bad) notes.push(`${what}: ${bad} value${bad === 1 ? ' was' : 's were'} words where a number belongs, left empty`);
  };

  if (d.tasks !== undefined) {
    d.tasks = (Array.isArray(d.tasks) ? d.tasks : [])
      .filter((t: any) => t && typeof t === 'object' && text(t.description))
      .map((t: any) => ({
        ...t,
        description: text(t.description),
        kind: oneOf(t.kind, ['content', 'outreach', 'ops', 'other'] as const, 'other'),
        channel: text(t.channel) ?? null,
        owner_name: text(t.owner_name) ?? null,
      }));
    numIn(d.tasks, [['t_minus_days', true]], 'Tasks (days before)');
  }
  if (d.cost_lines !== undefined) {
    d.cost_lines = (Array.isArray(d.cost_lines) ? d.cost_lines : []).filter((x: any) => x && text(x.label));
    numIn(d.cost_lines, [['amount', false]], 'Cost lines');
  }
  if (d.other_spaces !== undefined) {
    d.other_spaces = (Array.isArray(d.other_spaces) ? d.other_spaces : [])
      .filter((x: any) => x && text(x.name))
      .map((x: any) => ({ ...x, access: oneOf(x.access, ['rented', 'partner', 'public'] as const, 'rented') }));
    numIn(d.other_spaces, [['cost', false], ['capacity', true]], 'Other spaces');
  }
  if (d.pnl && typeof d.pnl === 'object') {
    const basis = ['our data', 'source', 'proposal', 'to fill'] as const;
    const pnl = { ...d.pnl };
    pnl.programming = (Array.isArray(pnl.programming) ? pnl.programming : []).filter((x: any) => x && typeof x === 'object')
      .map((x: any) => ({ ...x, cost_basis: oneOf(x.cost_basis, ['food', 'drink', 'food_and_drink', 'none'] as const, 'none'), basis: oneOf(x.basis, basis, 'to fill') }));
    pnl.costs = (Array.isArray(pnl.costs) ? pnl.costs : []).filter((x: any) => x && text(x.item))
      .map((x: any) => ({ ...x, section: oneOf(x.section, ['operating', 'furniture', 'entertainment', 'marketing', 'additional', 'labour'] as const, 'additional'), basis: oneOf(x.basis, basis, 'to fill') }));
    numIn(pnl.programming, [['covers', true], ['per_person', false]], 'P&L revenue lines');
    numIn(pnl.costs, [['qty', false], ['hours', false], ['unit_price', false]], 'P&L cost lines');
    if (pnl.service_charge_pct !== undefined) {
      const sc = toNumber(pnl.service_charge_pct, false);
      if (sc.dropped) { delete pnl.service_charge_pct; notes.push('Service charge: not a number, left empty'); } else pnl.service_charge_pct = sc.value;
    }
    d.pnl = pnl;
  }
  return { draft: d, notes };
}
