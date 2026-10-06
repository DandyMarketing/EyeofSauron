/**
 * Read every row of a query, a page at a time.
 *
 * THE DATABASE RETURNS AT MOST 1,000 ROWS PER REQUEST AND SAYS NOTHING WHEN IT
 * STOPS. BUILD_LOG 1.1 recorded this in August; on 6 Oct 2026 it turned up again
 * in the cost panel, which read a month of supplier bill lines in one request.
 * September had 1,556 lines at Firangi, 1,102 at Fat Prince and 1,001 at Neon
 * Pigeon, so every venue lost the tail of its month. The panel then reported
 * Firangi's bills as explaining 52% of its ledger food cost when they explained
 * 91%, and withheld a food cost that matched Monday's to the decimal.
 *
 * Two rules, both of them the difference between correct and nearly correct:
 *
 *   - A FULL page means there is probably another. Only a short page ends it.
 *   - The caller must ORDER BY something unique. Offset paging over an unordered
 *     result can return a row twice and skip another (BUILD_LOG 1.3), and a
 *     duplicated bill line is spend counted twice.
 */
export const PAGE_SIZE = 1000;

export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  size = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message);
    const got = data ?? [];
    rows.push(...got);
    if (got.length < size) return rows;
  }
}

/**
 * Every row of a query, in the `{ data, error }` shape a single read returns,
 * so a call site changes by one wrap and nothing else.
 *
 * `build` must return a FRESH query each time it is called: each page is its own
 * request. Pages are ordered by `id` (after any order the query already has),
 * which every warehouse table carries and which is unique, so paging can neither
 * repeat nor skip a row.
 */
export async function selectAll<T = any>(
  build: () => any,
): Promise<{ data: T[]; error: { message: string } | null }> {
  try {
    const data = await readAllPages<T>((from, to) =>
      build().order('id', { ascending: true }).range(from, to));
    return { data, error: null };
  } catch (e: any) {
    return { data: [], error: { message: e?.message ?? String(e) } };
  }
}

/**
 * The runtime half: say so loudly when a request comes back AT the cap.
 *
 * The test in paged.test.ts makes every read in the code declare how it is
 * bounded, but it reads source text, and a query assembled some way it does not
 * recognise would get past it. This watches the responses instead. A read that
 * was not paged (no `offset` on the request) and returned 1,000 rows has almost
 * certainly been cut short, so it is logged with the table name, where a wrong
 * figure would otherwise be the only symptom.
 */
export function rowCapWarning(url: string, method: string, contentRange: string | null): string | null {
  if (method.toUpperCase() !== 'GET' || !contentRange) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const m = /\/rest\/v1\/([^/?]+)/.exec(u.pathname);
  if (!m || m[1] === 'rpc') return null;
  if (u.searchParams.has('offset')) return null;   // a paged read: full pages are expected
  const r = /^(\d+)-(\d+)\//.exec(contentRange);
  if (!r) return null;
  const rows = Number(r[2]) - Number(r[1]) + 1;
  if (rows < PAGE_SIZE) return null;
  return `[row-cap] ${m[1]} returned ${rows} rows in one unpaged request — it has very probably been cut off ` +
    'at the database\'s 1,000-row limit and the figure built on it is short. Read it with selectAll(). See src/lib/paged.ts.';
}

export const rowCapFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const warning = rowCapWarning(url, method, res.headers.get('content-range'));
    if (warning) console.error(warning);
  } catch { /* the alarm must never break the read it is watching */ }
  return res;
};
