import 'dotenv/config';

/**
 * What does StaffAny actually give us, with the key we actually hold?
 *
 * The published spec (https://api.staffany.com/docs/openapi.json) answers most
 * of the design questions and cannot answer three, all of which decide the
 * shape of the ingest:
 *
 * 1. IS THE V2 SURFACE ON. Both endpoints we need state "Requires the
 *    workspaceApiV2ExperimentalEnabled organisation flag". A flag we do not
 *    have turns the whole plan into the v1 endpoints, which are shaped
 *    differently.
 *
 * 2. DOES COST COME BACK. `schedule-costs` names its requirements out loud:
 *    STAFF_VIEW, EMPLOYEE_WAGE_VIEW and COST_DATA_VIEW. Whether this token
 *    holds them decides whether the BOH/FOH split is a MEASUREMENT or an
 *    hours-weighted ESTIMATE -- and CLAUDE.md is explicit that an estimate must
 *    be labelled one forever, because a chef and a runner do not cost the same
 *    hour. A 403 here settles a decision nobody then has to make.
 *
 * 3. HOW A SHIFT REACHES A ROLE. The shift record carries sectionId and
 *    shiftCategoryId and no role at all. `shift-slots` carries roleId, so the
 *    role lives on the ASSIGNMENT rather than the shift -- which means a person
 *    can hold two roles in a day, and cost arrives per person per day with no
 *    role on it. Whether that actually happens here decides whether cost splits
 *    cleanly by role or has to be apportioned. It is counted below rather than
 *    assumed.
 *
 * IT WRITES NOTHING, and prints structure and counts only. Never a person's
 * name, never an amount against a person. `/staff` carries date of birth, home
 * address, phone, next of kin and emergency contact; this probe does not call
 * it, because the ingest will not need it either -- roleId is on the slot.
 *
 * The payroll and compensation endpoints are not called and must not be. There
 * is no scope to withhold here as there is with Xero, so "we do not call it" is
 * the whole of the protection, which is worth stating where somebody will read
 * it before adding a call.
 */

const BASE = 'https://api.staffany.com';
const KEY = process.env.STAFFANY_API_KEY;

if (!KEY) {
  console.error('STAFFANY_API_KEY is not set. Add it as a sealed variable on this service.');
  process.exit(1);
}

/** Monday-to-Sunday of the last complete week, the unit an operator thinks in. */
function lastCompleteWeek(today = new Date()): { start: string; end: string } {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const thisMonday = new Date(d.getTime() - daysSinceMonday * 86_400_000);
  const start = new Date(thisMonday.getTime() - 7 * 86_400_000);
  const end = new Date(thisMonday.getTime() - 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const week = lastCompleteWeek();
const START = process.argv.find(a => a.startsWith('--start='))?.split('=')[1] ?? week.start;
const END = process.argv.find(a => a.startsWith('--end='))?.split('=')[1] ?? week.end;

interface Probe { ok: boolean; status: number; body: any; note?: string }

async function call(path: string, query: Record<string, string | undefined> = {}): Promise<Probe> {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');

  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });

  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, body };
}

/**
 * A refusal is an ANSWER, not a failure, so it is reported rather than thrown.
 * 403 on schedule-costs means the token lacks EMPLOYEE_WAGE_VIEW, which is a
 * finding worth more than most successes.
 */
function verdict(p: Probe): string {
  if (p.ok) return 'OK';
  const msg = p.body?.message ?? p.body?.error ?? p.body?.raw ?? '';
  return `${p.status} — ${String(msg).slice(0, 160)}`;
}

const items = (p: Probe): any[] => (Array.isArray(p.body?.data?.items) ? p.body.data.items : []);

console.log(`StaffAny probe — ${START} to ${END}`);
console.log('Reads only. Nothing is written, no payroll or compensation endpoint is called.\n');

// --- who are we -------------------------------------------------------------
const me = await call('/workspace/v2/me');
console.log(`me: ${verdict(me)}`);
if (me.ok) {
  const org = me.body?.data?.organisation ?? me.body?.data?.org ?? {};
  console.log(`  organisation: ${org.name ?? org.id ?? '(not named in response)'}`);
}
console.log('');

// --- outlets ----------------------------------------------------------------
const sections = await call('/workspace/v2/sections');
console.log(`sections: ${verdict(sections)}`);
for (const s of items(sections)) {
  // The venue lookup table's raw material. Names are the venue's, not a
  // person's, so they are safe to print and are the whole point.
  console.log(`  ${String(s.id).slice(0, 8)}…  ${s.name}${s.tag ? `  [${s.tag}]` : ''}`);
}
console.log('');

// --- roles ------------------------------------------------------------------
const roles = await call('/workspace/v2/roles');
console.log(`roles: ${verdict(roles)}`);
const roleName = new Map<string, string>();
for (const r of items(roles)) {
  roleName.set(r.id, r.name);
  console.log(`  ${r.name}`);
}
console.log(`  (${items(roles).length} role(s) — this is what the BOH/FOH mapping table must cover)\n`);

// --- shifts and the role link ----------------------------------------------
const slots = await call('/workspace/v2/shift-slots', {
  start: `${START}T00:00:00Z`,
  end: `${END}T23:59:59Z`,
  limit: '500',
});
console.log(`shift-slots: ${verdict(slots)}`);

if (slots.ok) {
  const rows = items(slots);
  const withRole = rows.filter(r => r.roleId).length;
  const assigned = rows.filter(r => r.userId).length;

  console.log(`  ${rows.length} slot(s) in the week; hasMore=${slots.body?.data?.meta?.hasMore}`);
  console.log(`  ${withRole} carry a roleId, ${rows.length - withRole} do not`);
  console.log(`  ${assigned} are assigned to somebody, ${rows.length - assigned} unassigned`);

  /**
   * The question that decides how cost attaches to a role.
   *
   * Cost arrives per PERSON per DAY with no role on it. Role lives on the
   * slot. If a person only ever works one role in a day, the join is exact; if
   * they work two, their day's cost has to be apportioned and the split stops
   * being a measurement at the edges. Counted, not assumed.
   */
  const rolesPerPersonDay = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.userId || !r.roleId || !r.timeStart) continue;
    const key = `${r.userId}|${String(r.timeStart).slice(0, 10)}`;
    (rolesPerPersonDay.get(key) ?? rolesPerPersonDay.set(key, new Set()).get(key)!).add(r.roleId);
  }
  const multi = [...rolesPerPersonDay.values()].filter(s => s.size > 1).length;
  console.log(`  ${rolesPerPersonDay.size} person-days, of which ${multi} span more than one role`);
  console.log(multi === 0
    ? '  → cost can be attributed to a role exactly'
    : '  → cost for those days must be apportioned; the split is not exact at the edges');

  const used = new Set(rows.map(r => r.roleId).filter(Boolean));
  const unnamed = [...used].filter(id => !roleName.has(id as string));
  if (unnamed.length > 0) {
    // Same rule as the Revel venue keys: an id with no name is flagged, never
    // guessed at.
    console.log(`  ${unnamed.length} roleId(s) on slots have no matching role definition — flag, do not guess`);
  }
}
console.log('');

// --- cost, and the permission question -------------------------------------
//
// start/end are `integer` here and ISO strings on shift-slots, which the spec
// states plainly and does not explain. Epoch seconds and milliseconds are both
// plausible and only one will be right, so both are tried and the working one
// reported -- guessing would look like an empty week.
const firstSection = items(sections)[0];

if (!firstSection) {
  console.log('schedule-costs: skipped — no section to ask about');
} else {
  const startMs = Date.parse(`${START}T00:00:00Z`);
  const endMs = Date.parse(`${END}T23:59:59Z`);

  for (const [label, s, e] of [
    ['milliseconds', String(startMs), String(endMs)],
    ['seconds', String(Math.floor(startMs / 1000)), String(Math.floor(endMs / 1000))],
  ] as Array<[string, string, string]>) {
    const cost = await call('/workspace/v2/schedule-costs', {
      start: s,
      end: e,
      sectionId: firstSection.id,
    });
    console.log(`schedule-costs (${label}): ${verdict(cost)}`);

    if (cost.ok) {
      const rows = items(cost);
      // The TOTAL for one section is what the warehouse would store and is safe
      // to print. A per-person figure is that person's earnings and is not.
      const total = rows.reduce((n, r) => n + (Number(r.totalCost) || 0), 0);
      const days = new Set(rows.map(r => r.date)).size;
      console.log(`  ${rows.length} row(s) across ${days} day(s) for "${firstSection.name}"`);
      console.log(`  section total for the week: ${total.toFixed(2)}`);
      console.log(`  breakdown keys present: ${Object.keys(rows[0]?.costBreakdown ?? {}).join(', ') || 'none'}`);
      console.log('  → COST IS AVAILABLE. The BOH/FOH split can be a measurement.');
      break;
    }

    if (cost.status === 403) {
      console.log('  → the token lacks EMPLOYEE_WAGE_VIEW / COST_DATA_VIEW.');
      console.log('    Labour cost is unreachable, the split must be hours-weighted, and it must');
      console.log('    be labelled an ESTIMATE everywhere it appears. That is a decision made.');
      break;
    }
  }
}

console.log('\nNot called, deliberately: /payroll, /compensation, /compensation-history,');
console.log('/compensation-snapshots, and /staff. The first four are personal pay. The last');
console.log('carries date of birth, address, phone and next of kin, and the ingest does not');
console.log('need it — roleId is on the shift slot.');
