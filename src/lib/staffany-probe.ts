/**
 * What does StaffAny actually give us, with the key we actually hold?
 *
 * This was a terminal script, and moving it here is the point of the change.
 * Everything else in this system ships through GitHub and runs on Railway; a
 * diagnostic that needed a laptop, a CLI login and a local clone was the one
 * thing that did not, and Railway has no clean way to run a one-off — a service
 * with no cron restarts on exit and crash-loops, and repointing a scheduled
 * service's start command is what left Ingest-Meta running the classifier for
 * eleven days while showing green. So it becomes a button, next to the Meta
 * discovery and metric probes, which already work exactly this way.
 *
 * It will be run more than once. StaffAny's reply on 3 Sep 2026 was that the v2
 * experimental endpoints are not fully tested on their side and they will plan
 * testing, so the answer this returns is expected to change.
 *
 * IT WRITES NOTHING and returns structure and counts only. Never a person's
 * name, never an amount against a person.
 *
 * The payroll and compensation endpoints are not called and must not be. Unlike
 * Xero, where the protection is a scope we refused and therefore cannot use by
 * accident, every one of them is on the free surface of this API and reachable
 * with the token we already hold. Not writing the call is the entire
 * protection, which is worth stating where somebody will read it before adding
 * one.
 */

const BASE = 'https://api.staffany.com';

/** Monday-to-Sunday of the last complete week, the unit an operator thinks in. */
export function lastCompleteWeek(today = new Date()): { start: string; end: string } {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const thisMonday = new Date(d.getTime() - daysSinceMonday * 86_400_000);
  const start = new Date(thisMonday.getTime() - 7 * 86_400_000);
  const end = new Date(thisMonday.getTime() - 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

interface Probe { ok: boolean; status: number; body: any }

/**
 * A refusal is an ANSWER, not a failure, so every call returns rather than
 * throws. A 403 on schedule-costs is a finding worth more than most successes.
 */
export interface Outcome {
  ok: boolean;
  status: number;
  /** The whole error body, stringified. Never a summary of it -- see below. */
  error: string | null;
}

export interface SectionRow { id_prefix: string; name: string; tag: string | null }
export interface CountRow { name: string; count: number }

export interface StaffAnyProbeResult {
  window: { start: string; end: string };
  organisation: string | null;
  me: Outcome;
  /**
   * What this token is ALLOWED to do, from the API rather than from our notes.
   *
   * `GET /workspace/v1/me` returns accessLevel and a list of RBAC permission
   * scopes. That is the difference between "the week was not rostered" and
   * "this token cannot see rosters", which three endpoints returning 200 with
   * zero rows cannot distinguish on their own -- and which StaffAny named
   * themselves: access is tied to the user's permission groups.
   *
   * The endpoint also returns the user's NAME and EMAIL. Neither is read. The
   * whole point of the probe is that a person's details never reach a screen,
   * and the token holder is a person too.
   */
  permissions: Outcome & { access_level: string | null; scopes: string[] };
  /** Which sections, teams and roles this token's user actually belongs to. */
  groups: Outcome & { sections: string[]; teams: string[]; roles: string[] };
  sections: Outcome & { items: SectionRow[] };
  roles: Outcome & { names: string[] };
  shifts: Outcome & {
    total: number;
    published: number;
    unpublished: number;
    has_more: boolean | null;
    by_section: CountRow[];
  };
  shift_slots: Outcome & {
    published_only: number;
    incl_unpublished: number;
    with_role: number;
    assigned: number;
    person_days: number;
    multi_role_person_days: number;
    unnamed_role_ids: number;
  };
  schedule_costs: Outcome & {
    gated: boolean;
    rows: number;
    days: number;
    section: string | null;
    total: number | null;
    breakdown_keys: string[];
  };
  timesheets_v1: Outcome & {
    encoding: string | null;
    shift_records: number;
    work_hours: number;
    distinct_staff: number;
    work_hour_fields: string[];
    shift_record_fields: string[];
    by_section: CountRow[];
    unmapped_sections: number;
  };
  /** The plain-English conclusions. This is what somebody actually reads. */
  verdicts: string[];
  not_called: string[];
}

const NOT_CALLED = [
  '/workspace/v1/payroll',
  '/workspace/v1/compensation',
  '/workspace/v2/compensation-history',
  '/workspace/v2/compensation-snapshots',
  '/workspace/v2/payroll/payruns/search',
  '/workspace/v1/staff and /workspace/v2/staff',
];

/**
 * The WHOLE body, stringified.
 *
 * An earlier version picked `message ?? error ?? raw` and String()'d it, so a
 * validation error -- which arrives as an OBJECT listing the offending fields
 * -- printed as "[object Object]". Three 400s, and not one said what was wrong
 * with the request.
 */
function outcome(p: Probe): Outcome {
  return {
    ok: p.ok,
    status: p.status,
    error: p.ok ? null : JSON.stringify(p.body).slice(0, 400),
  };
}

const items = (p: Probe): any[] => (Array.isArray(p.body?.data?.items) ? p.body.data.items : []);

export async function probeStaffAny(opts: {
  key: string;
  start?: string;
  end?: string;
} ): Promise<StaffAnyProbeResult> {
  const week = lastCompleteWeek();
  const START = opts.start ?? week.start;
  const END = opts.end ?? week.end;

  async function call(
    path: string,
    query: Record<string, string | undefined> = {},
    payload?: unknown,
  ): Promise<Probe> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join('&');

    // The v1 read endpoints take their filters in a POST body rather than a
    // query string. They are still reads -- POST /workspace/v1/timesheets is
    // documented as "Retrieve timesheet attendance data" -- so the method says
    // nothing about whether anything is written.
    const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${opts.key}`,
        Accept: 'application/json',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, body };
  }

  const verdicts: string[] = [];

  // --- who are we -----------------------------------------------------------
  const me = await call('/workspace/v2/me');
  const org = me.body?.data?.organisation ?? me.body?.data?.org ?? {};

  // --- what is this token allowed to do -------------------------------------
  /**
   * Asked FIRST, because it reframes everything below it.
   *
   * On 5 Sep 2026 shifts, shift-slots and timesheets all returned 200 with zero
   * rows for a week that was certainly worked, while sections and roles came
   * back complete. Nobody configures seven sections and thirty-seven job titles
   * for a business that does not roster, so "the week was not built" was the
   * weaker reading and the probe was asserting it. This is the call that tells
   * the two apart instead of guessing between them.
   */
  const meV1 = await call('/workspace/v1/me');
  // NAME and EMAIL are deliberately not read. See the interface comment.
  const accessLevel: string | null = meV1.body?.data?.accessLevel ?? null;
  const scopes: string[] = Array.isArray(meV1.body?.data?.permissions) ? meV1.body.data.permissions : [];

  /**
   * The three scopes schedule-costs names as its requirements.
   *
   * Worth checking even while the endpoint is flag-gated, because when StaffAny
   * turn the flag on it will fail a second time if these are absent -- and a
   * second round trip of days is the cost of not having asked now.
   */
  const COST_SCOPES = ['STAFF_VIEW', 'EMPLOYEE_WAGE_VIEW', 'COST_DATA_VIEW'];
  const missingCostScopes = meV1.ok ? COST_SCOPES.filter(s => !scopes.includes(s)) : [];

  const groups = await call('/workspace/v1/groups');
  const groupRows: any[] = Array.isArray(groups.body?.data) ? groups.body.data : [];
  const groupNames = (type: string): string[] =>
    groupRows.filter(g => g.groupType === type).map(g => g.groupDetails?.name).filter(Boolean);
  const mySections = groupNames('section');

  // --- outlets --------------------------------------------------------------
  const sections = await call('/workspace/v2/sections');
  const sectionRows: SectionRow[] = items(sections).map((s: any) => ({
    id_prefix: String(s.id).slice(0, 8),
    name: s.name,
    tag: s.tag ?? null,
  }));
  const sectionName = new Map<string, string>(items(sections).map((s: any) => [s.id, s.name]));

  // BOH and FOH are separate SECTIONS here, which decides the whole design of
  // the labour split: it falls out of the data structurally rather than needing
  // the role mapping table the brief assumed.
  const bohFoh = sectionRows.filter(s => /\bBOH\b|\bFOH\b/i.test(s.name)).length;
  if (bohFoh > 0) {
    verdicts.push(`${bohFoh} section(s) name BOH or FOH explicitly, so the back-of-house / front-of-house split is structural in StaffAny and needs no role mapping.`);
  }

  // --- roles ----------------------------------------------------------------
  const roles = await call('/workspace/v2/roles');
  const roleName = new Map<string, string>(items(roles).map((r: any) => [r.id, r.name]));
  const roleNames: string[] = items(roles).map((r: any) => r.name);

  // --- does a roster exist at all -------------------------------------------
  /**
   * `shifts` is a DIFFERENT endpoint from `shift-slots`, and the spec is
   * explicit that they are siblings: a shift is the box on the roster, a slot
   * is a person put in it.
   *
   * That distinction is what StaffAny's own reply turns on. They suggested the
   * empty week was because the week was not published. Shifts present with no
   * slots means the roster exists and assignments are being withheld, which is
   * a permission question. Nothing at all means the week genuinely was not
   * built here, which is a question for the venues.
   */
  const shifts = await call('/workspace/v2/shifts', {
    start: `${START}T00:00:00Z`,
    end: `${END}T23:59:59Z`,
    limit: '100',
    includeUnpublished: 'true',
  });
  const shiftRows = items(shifts);
  const publishedShifts = shiftRows.filter((r: any) => r.isPublished).length;

  const shiftsBySection = new Map<string, number>();
  for (const r of shiftRows as any[]) {
    const key = sectionName.get(r.sectionId) ?? `unmapped:${String(r.sectionId).slice(0, 8)}`;
    shiftsBySection.set(key, (shiftsBySection.get(key) ?? 0) + 1);
  }

  // --- assignments, and the role link ---------------------------------------
  /**
   * Asked BOTH ways, because `includeUnpublished` defaults to false and an
   * empty week is indistinguishable from an unpublished one from outside.
   */
  const slotsPublished = await call('/workspace/v2/shift-slots', {
    start: `${START}T00:00:00Z`,
    end: `${END}T23:59:59Z`,
    limit: '100',  // the spec caps this at 100; 500 was rejected outright
  });

  let slots = slotsPublished;
  let inclUnpublishedCount = 0;
  if (slotsPublished.ok && items(slotsPublished).length === 0) {
    slots = await call('/workspace/v2/shift-slots', {
      start: `${START}T00:00:00Z`,
      end: `${END}T23:59:59Z`,
      limit: '100',
      includeUnpublished: 'true',
    });
    inclUnpublishedCount = items(slots).length;
  } else {
    inclUnpublishedCount = items(slotsPublished).length;
  }

  const slotRows = items(slots);

  /**
   * Whether a person works more than one role in a day decides how cost
   * attaches to a role: cost arrives per person per day with no role on it, so
   * one role a day joins exactly and two must be apportioned. Counted, never
   * assumed.
   */
  const rolesPerPersonDay = new Map<string, Set<string>>();
  for (const r of slotRows as any[]) {
    if (!r.userId || !r.roleId || !r.timeStart) continue;
    const key = `${r.userId}|${String(r.timeStart).slice(0, 10)}`;
    (rolesPerPersonDay.get(key) ?? rolesPerPersonDay.set(key, new Set()).get(key)!).add(r.roleId);
  }

  if (shiftRows.length > 0 && slotRows.length === 0) {
    verdicts.push('The roster EXISTS but no assignments came back. Shifts are present and shift-slots is empty, so assignments are being withheld from this token rather than absent from the business. That is a permission question for StaffAny, not a question for the venues.');
  } else if (slotRows.length > 0) {
    const multi = [...rolesPerPersonDay.values()].filter(s => s.size > 1).length;
    verdicts.push(multi === 0
      ? 'Every person worked a single role per day this week, so labour cost can be attributed to a role exactly.'
      : `${multi} person-day(s) span more than one role, so cost for those days must be apportioned and the split is not exact at the edges.`);
  }

  if (slotsPublished.ok && items(slotsPublished).length === 0 && inclUnpublishedCount > 0) {
    verdicts.push('Schedules are NOT published. The ingest must pass includeUnpublished=true or it will silently see no labour at all.');
  }

  // --- cost, and the permission question ------------------------------------
  //
  // The spec declares start and end as `type: integer` here and the API demands
  // YYYY-MM-DD in plain words. The spec is wrong about its own parameter, which
  // is the argument for probing an API rather than reading it.
  const firstSection = items(sections)[0];
  let costOutcome: Outcome = { ok: false, status: 0, error: 'skipped — no section to ask about' };
  let costRows: any[] = [];
  let costTotal: number | null = null;

  if (firstSection) {
    const cost = await call('/workspace/v2/schedule-costs', {
      start: START,
      end: END,
      sectionId: firstSection.id,
    });
    costOutcome = outcome(cost);
    if (cost.ok) {
      costRows = items(cost);
      // The TOTAL for one section is what the warehouse would store and is safe
      // to report. A per-person figure is that person's earnings and is not.
      costTotal = costRows.reduce((n, r) => n + (Number(r.totalCost) || 0), 0);
      verdicts.push('COST IS AVAILABLE. The back-of-house / front-of-house split can be a measurement rather than an hours-weighted estimate.');
    } else if (cost.status === 403) {
      verdicts.push('The token lacks EMPLOYEE_WAGE_VIEW or COST_DATA_VIEW, so labour cost is unreachable. The split must be hours-weighted and labelled an ESTIMATE everywhere it appears — a chef and a runner do not cost the same hour.');
    }
  }

  const gated = /experimental/i.test(costOutcome.error ?? '');
  if (gated) {
    verdicts.push('schedule-costs is still behind the workspaceApiV2ExperimentalEnabled flag. StaffAny said on 3 Sep 2026 that these endpoints are not fully tested on their side and that they would plan testing.');
  }

  // --- the ungated fallback -------------------------------------------------
  /**
   * Exactly TWO of this API's forty-three endpoints require the experimental
   * flag: schedule-costs and v2 timesheets/work-data. `POST
   * /workspace/v1/timesheets` is not one of them, and it returns CLOCKED
   * ATTENDANCE rather than the roster -- hours somebody actually worked, which
   * is the better input regardless -- carrying sectionId, which is the BOH/FOH
   * split.
   *
   * Three date encodings are tried because the spec declares this range
   * `integer` and made the same declaration on schedule-costs before demanding
   * YYYY-MM-DD. Guessing one form returns an empty week rather than an error,
   * which is indistinguishable from a quiet business.
   */
  const day = 86_400_000;
  const fromMs = Date.parse(`${START}T00:00:00Z`);
  const toMs = Date.parse(`${END}T00:00:00Z`) + day - 1000;

  const encodings: Array<[string, number | string, number | string]> = [
    ['epoch ms', fromMs, toMs],
    ['epoch seconds', Math.floor(fromMs / 1000), Math.floor(toMs / 1000)],
    ['YYYY-MM-DD', START, END],
  ];

  let tsOutcome: Outcome = { ok: false, status: 0, error: 'not attempted' };
  let tsEncoding: string | null = null;
  let workHours: any[] = [];
  let shiftRecords: any[] = [];

  for (const [label, from, to] of encodings) {
    const ts = await call('/workspace/v1/timesheets', {}, {
      range: { from, to },
      /**
       * All three, because the API requires it and the spec does not say so.
       *
       * `includes` is documented as an optional array with an enum of three
       * values, which reads as "pick the ones you want". Asking for
       * shiftRecords and workHours returned 500 with `"clockAttempts" is
       * required`. So the members are not independent: leave one out and the
       * request is rejected, with a server error rather than a validation
       * error, which is the sort of thing you only learn by asking.
       *
       * clockAttempts is a person clocking in and out. It is requested because
       * the endpoint will not answer otherwise, and it is NOT read -- only
       * workHours and shiftRecords are counted below, and neither the times nor
       * the people reach the caller.
       */
      includes: ['shiftRecords', 'clockAttempts', 'workHours'],
      limit: 100,
    });
    tsOutcome = outcome(ts);
    if (!ts.ok) continue;

    tsEncoding = label;
    workHours = Array.isArray(ts.body?.data?.workHours) ? ts.body.data.workHours : [];
    shiftRecords = Array.isArray(ts.body?.data?.shiftRecords) ? ts.body.data.shiftRecords : [];
    break;
  }

  const hoursBySection = new Map<string, number>();
  for (const w of workHours) {
    const key = sectionName.get(w.sectionId) ?? `unmapped:${String(w.sectionId).slice(0, 8)}`;
    hoursBySection.set(key, (hoursBySection.get(key) ?? 0) + 1);
  }
  const unmappedSections = [...hoursBySection.keys()].filter(k => k.startsWith('unmapped:')).length;

  if (workHours.length > 0) {
    verdicts.push('HOURS ARE REACHABLE WITHOUT THE EXPERIMENTAL FLAG, and they arrive already split by section, which is the BOH/FOH split. Cost is still gated, so a split built on hours alone is an ESTIMATE and stays labelled one.');
  }
  if (unmappedSections > 0) {
    // The Revel venue-key rule: an id with no name is flagged, never guessed.
    verdicts.push(`${unmappedSections} sectionId(s) in the timesheet have no matching section definition. Flag these, do not guess them.`);
  }

  /**
   * EVERY transactional endpoint empty while the reference data reads perfectly.
   *
   * Judged across all three -- shifts, assignments and clocked attendance --
   * rather than on the roster alone, which is what the earlier version got
   * wrong. One empty endpoint is ambiguous. Three empty endpoints beside seven
   * sections and thirty-seven roles is a shape: somebody configured this
   * organisation carefully, so the records almost certainly exist and this
   * token cannot see them.
   *
   * Stated as the likelier of two readings rather than as a fact, and the
   * cheaper thing to check is named first, because a week spent waiting on a
   * vendor for something a permission group would have fixed is the expensive
   * way to be wrong.
   */
  const referenceOk = sectionRows.length > 0 && roleNames.length > 0;
  const nothingTransactional = shiftRows.length === 0 && slotRows.length === 0 && workHours.length === 0;

  if (referenceOk && nothingTransactional) {
    verdicts.push(
      `Reference data reads perfectly (${sectionRows.length} sections, ${roleNames.length} roles) and every transactional endpoint is empty: no shifts, no assignments, no clocked hours. Nobody configures an organisation this thoroughly without rostering in it, so the likelier reading is that this token cannot SEE the records rather than that they do not exist. Check the access level and section memberships below before asking the venues.`,
    );
  }

  if (meV1.ok && mySections.length === 0) {
    verdicts.push('This token\'s user belongs to NO sections. StaffAny tie data access to permission groups, so a user attached to no section is the straightforward explanation for empty rosters and empty timesheets. Ask StaffAny to attach the integration user to every venue section, which needs no experimental flag.');
  }

  if (missingCostScopes.length > 0) {
    verdicts.push(`The token is missing ${missingCostScopes.join(', ')}, which schedule-costs lists as its requirements. Even once the experimental flag is on, that endpoint will refuse until these are granted — worth raising in the same message rather than a week later.`);
  }

  const toRows = (m: Map<string, number>): CountRow[] =>
    [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    window: { start: START, end: END },
    organisation: org.name ?? org.id ?? null,
    me: outcome(me),
    permissions: { ...outcome(meV1), access_level: accessLevel, scopes },
    groups: {
      ...outcome(groups),
      sections: mySections,
      teams: groupNames('team'),
      roles: groupNames('role'),
    },
    sections: { ...outcome(sections), items: sectionRows },
    roles: { ...outcome(roles), names: roleNames },
    shifts: {
      ...outcome(shifts),
      total: shiftRows.length,
      published: publishedShifts,
      unpublished: shiftRows.length - publishedShifts,
      has_more: shifts.body?.data?.meta?.hasMore ?? null,
      by_section: toRows(shiftsBySection),
    },
    shift_slots: {
      ...outcome(slots),
      published_only: items(slotsPublished).length,
      incl_unpublished: inclUnpublishedCount,
      with_role: slotRows.filter((r: any) => r.roleId).length,
      assigned: slotRows.filter((r: any) => r.userId).length,
      person_days: rolesPerPersonDay.size,
      multi_role_person_days: [...rolesPerPersonDay.values()].filter(s => s.size > 1).length,
      unnamed_role_ids: [...new Set(slotRows.map((r: any) => r.roleId).filter(Boolean))]
        .filter(id => !roleName.has(id as string)).length,
    },
    schedule_costs: {
      ...costOutcome,
      gated,
      rows: costRows.length,
      days: new Set(costRows.map((r: any) => r.date)).size,
      section: firstSection?.name ?? null,
      total: costTotal,
      breakdown_keys: Object.keys(costRows[0]?.costBreakdown ?? {}),
    },
    timesheets_v1: {
      ...tsOutcome,
      encoding: tsEncoding,
      shift_records: shiftRecords.length,
      work_hours: workHours.length,
      // Distinct people COUNTED, never listed. The count answers "is this the
      // whole team or a handful", which is all we need to know.
      distinct_staff: new Set(workHours.map((w: any) => w.userId).filter(Boolean)).size,
      /**
       * KEYS, never values. The spec's schema for a work-hour row lists
       * startTime and no end and no duration, which cannot be the whole of it,
       * and the real field list decides whether hours are a subtraction or must
       * be rebuilt from clock attempts. Printing a row would put a person's
       * shift on a screen; printing the names is enough to learn that.
       */
      work_hour_fields: workHours[0] ? Object.keys(workHours[0]) : [],
      shift_record_fields: shiftRecords[0] ? Object.keys(shiftRecords[0]) : [],
      by_section: toRows(hoursBySection),
      unmapped_sections: unmappedSections,
    },
    verdicts,
    not_called: NOT_CALLED,
  };
}
