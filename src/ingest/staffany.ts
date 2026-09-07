import type { WorkHourRow } from '../lib/staffany-client.js';

/**
 * Clocked attendance, reduced to something the warehouse may hold.
 *
 * THE WHOLE POINT IS WHAT IS THROWN AWAY. A work-hour row carries `userId` and
 * that person's cost for that shift. That is their earnings. CLAUDE.md's labour
 * section is unambiguous: hours are ingested aggregated by venue, date and
 * section, never by individual, and the strongest protection is not holding the
 * data at all. So the identity is used to COUNT distinct people and is then
 * dropped in the same pass -- it is never a key, never a column, never written.
 *
 * That is the same shape as the payroll bill lines in the Xero ingest, and for
 * the same reason: the aggregate answers every question this product asks, and
 * the detail answers none of them while carrying all of the risk.
 *
 * WHY SECTION IS ENOUGH. BOH and FOH are separate SECTIONS in this
 * organisation -- `Fat Prince BOH`, `Fat Prince FOH` -- and every work-hour row
 * carries `sectionId`. So the split the brief describes falls out structurally
 * and needs neither the role mapping table nor any apportionment. Roles still
 * matter for finer questions and are not needed here.
 */

/**
 * When a trading day ends, in venue-local hours.
 *
 * A shift starting at 17:00 Friday and finishing at 02:00 Saturday belongs to
 * Friday's trade, and a cleaning shift starting at 01:00 belongs to the night
 * before. Six in the morning is the usual F&B cut and it is a CONSTANT rather
 * than a literal because it is a business rule, not arithmetic.
 *
 * UNCONFIRMED AGAINST REVEL, deliberately flagged. Revel's business_date comes
 * out of a filename and we have never established what hour Revel closes its
 * own day at. If the two disagree, labour and sales for the same "day" are
 * measured over different windows, and a labour percentage built from them is
 * wrong in a way nothing would reveal. Confirm before publishing any labour-to-
 * sales figure.
 */
export const DAY_ENDS_AT_HOUR = 6;

export const VENUE_TZ = 'Asia/Singapore';

export interface SectionMapping {
  staffany_section_id: string;
  venue_id: string;
  /** BOH, FOH, or GROUP for a section that is not a kitchen or a floor. */
  area: string;
}

export interface LabourDay {
  venue_id: string;
  business_date: string;
  staffany_section_id: string;
  area: string;
  scheduled_hours: number;
  actual_hours: number;
  basic_cost: number;
  overtime_cost: number;
  weekend_cost: number;
  event_cost: number;
  other_cost: number;
  total_cost: number;
  /** Distinct people who worked. A COUNT; no identity is retained. */
  staff_count: number;
}

export interface AggregateResult {
  rows: LabourDay[];
  /** Section ids with no mapping. Flagged, never guessed, never ingested. */
  unmapped_sections: string[];
  /** Rows dropped because their section is unmapped. */
  skipped_rows: number;
  /** Rows carrying no usable cost at all, which would understate a total. */
  costless_rows: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/**
 * The trading date a shift belongs to, in venue-local terms.
 *
 * `startTime` is UTC and Singapore is eight hours ahead, so a shift starting at
 * 21:00 local is already the next calendar day in UTC. Taking the UTC date
 * would file a third of every evening's labour under tomorrow.
 */
export function businessDateOf(startTimeUtc: string, tz: string = VENUE_TZ): string | null {
  const t = Date.parse(startTimeUtc);
  if (Number.isNaN(t)) return null;

  // en-CA gives YYYY-MM-DD, and the hour comes from the same conversion so the
  // two can never disagree about which local day they describe.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date(t));

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const localDate = `${get('year')}-${get('month')}-${get('day')}`;
  const localHour = Number(get('hour'));

  if (localHour >= DAY_ENDS_AT_HOUR) return localDate;

  // Before the cut, so it belongs to the night that started it.
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Sum a cost field, whatever shape it arrives in.
 *
 * Measured as `{ basicCost, eventCost, weekendCost, overtimeCost }`. The four
 * are named because the split is the useful half -- a total says labour was
 * expensive and the components say why -- but anything else numeric lands in
 * `other_cost` rather than being dropped, so an unknown fifth member added by
 * StaffAny later shows up as an unexplained bucket instead of silently
 * shrinking the total.
 */
export function splitCost(raw: unknown): {
  basic: number; overtime: number; weekend: number; event: number; other: number; total: number;
} {
  const out = { basic: 0, overtime: 0, weekend: 0, event: 0, other: 0, total: 0 };

  if (typeof raw === 'number' || typeof raw === 'string') {
    const n = num(raw);
    return { ...out, other: n, total: n };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = num(value);
    if (n === 0) continue;
    switch (key) {
      case 'basicCost': out.basic += n; break;
      case 'overtimeCost': out.overtime += n; break;
      case 'weekendCost': out.weekend += n; break;
      case 'eventCost': out.event += n; break;
      default: out.other += n; break;
    }
    out.total += n;
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function aggregateWorkHours(
  rows: WorkHourRow[],
  mappings: SectionMapping[],
): AggregateResult {
  const bySection = new Map(mappings.map(m => [m.staffany_section_id, m]));

  const acc = new Map<string, LabourDay & { people: Set<string> }>();
  const unmapped = new Set<string>();
  let skipped = 0;
  let costless = 0;

  for (const row of rows) {
    /**
     * An unmapped section is FLAGGED and NOT INGESTED, which is the Revel
     * venue-key rule and the opposite of the account-map rule one file over.
     * The difference is what the default would do: an unmapped Xero account
     * falling back to its own name merges nothing and moves no figure, while a
     * section guessed into a venue puts another venue's labour cost on this
     * venue's P&L comparison. Timesheets can be re-fetched, so nothing is lost
     * by waiting for a person to confirm the mapping.
     */
    const mapping = bySection.get(row.sectionId);
    if (!mapping) {
      unmapped.add(row.sectionId);
      skipped++;
      continue;
    }

    const businessDate = businessDateOf(row.startTime);
    if (businessDate === null) { skipped++; continue; }

    const key = `${mapping.staffany_section_id}|${businessDate}`;
    let day = acc.get(key);
    if (!day) {
      day = {
        venue_id: mapping.venue_id,
        business_date: businessDate,
        staffany_section_id: mapping.staffany_section_id,
        area: mapping.area,
        scheduled_hours: 0, actual_hours: 0,
        basic_cost: 0, overtime_cost: 0, weekend_cost: 0, event_cost: 0, other_cost: 0,
        total_cost: 0, staff_count: 0,
        people: new Set<string>(),
      };
      acc.set(key, day);
    }

    day.scheduled_hours += num(row.scheduledHours);
    day.actual_hours += num(row.actualHours);

    // Actual where we have it, scheduled as the fallback, and counted when
    // neither exists -- a row silently contributing zero would understate the
    // day without changing anything a reader could see.
    const actual = splitCost(row.actualCosts);
    const cost = actual.total !== 0 ? actual : splitCost(row.scheduledCosts);
    if (cost.total === 0) costless++;

    day.basic_cost += cost.basic;
    day.overtime_cost += cost.overtime;
    day.weekend_cost += cost.weekend;
    day.event_cost += cost.event;
    day.other_cost += cost.other;
    day.total_cost += cost.total;

    // The ONLY use of userId. It is counted here and never leaves this scope.
    if (row.userId) day.people.add(row.userId);
  }

  const out: LabourDay[] = [...acc.values()].map(({ people, ...day }) => ({
    ...day,
    scheduled_hours: round2(day.scheduled_hours),
    actual_hours: round2(day.actual_hours),
    basic_cost: round2(day.basic_cost),
    overtime_cost: round2(day.overtime_cost),
    weekend_cost: round2(day.weekend_cost),
    event_cost: round2(day.event_cost),
    other_cost: round2(day.other_cost),
    total_cost: round2(day.total_cost),
    staff_count: people.size,
  }));

  out.sort((a, b) => a.business_date.localeCompare(b.business_date) || a.staffany_section_id.localeCompare(b.staffany_section_id));

  return {
    rows: out,
    unmapped_sections: [...unmapped],
    skipped_rows: skipped,
    costless_rows: costless,
  };
}
