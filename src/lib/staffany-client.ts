/**
 * The one place that talks to StaffAny.
 *
 * Extracted from the probe when the ingest needed the same three behaviours,
 * and for the reason the probe script already carries at the top of its file:
 * two implementations of the same request eventually disagree, and the one
 * nobody exercises is the one still believed. Every quirk below was measured
 * rather than read, because this API's published spec has now been wrong four
 * separate times.
 *
 * WHAT IT KNOWS THAT THE SPEC DOES NOT:
 *
 *  - `sectionIds` must be named EXPLICITLY. Omit it and the API narrows
 *    silently to the caller's own sections and returns 200 with zero rows. That
 *    cost three days and is recorded as BUILD_LOG 1.5. An ingest that omits it
 *    runs green every night and writes nothing.
 *  - `limit` is capped at 100 whatever you ask for, so everything pages.
 *  - The v1 read endpoints are POSTs whose filters and cursor live in the BODY.
 *    They are still reads.
 *  - `includes` on timesheets is presented as an optional pick-list of three
 *    and rejects any request missing `clockAttempts`, with a 500 rather than a
 *    validation error.
 */

export const STAFFANY_BASE = 'https://api.staffany.com';

/**
 * A ceiling on pages, so a cursor that never terminates cannot spin for ever.
 *
 * Hitting it is REPORTED rather than treated as the end of the data. That
 * distinction is the whole subject of BUILD_LOG section 1: a job that stops
 * early and says nothing is indistinguishable from one that finished.
 */
export const MAX_PAGES = 200;

export interface StaffAnyResponse { ok: boolean; status: number; body: any }

export interface Page<T> {
  /** The FIRST response, kept so a failure reports its own status and body. */
  first: StaffAnyResponse;
  rows: T[];
  pages: number;
  /** True when we stopped at MAX_PAGES rather than because the server said so. */
  truncated: boolean;
}

export function staffAnyKey(): string {
  const key = process.env.STAFFANY_API_KEY;
  if (!key) {
    throw new Error('STAFFANY_API_KEY is not set. Add it as a sealed variable on this service.');
  }
  return key;
}

export async function staffAnyCall(
  key: string,
  path: string,
  query: Record<string, string | string[] | undefined> = {},
  payload?: unknown,
): Promise<StaffAnyResponse> {
  // An array becomes a repeated key -- sectionIds=a&sectionIds=b -- OpenAPI's
  // default form style with explode true.
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v as string]).map(one => `${k}=${encodeURIComponent(one)}`))
    .join('&');

  const res = await fetch(`${STAFFANY_BASE}${path}${qs ? `?${qs}` : ''}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
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

/** Every page of a GET endpoint that returns `data.items` with a cursor. */
export async function pageItems<T = any>(
  key: string,
  path: string,
  query: Record<string, string | string[] | undefined>,
): Promise<Page<T>> {
  const rows: T[] = [];
  let cursor: string | undefined;
  let first: StaffAnyResponse | null = null;
  let pages = 0;

  for (; pages < MAX_PAGES; pages++) {
    const p = await staffAnyCall(key, path, { ...query, cursor });
    if (first === null) first = p;
    if (!p.ok) return { first, rows, pages, truncated: false };

    if (Array.isArray(p.body?.data?.items)) rows.push(...p.body.data.items);

    const meta = p.body?.data?.meta ?? {};
    // hasMore is the authority. A nextCursor with hasMore false would loop.
    if (!meta.hasMore || !meta.nextCursor) return { first, rows, pages: pages + 1, truncated: false };
    cursor = meta.nextCursor;
  }

  return { first: first!, rows, pages, truncated: true };
}

export interface WorkHourRow {
  id: string;
  userId: string;
  sectionId: string;
  startTime: string;
  scheduledHours?: number | string | null;
  actualHours?: number | string | null;
  scheduledCosts?: Record<string, number | string> | number | string | null;
  actualCosts?: Record<string, number | string> | number | string | null;
}

/**
 * Every page of clocked attendance for a window.
 *
 * Paged by hand rather than through pageItems: this endpoint is a POST, its
 * cursor lives in the body, and its rows arrive in named collections rather
 * than an `items` array. `clockAttempts` is requested because the endpoint
 * refuses without it, and is never read -- neither the clock times nor the
 * people reach the caller.
 */
export async function fetchWorkHours(
  key: string,
  sectionIds: string[],
  fromMs: number,
  toMs: number,
): Promise<Page<WorkHourRow>> {
  const body = (cursor?: string) => ({
    range: { from: fromMs, to: toMs },
    includes: ['shiftRecords', 'clockAttempts', 'workHours'],
    limit: 100,
    sectionIds,
    ...(cursor ? { cursor } : {}),
  });

  const rows: WorkHourRow[] = [];
  let page = await staffAnyCall(key, '/workspace/v1/timesheets', {}, body());
  const first = page;
  let pages = 0;

  for (; pages < MAX_PAGES; pages++) {
    if (!page.ok) return { first, rows, pages, truncated: false };
    if (Array.isArray(page.body?.data?.workHours)) rows.push(...page.body.data.workHours);

    const meta = page.body?.data?.meta ?? {};
    if (!meta.hasMore || !meta.nextCursor) return { first, rows, pages: pages + 1, truncated: false };

    page = await staffAnyCall(key, '/workspace/v1/timesheets', {}, body(meta.nextCursor));
  }

  return { first, rows, pages, truncated: true };
}

/** Sections as StaffAny defines them. Names are venues', never a person's. */
export async function fetchSections(key: string): Promise<Array<{ id: string; name: string; tag: string | null }>> {
  const res = await staffAnyCall(key, '/workspace/v2/sections');
  if (!res.ok) throw new Error(`StaffAny sections failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return (res.body?.data?.items ?? []).map((s: any) => ({ id: s.id, name: s.name, tag: s.tag ?? null }));
}
