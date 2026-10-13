/**
 * An issued event brief, as a group of tasks on a monday.com board.
 *
 * Khai, 12 Oct 2026: each venue has its own activations board in the TDC
 * Marketing & PR workspace; an event is a GROUP named "YY-MMDD Name", each item
 * a task assigned to somebody with a deadline. Decided the same day: the
 * board's own Event Template steps PLUS the planner's tasks, deadlines worked
 * out from the plan, a preview before anything is written, one group on each
 * venue's board, and the board chosen from a searchable list rather than
 * remembered in a table.
 *
 * Everything here is pure, so the shape of what lands on somebody's board is
 * tested without a token. The reading and writing is `monday-client.ts`.
 */

export interface MondayUser { id: string; name: string; email: string | null }

export interface BoardColumns {
  deadline: string | null;
  owner: string | null;
  assigned: string | null;
  status: string | null;
  /** The status label new items start on, if the board has it. */
  statusLabel: string | null;
}

export interface TemplateStep {
  name: string;
  owner_ids: number[];
  assigned_ids: number[];
}

export interface PlannerTask {
  description: string;
  channel: string | null;
  kind: string;
  due_date: string | null;
  owner_name: string | null;
}

export interface StepDeadline { index: number; due: string | null; phase: 'before' | 'after'; reason: string }

export type PersonMatch =
  | { status: 'matched'; user: MondayUser }
  | { status: 'ambiguous'; candidates: MondayUser[] }
  | { status: 'none' };

export interface PreviewItem {
  name: string;
  source: 'template' | 'planner';
  deadline: string | null;
  reason: string | null;
  owner_ids: number[];
  assigned_ids: number[];
  /** Who it went to, in words, for the preview. */
  owner_label: string;
  assigned_label: string;
  flags: string[];
  /** Names nobody could be matched to, each with the people to choose from. */
  unresolved?: Array<{ name: string; options: Array<{ id: number; name: string }> }>;
}

/**
 * "26-1231 NYE", the way the team names a group. A run of days carries both
 * ends ("26-1126-1129 Hyrox"), as the boards already do.
 */
export function groupTitle(name: string, start: string, end: string): string {
  const s = start.slice(2, 4) + '-' + start.slice(5, 7) + start.slice(8, 10);
  const e = end && end !== start ? '-' + end.slice(5, 7) + end.slice(8, 10) : '';
  return `${s}${e} ${name.trim()}`.slice(0, 255);
}

/**
 * The event date out of a group title, or null. The boards are written by
 * hand, so the separators wander: "26-1231 NYE", "26- 1009 F1",
 * "26 1002- 1031 Dining City". A title with no full date ("26-11XX Festive")
 * gives null rather than a guess.
 */
export function parseGroupDate(title: string): string | null {
  const m = /^\s*(\d{2})\s*[- ]\s*(\d{2})(\d{2})(?!\d)/.exec(title);
  if (!m) return null;
  const iso = `20${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** "13. Send Menus to Printers" and "11. Send menus to printers" are one step. */
export function stepKey(name: string): string {
  return name.replace(/^\s*\d+(\.\d+)?\.?\s*/, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/**
 * How far ahead of the event each step has actually been due, on this board.
 *
 * A REFERENCE FOR THE PLANNER, NOT A RULE. The boards are filled by hand and
 * some groups were filled in bulk -- every item in the 12 Nov TikTok group is
 * due 7 Oct -- so a group whose deadlines are all one day says nothing about
 * timing and is left out. Median, with its count, so one odd event cannot set
 * the figure and a step seen once says so.
 */
export function historicalOffsets(
  items: Array<{ group_title: string; name: string; deadline: string | null }>,
  excludeGroup: (title: string) => boolean = t => /template/i.test(t),
): Map<string, { days_before: number; n: number }> {
  const byGroup = new Map<string, typeof items>();
  for (const it of items) {
    if (excludeGroup(it.group_title) || !it.deadline) continue;
    const list = byGroup.get(it.group_title) ?? [];
    list.push(it);
    byGroup.set(it.group_title, list);
  }
  const samples = new Map<string, number[]>();
  for (const [title, list] of byGroup) {
    const event = parseGroupDate(title);
    if (!event) continue;
    if (list.length >= 3 && new Set(list.map(i => i.deadline)).size === 1) continue;
    for (const it of list) {
      const k = stepKey(it.name);
      const arr = samples.get(k) ?? [];
      arr.push(daysBetween(event, it.deadline!));
      samples.set(k, arr);
    }
  }
  const out = new Map<string, { days_before: number; n: number }>();
  for (const [k, arr] of samples) {
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    out.set(k, { days_before: median, n: s.length });
  }
  return out;
}

/**
 * A planner's "Salvin" to a Monday account. Full name first, then a first
 * name that only one person has. Anything else is NOT guessed: two people
 * called Josh is a question for the person pressing the button, and the
 * preview shows every match so a wrong one is seen before it is written.
 */
export function matchPerson(name: string | null | undefined, users: MondayUser[]): PersonMatch {
  const n = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!n) return { status: 'none' };
  const full = users.filter(u => u.name.trim().toLowerCase().replace(/\s+/g, ' ') === n);
  if (full.length === 1) return { status: 'matched', user: full[0] };
  if (full.length > 1) return { status: 'ambiguous', candidates: full };
  const first = n.split(' ')[0];
  const byFirst = users.filter(u => u.name.trim().toLowerCase().split(/\s+/)[0] === first);
  if (byFirst.length === 1) return { status: 'matched', user: byFirst[0] };
  if (byFirst.length > 1) return { status: 'ambiguous', candidates: byFirst };
  return { status: 'none' };
}

/**
 * "Corbin / Josh Wilson" is two people. Owners are split on / + & , and "and"
 * before matching, so a shared task assigns both instead of matching neither.
 */
export function splitNames(name: string | null | undefined): string[] {
  return String(name ?? '').split(/\s*(?:\/|\+|&|,|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);
}

export interface PeopleMatch {
  ids: number[];
  labels: string[];
  unresolved: Array<{ name: string; candidates: MondayUser[] }>;
}

/**
 * Every name in an owner, matched safely (Khai, 13 Oct 2026, after "No Monday
 * user called Corbin"). Most of the venue team are GUESTS on Monday, and the
 * lookup searched members only. In order, per name:
 *   1. a pick the person made before for this exact name ("your earlier pick");
 *   2. the people on THIS board, members and guests alike -- a guest can
 *      usually only be assigned on a board shared with them;
 *   3. everyone else on the account.
 * Anything still unmatched or ambiguous is returned unresolved, for the person
 * to choose on the preview. Never a guess.
 */
export function matchPeople(
  owner: string | null | undefined,
  boardUsers: MondayUser[],
  allUsers: MondayUser[],
  remembered: Record<string, string> = {},
): PeopleMatch {
  const out: PeopleMatch = { ids: [], labels: [], unresolved: [] };
  const byId = new Map(allUsers.map(u => [u.id, u]));
  for (const part of splitNames(owner)) {
    const pick = remembered[part.toLowerCase()];
    const pickUser = pick ? byId.get(String(pick)) : undefined;
    if (pickUser) { out.ids.push(Number(pickUser.id)); out.labels.push(`${pickUser.name} (your earlier pick)`); continue; }
    let m = matchPerson(part, boardUsers);
    if (m.status === 'none') m = matchPerson(part, allUsers);
    if (m.status === 'matched') { out.ids.push(Number(m.user.id)); out.labels.push(m.user.name); }
    else out.unresolved.push({ name: part, candidates: m.status === 'ambiguous' ? m.candidates : [] });
  }
  out.ids = [...new Set(out.ids)];
  return out;
}

/**
 * The columns by TITLE, not id. The three boards share ids today because they
 * were copied from one another, which is an accident nothing promises; the
 * titles are what a person sees and renames deliberately.
 */
export function findColumns(
  columns: Array<{ id: string; title: string; type: string; settings?: any }>,
): BoardColumns {
  const pick = (type: string, title: RegExp) =>
    columns.find(c => c.type === type && title.test(c.title.trim()))?.id ?? null;
  const status = pick('status', /^status$/i);
  const statusCol = columns.find(c => c.id === status);
  const labels: any[] = statusCol?.settings?.labels
    ? (Array.isArray(statusCol.settings.labels) ? statusCol.settings.labels : Object.values(statusCol.settings.labels))
    : [];
  const label = labels.map(l => (typeof l === 'string' ? l : l?.label)).find(l => /^new assignment$/i.test(l ?? '')) ?? null;
  return {
    deadline: pick('date', /^deadline$/i),
    owner: pick('people', /^owner$/i),
    assigned: pick('people', /^assigned to$/i),
    status,
    statusLabel: label,
  };
}

/** Flags on a deadline. Shown in red on the preview; never quietly moved. */
export function deadlineFlags(
  due: string | null, phase: 'before' | 'after', today: string, start: string, end: string,
): string[] {
  if (!due) return ['No deadline'];
  const f: string[] = [];
  if (due < today) f.push('Already past');
  if (phase === 'before' && due > start) f.push('Due after the event starts');
  if (phase === 'after' && due < end) f.push('Due before the event ends');
  return f;
}

/** The forced tool the deadline pass fills in. */
export function deadlineTool(stepCount: number) {
  return {
    name: 'record_checklist_deadlines',
    description: 'Give every checklist step a deadline that fits this plan.',
    input_schema: {
      type: 'object' as const,
      properties: {
        steps: {
          type: 'array',
          description: `One entry per checklist step, ${stepCount} in all, by index.`,
          items: {
            type: 'object',
            properties: {
              index: { type: 'number', description: 'The step\'s index as listed.' },
              due: { type: 'string', description: 'YYYY-MM-DD.' },
              phase: { type: 'string', enum: ['before', 'after'], description: '"after" only for a step that happens once the event is over (debrief, taking the promotion down).' },
              reason: { type: 'string', description: 'Why this date, from the plan, in at most fifteen words: "two days before launch comms on 12 Dec".' },
            },
            required: ['index', 'due', 'phase', 'reason'],
          },
        },
      },
      required: ['steps'],
    },
  };
}

/**
 * What the deadline pass is told. The plan's own dates come first because they
 * are the decision; the board's history is labelled as a reference so a
 * planner who has set a three-week campaign is not overruled by an old habit.
 */
export function deadlinePrompt(input: {
  event: { name: string; start_date: string; end_date: string; concept?: string | null; ad_plan?: string | null };
  tasks: PlannerTask[];
  steps: TemplateStep[];
  history: Map<string, { days_before: number; n: number }>;
  today: string;
  brief?: string | null;
}): string {
  const taskLines = input.tasks
    .slice().sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .map(t => `- ${t.due_date ?? 'no date'}: ${t.description}${t.channel ? ` (${t.channel})` : ''}${t.owner_name ? ` -- ${t.owner_name}` : ''}`);
  const stepLines = input.steps.map((s, i) => {
    const h = input.history.get(stepKey(s.name));
    const ref = h ? ` [on past events on this board: due ${h.days_before} days before, median of ${h.n}]` : ' [no history on this board]';
    return `${i}. ${s.name}${ref}`;
  });
  return [
    `TODAY: ${input.today}`,
    `EVENT: ${input.event.name}, ${input.event.start_date}${input.event.end_date !== input.event.start_date ? ` to ${input.event.end_date}` : ''}`,
    input.event.concept ? `CONCEPT: ${input.event.concept}` : '',
    input.event.ad_plan ? `AD PLAN: ${input.event.ad_plan}` : '',
    '',
    'THE PLAN\'S SCHEDULE (decided in the planning conversation -- this is what the deadlines must fit):',
    taskLines.length ? taskLines.join('\n') : '(no dated tasks)',
    input.brief ? `\nTHE BRIEF:\n${input.brief.slice(0, 6000)}` : '',
    '',
    'THE BOARD\'S CHECKLIST, to give deadlines:',
    stepLines.join('\n'),
  ].filter(l => l !== '').join('\n');
}

export const DEADLINE_SYSTEM =
  'You set deadlines for an event checklist so it fits a plan that has already been decided. ' +
  'The plan\'s schedule is the authority: the first post or launch comms date anchors the campaign, and everything ' +
  'that has to exist before launch (strategy, concept, financial forecast, menus, partner details, key visuals, printing, ' +
  'the booking page) is due before it, in the order one depends on the other -- a menu is reviewed before it is printed, ' +
  'printed before launch. Post-event steps (debrief, taking promotion down) come after the event ends. ' +
  'Past events on the board are a reference for how long a step usually needs, not a rule. ' +
  'Never give a date before today unless the step genuinely had to be done already -- then give today and say it is overdue. ' +
  'Every step gets a date.';

/**
 * Template steps and planner tasks as the items the preview shows and the send
 * writes. Template items keep the board's own Owner and Assigned To: those are
 * the team's standing defaults and nobody asked Sauron to reassign them.
 */
export function buildItems(input: {
  steps: TemplateStep[];
  deadlines: StepDeadline[];
  tasks: PlannerTask[];
  users: MondayUser[];
  /** The chosen board's own people; matched first. Defaults to everyone. */
  boardUsers?: MondayUser[];
  /** Earlier picks from the preview: lower-cased name -> Monday user id. */
  remembered?: Record<string, string>;
  sender: MondayUser | null;
  today: string;
  start: string;
  end: string;
}): PreviewItem[] {
  const nameOf = new Map(input.users.map(u => [Number(u.id), u.name]));
  const label = (ids: number[]) => ids.map(id => nameOf.get(id) ?? `#${id}`).join(', ');
  const byIndex = new Map(input.deadlines.map(d => [d.index, d]));

  // A person on the board's template who is no longer an active Monday user
  // (13 Oct 2026: "unable to assign person with id: 48376983", which stopped a
  // send at item 7 of 39) is left off and said, never sent.
  const active = (ids: number[]) => ids.filter(id => nameOf.has(id));
  const template: PreviewItem[] = input.steps.map((s, i) => {
    const d = byIndex.get(i);
    const due = d?.due && /^\d{4}-\d{2}-\d{2}$/.test(d.due) ? d.due : null;
    const owners = active(s.owner_ids), assigned = active(s.assigned_ids);
    const gone = s.owner_ids.length + s.assigned_ids.length - owners.length - assigned.length;
    const flags = deadlineFlags(due, d?.phase ?? 'before', input.today, input.start, input.end);
    if (gone) flags.push(`${gone === 1 ? 'A person' : `${gone} people`} on the board's template ${gone === 1 ? 'is' : 'are'} no longer active on Monday -- left off`);
    return {
      name: s.name.slice(0, 255),
      source: 'template',
      deadline: due,
      reason: d?.reason ?? null,
      owner_ids: owners,
      assigned_ids: assigned,
      owner_label: label(owners),
      assigned_label: label(assigned),
      flags,
    };
  });

  const planner: PreviewItem[] = input.tasks
    .slice().sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
    .map(t => {
      const boardUsers = input.boardUsers ?? input.users;
      const m = matchPeople(t.owner_name, boardUsers, input.users, input.remembered ?? {});
      const flags = deadlineFlags(t.due_date, 'before', input.today, input.start, input.end)
        // The day itself is a valid date for a planner task (a story on the night).
        .filter(f => f !== 'Due after the event starts' || (t.due_date ?? '') > input.end);
      for (const u of m.unresolved) {
        flags.push(u.candidates.length
          ? `"${u.name}" matches ${u.candidates.map(c => c.name).join(' and ')} -- choose one`
          : `No Monday user called "${u.name}" -- choose one or leave blank`);
      }
      // The people to choose from: whoever the name matched, then the board.
      const options = (cands: MondayUser[]) => {
        const seen = new Set<string>();
        return [...cands, ...boardUsers].filter(u => !seen.has(u.id) && seen.add(u.id))
          .map(u => ({ id: Number(u.id), name: u.name }));
      };
      const assigned = m.ids;
      const assignedLabel = m.labels.join(', ');
      const name = `${t.description}${t.channel ? ` (${t.channel})` : ''}`.slice(0, 255);
      return {
        name,
        source: 'planner',
        deadline: t.due_date,
        reason: 'From the plan',
        owner_ids: input.sender ? [Number(input.sender.id)] : [],
        assigned_ids: assigned,
        owner_label: input.sender?.name ?? '',
        assigned_label: assignedLabel,
        flags,
        ...(m.unresolved.length ? { unresolved: m.unresolved.map(u => ({ name: u.name, options: options(u.candidates) })) } : {}),
      };
    });

  return [...template, ...planner];
}

/** The create_item column_values for one item. */
export function columnValues(item: Pick<PreviewItem, 'deadline' | 'owner_ids' | 'assigned_ids'>, cols: BoardColumns): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  const people = (ids: number[]) => ({ personsAndTeams: ids.map(id => ({ id, kind: 'person' })) });
  if (cols.deadline && item.deadline) v[cols.deadline] = { date: item.deadline };
  if (cols.owner && item.owner_ids.length) v[cols.owner] = people(item.owner_ids);
  if (cols.assigned && item.assigned_ids.length) v[cols.assigned] = people(item.assigned_ids);
  if (cols.status && cols.statusLabel) v[cols.status] = { label: cols.statusLabel };
  return v;
}

/**
 * What comes back from a browser to be written, checked. The preview went out
 * and came back, and a browser can send anything: names are strings, people
 * are whole numbers, dates are dates, and there is a ceiling on how many.
 */
export function sanitiseItems(raw: unknown): Array<Pick<PreviewItem, 'name' | 'deadline' | 'owner_ids' | 'assigned_ids'>> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 80) return null;
  const ids = (x: unknown) => (Array.isArray(x) ? x : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20);
  const out = raw.map((r: any) => ({
    name: typeof r?.name === 'string' ? r.name.trim().slice(0, 255) : '',
    deadline: typeof r?.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.deadline) ? r.deadline : null,
    owner_ids: ids(r?.owner_ids),
    assigned_ids: ids(r?.assigned_ids),
  }));
  return out.every(i => i.name) ? out : null;
}

/**
 * Where the brief and the P&L go: the template's "Concept & Mechanics" and
 * "Financial Forecast" steps, found by WORDS rather than number, because the
 * numbering differs between groups on the same board (the forecast is "3." on
 * the template and "7." in copies of it). Null where the board has no such
 * step -- then that attachment is offered as unavailable, not sent elsewhere.
 */
export function attachTargets(names: string[]): { brief: number | null; pnl: number | null } {
  const keys = names.map(stepKey);
  const find = (re: RegExp) => { const i = keys.findIndex(k => re.test(k)); return i < 0 ? null : i; };
  return { brief: find(/concept\s*(&|and)\s*mechanic/), pnl: find(/financial forecast/) };
}

/** The Financial Forecast update: the headline figures, with where each rate came from. */
export function pnlUpdateHtml(
  title: string,
  f: { gross: number; nett: number; product_cost: number; group_fees: number; profit: number; scenarios: Array<{ pct: number; profit: number }> },
  rates: Record<string, { value: number | null; label: string; basis: string }>,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const m = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-SG', { maximumFractionDigits: 0 });
  const margin = f.nett > 0 ? ` (${(f.profit / f.nett * 100).toFixed(1)}% of nett)` : '';
  const toFill = Object.values(rates).filter(r => r.value === null).map(r => esc(r.label));
  return [
    `<p><strong>${esc(title)} -- event P&amp;L from Sauron</strong></p>`,
    '<ul>',
    `<li>Gross revenue: ${m(f.gross)}; nett: ${m(f.nett)}</li>`,
    `<li>Food &amp; drink cost: ${m(f.product_cost)}; group fees: ${m(f.group_fees)}</li>`,
    `<li><strong>Profit: ${m(f.profit)}</strong>${margin}</li>`,
    `<li>If it sells ${f.scenarios.filter(s => s.pct < 1).map(s => `${Math.round(s.pct * 100)}%: ${m(s.profit)}`).join('; ')}</li>`,
    '</ul>',
    `<p><em>Product cost and group fees are computed from the venue's measured rates, never typed in: ${Object.values(rates).filter(r => r.value !== null).map(r => esc(r.label)).join('; ')}.</em></p>`,
    toFill.length ? `<p><em>Still to fill: ${toFill.join('; ')}. Lines marked "to fill" in the workbook need a number before this is a forecast.</em></p>` : '',
    '<p>The workbook is attached. Shaded cells are inputs; every line carries its basis.</p>',
  ].join('');
}
