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

async function call(
  path: string,
  query: Record<string, string | undefined> = {},
  payload?: unknown,
): Promise<Probe> {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');

  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  // The v1 read endpoints take their filters in a POST body rather than a query
  // string. They are still reads -- `POST /workspace/v1/timesheets` is
  // documented as "Retrieve timesheet attendance data" -- so the method says
  // nothing about whether anything is written.
  const res = await fetch(url, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: 'application/json',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  // The request itself on a failure. A 400 with no URL beside it sends you
  // reading the spec instead of comparing what you sent against it.
  if (!res.ok) console.log(`  → ${url.replace(/Bearer [^&]*/, '')}`);
  return { ok: res.ok, status: res.status, body };
}

/**
 * A refusal is an ANSWER, not a failure, so it is reported rather than thrown.
 * 403 on schedule-costs means the token lacks EMPLOYEE_WAGE_VIEW, which is a
 * finding worth more than most successes.
 */
function verdict(p: Probe): string {
  if (p.ok) return 'OK';
  /**
   * The WHOLE body, stringified.
   *
   * The first version picked `message ?? error ?? raw` and String()'d it, so a
   * validation error -- which arrives as an OBJECT listing the offending
   * fields -- printed as "[object Object]". Three 400s, and not one of them
   * said what was wrong with the request. That is the same fault this codebase
   * has been fixing all week: a report of the symptom where the cause was
   * already in hand.
   */
  return `${p.status} — ${JSON.stringify(p.body).slice(0, 400)}`;
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

const sectionName = new Map<string, string>(items(sections).map((s: any) => [s.id, s.name]));

// --- does a roster exist at all --------------------------------------------
/**
 * `shifts` is a DIFFERENT endpoint from `shift-slots`, and the first probe
 * never called it.
 *
 * The spec is explicit that they are siblings: "This endpoint returns shift
 * records only; use GET /workspace/v2/shift-slots to retrieve staff assignments
 * and unassigned slots." A shift is the box on the roster; a slot is a person
 * put in it.
 *
 * That distinction is what makes this worth asking. `shift-slots` came back 200
 * with zero rows for a full week, published and unpublished, which has two
 * completely different explanations -- nobody is rostered, or assignments are
 * withheld from this token -- and the two lead opposite ways. Shifts with no
 * slots means the roster exists and we cannot see who is in it, which is a
 * permission conversation. No shifts either means the week genuinely was not
 * built here, which is a conversation with the business instead.
 */
const shifts = await call('/workspace/v2/shifts', {
  start: `${START}T00:00:00Z`,
  end: `${END}T23:59:59Z`,
  limit: '100',
  includeUnpublished: 'true',
});
console.log(`shifts (incl. unpublished): ${verdict(shifts)} — ${items(shifts).length} shift(s)`);

if (shifts.ok) {
  const rows = items(shifts);
  const published = rows.filter((r: any) => r.isPublished).length;
  console.log(`  ${published} published, ${rows.length - published} unpublished`);
  console.log(`  hasMore=${shifts.body?.data?.meta?.hasMore}`);

  // Per SECTION, because section IS the BOH/FOH split in this organisation --
  // Fat Prince BOH and Fat Prince FOH are separate sections, not a role
  // attribute. A section with no shifts is the thing worth seeing.
  const bySection = new Map<string, number>();
  for (const r of rows as any[]) {
    const key = sectionName.get(r.sectionId) ?? `unmapped:${String(r.sectionId).slice(0, 8)}`;
    bySection.set(key, (bySection.get(key) ?? 0) + 1);
  }
  for (const [name, n] of [...bySection].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n.toString().padStart(4)}  ${name}`);
  }
  if (rows.length > 0) {
    console.log('  → the roster EXISTS. If shift-slots is empty below, assignments are');
    console.log('    being withheld from this token, not absent from the business.');
  }
}
console.log('');

// --- shifts and the role link ----------------------------------------------
/**
 * Asked BOTH ways, because `includeUnpublished` defaults to false.
 *
 * An empty week and a week whose schedule was never published look identical
 * from outside, and only one of them is a problem. If published returns
 * nothing and unpublished returns plenty, this business rosters in StaffAny
 * without publishing -- which the ingest would have to honour, and which
 * nobody would have found later without wondering where the labour went.
 */
let slots = await call('/workspace/v2/shift-slots', {
  start: `${START}T00:00:00Z`,
  end: `${END}T23:59:59Z`,
  // The spec caps this at 100. 500 was rejected outright.
  limit: '100',
});
console.log(`shift-slots (published only): ${verdict(slots)} — ${items(slots).length} slot(s)`);

if (slots.ok && items(slots).length === 0) {
  slots = await call('/workspace/v2/shift-slots', {
    start: `${START}T00:00:00Z`,
    end: `${END}T23:59:59Z`,
    limit: '100',
    includeUnpublished: 'true',
  });
  console.log(`shift-slots (incl. unpublished): ${verdict(slots)} — ${items(slots).length} slot(s)`);
  if (items(slots).length > 0) {
    console.log('  → schedules are NOT published. The ingest must pass includeUnpublished=true');
    console.log('    or it will silently see no labour at all.');
  }
}
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
  /**
   * YYYY-MM-DD, and the published spec says otherwise.
   *
   * It declares start and end as `type: integer`, so this first tried epoch
   * milliseconds and then epoch seconds. Both were refused with the answer in
   * plain words: `"start" must be in YYYY-MM-DD format`. The spec is wrong
   * about its own parameter, which is the argument for probing an API rather
   * than reading it -- and worth remembering for every other field in that
   * document.
   */
  for (const [label, s, e] of [
    ['YYYY-MM-DD', START, END],
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

// --- the ungated fallback ---------------------------------------------------
/**
 * WHAT IS ACTUALLY GATED, measured rather than assumed.
 *
 * The whole plan was declared blocked on `workspaceApiV2ExperimentalEnabled`.
 * Reading the published spec end to end, exactly TWO of its forty-three
 * endpoints mention the flag: `GET /workspace/v2/schedule-costs` and
 * `POST /workspace/v2/timesheets/work-data`. Everything else is free, including
 * the entire v1 surface, which the first probe never tried at all.
 *
 * `POST /workspace/v1/timesheets` is the one that matters. It returns CLOCKED
 * ATTENDANCE rather than the roster -- hours somebody actually worked, not
 * hours somebody was scheduled for -- which is the better input regardless, and
 * it carries `sectionId`. Since BOH and FOH are separate SECTIONS here, the
 * split falls out of the data structurally and needs no role mapping and no
 * apportionment.
 *
 * What stays gated is COST. So if this works and schedule-costs does not, the
 * BOH/FOH split is hours-weighted, and CLAUDE.md is unambiguous about what that
 * obliges: a chef and a runner do not cost the same hour, so it is an ESTIMATE
 * and must be labelled one everywhere it appears, for as long as it is one.
 */
const day = 86_400_000;
const fromMs = Date.parse(`${START}T00:00:00Z`);
const toMs = Date.parse(`${END}T00:00:00Z`) + day - 1000;

/**
 * Three encodings, because the spec has already been wrong about this once.
 *
 * `range.from`/`range.to` are declared `type: integer` here -- the same
 * declaration schedule-costs makes, where the API then demanded YYYY-MM-DD in
 * plain words. So the document cannot be trusted on this field, and guessing
 * one form would come back as an empty week rather than as an error. All three
 * are tried and the working one is reported, which is the finding.
 */
const encodings: Array<[string, number | string, number | string]> = [
  ['epoch ms', fromMs, toMs],
  ['epoch seconds', Math.floor(fromMs / 1000), Math.floor(toMs / 1000)],
  ['YYYY-MM-DD', START, END],
];

for (const [label, from, to] of encodings) {
  const ts = await call('/workspace/v1/timesheets', {}, {
    range: { from, to },
    includes: ['shiftRecords', 'workHours'],
    limit: 100,
  });
  console.log(`timesheets v1 (${label}): ${verdict(ts)}`);

  if (!ts.ok) continue;

  const workHours: any[] = Array.isArray(ts.body?.data?.workHours) ? ts.body.data.workHours : [];
  const records: any[] = Array.isArray(ts.body?.data?.shiftRecords) ? ts.body.data.shiftRecords : [];

  console.log(`  ${records.length} shift record(s), ${workHours.length} work-hour row(s)`);
  console.log(`  hasMore=${ts.body?.data?.meta?.hasMore}`);

  /**
   * KEYS, never values.
   *
   * The spec's response schema for a work-hour row lists startTime and no end
   * and no duration, which cannot be the whole of it -- and the spec has
   * already been caught understating this endpoint family. The real field list
   * decides whether hours are a subtraction or have to be reconstructed from
   * clock attempts. Printing the names is enough to learn that; printing a row
   * would put a person's shift on a terminal, which this probe does not do.
   */
  if (workHours[0]) console.log(`  work-hour fields: ${Object.keys(workHours[0]).join(', ')}`);
  if (records[0]) console.log(`  shift-record fields: ${Object.keys(records[0]).join(', ')}`);

  // Distinct people COUNTED, never listed. The count answers "is this the whole
  // team or a handful", which is the only thing about it we need to know.
  console.log(`  ${new Set(workHours.map(w => w.userId).filter(Boolean)).size} distinct staff appear`);

  const bySection = new Map<string, number>();
  for (const w of workHours) {
    const key = sectionName.get(w.sectionId) ?? `unmapped:${String(w.sectionId).slice(0, 8)}`;
    bySection.set(key, (bySection.get(key) ?? 0) + 1);
  }
  for (const [name, n] of [...bySection].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n.toString().padStart(4)}  ${name}`);
  }

  const unmapped = [...bySection.keys()].filter(k => k.startsWith('unmapped:'));
  if (unmapped.length > 0) {
    // The Revel venue-key rule: an id with no name is flagged, never guessed.
    console.log(`  ${unmapped.length} sectionId(s) have no matching section — flag, do not guess`);
  }

  if (workHours.length > 0) {
    console.log('  → HOURS ARE REACHABLE WITHOUT THE EXPERIMENTAL FLAG, and they arrive');
    console.log('    already split by section, which is the BOH/FOH split. Cost is still');
    console.log('    gated, so a split built on this alone is an ESTIMATE and stays labelled one.');
  }
  break;
}

console.log('\nNot called, deliberately: /workspace/v1/payroll, /workspace/v1/compensation,');
console.log('/workspace/v2/compensation-history, /workspace/v2/compensation-snapshots,');
console.log('/workspace/v2/payroll/payruns/search, and /staff on both versions. The payroll');
console.log('and compensation endpoints are personal pay. /staff carries date of birth,');
console.log('address, phone and next of kin, and the ingest does not need it — the section');
console.log('carries the BOH/FOH split and the slot carries the role.');
console.log('');
console.log('NONE OF THOSE IS GATED. Every one is on the free surface of this API, reachable');
console.log('with the token we already hold. With Xero the protection is a scope we refused');
console.log('and therefore cannot use by accident; here there is no scope to refuse, so not');
console.log('writing the call is the entire protection. Anyone adding one should know that.');
