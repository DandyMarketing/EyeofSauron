/**
 * The 1,000-row cap, and why there is a test that reads the whole codebase.
 *
 * The database returns at most 1,000 rows per request and says nothing when it
 * stops. It has cost this product a correct answer at least four times: the
 * admin console's unmapped accounts (migration 049), BUILD_LOG 1.1, and on
 * 6 Oct 2026 the cost panel -- which read a month of bill lines in one request
 * when every venue had more than 1,000 -- plus a `.limit(5000)` on labour and a
 * `.limit(10000)` on product mix that the database quietly treated as 1,000.
 *
 * Fixing each one as it surfaces is what kept letting the next one through. So
 * the rule is now enforced: EVERY read must say how it is bounded, or it fails
 * here before it can ship.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readAllPages, selectAll, rowCapWarning, PAGE_SIZE } from './paged.js';

describe('reading every page', () => {
  const pager = (total: number) => {
    const calls: Array<[number, number]> = [];
    const page = async (from: number, to: number) => {
      calls.push([from, to]);
      const n = Math.max(0, Math.min(to, total - 1) - from + 1);
      return { data: Array.from({ length: n }, (_, i) => from + i), error: null };
    };
    return { calls, page };
  };

  test('reads past the first 1,000', async () => {
    const { page } = pager(1556);   // Firangi's September bill lines
    const rows = await readAllPages(page);
    assert.equal(rows.length, 1556);
    assert.equal(new Set(rows).size, 1556, 'no row twice');
  });

  test('a full last page is followed by one more read, which comes back empty', async () => {
    const { page, calls } = pager(2000);
    assert.equal((await readAllPages(page)).length, 2000);
    assert.equal(calls.length, 3);
  });

  test('a short page ends it', async () => {
    const { page, calls } = pager(12);
    assert.equal((await readAllPages(page)).length, 12);
    assert.equal(calls.length, 1);
  });

  test('an error is an error, never a short answer', async () => {
    await assert.rejects(readAllPages(async () => ({ data: null, error: { message: 'boom' } })), /boom/);
  });

  test('selectAll orders by the unique id and pages', async () => {
    const seen: string[] = [];
    const fake = () => ({
      order(col: string) { seen.push(`order:${col}`); return this; },
      range(from: number, to: number) { seen.push(`range:${from}-${to}`); return Promise.resolve({ data: [], error: null }); },
    });
    const r = await selectAll(fake);
    assert.deepEqual(r, { data: [], error: null });
    assert.deepEqual(seen, ['order:id', `range:0-${PAGE_SIZE - 1}`]);
  });

  test('selectAll reports a failure in the shape callers already check', async () => {
    const r = await selectAll(() => ({ order() { return this; }, range: () => Promise.resolve({ data: null, error: { message: 'nope' } }) }));
    assert.deepEqual(r, { data: [], error: { message: 'nope' } });
  });
});

describe('the runtime alarm', () => {
  const url = (q: string) => `https://x.supabase.co/rest/v1/supplier_bill_lines?select=*${q}`;

  test('an unpaged read that comes back at the cap is reported, by table', () => {
    const w = rowCapWarning(url(''), 'GET', '0-999/*');
    assert.match(w ?? '', /\[row-cap\] supplier_bill_lines returned 1000 rows/);
  });

  test('a page of a paged read is not', () => {
    assert.equal(rowCapWarning(url('&offset=1000&limit=1000'), 'GET', '1000-1999/*'), null);
  });

  test('a read under the cap is not', () => {
    assert.equal(rowCapWarning(url(''), 'GET', '0-312/*'), null);
  });

  test('writes and RPCs are not', () => {
    assert.equal(rowCapWarning(url(''), 'POST', '0-999/*'), null);
    assert.equal(rowCapWarning('https://x.supabase.co/rest/v1/rpc/guest_retention', 'GET', '0-999/*'), null);
  });
});

// ── The whole-codebase check ────────────────────────────────────────────────

/** Comments blanked out (newlines kept), so a comma or a word in one is not code. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

interface Read { file: string; line: number; table: string; chain: string }

/** Every `.from('table')` chain that SELECTS and does not write. */
export function readsIn(file: string, original: string): Read[] {
  const src = stripComments(original);
  const out: Read[] = [];
  const re = /\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0, j = m.index;
    for (; j < src.length; j++) {
      const c = src[j];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
      else if ((c === ';' || c === ',') && depth === 0) break;
    }
    const chain = src.slice(m.index, j);
    if (!/\.select\(/.test(chain) || /\.(insert|upsert|update|delete)\(/.test(chain)) continue;
    out.push({ file, line: src.slice(0, m.index).split('\n').length, table: m[1], chain });
  }
  return out;
}

/** Why a read cannot be cut off, or null if nothing says so. */
export function boundOf(read: Read, original: string): string | null {
  const c = read.chain;
  if (/\.(single|maybeSingle)\(/.test(c)) return 'one row';
  if (/head:\s*true/.test(c)) return 'a count';
  if (/\.range\(/.test(c)) return 'paged';
  const limit = /\.limit\(\s*(\d+)\s*\)/.exec(c);
  // A deliberate top-N. Anything at or past the cap is not a bound at all: the
  // database returns 1,000 whatever is asked for.
  if (limit && Number(limit[1]) <= 500) return 'top-N';

  const lines = original.split('\n');
  // Wrapped in the pager: the call sits just before the `.from(` it reads.
  const lead = lines.slice(Math.max(0, read.line - 4), read.line).join('\n');
  if (/selectAll\(|readAllPages\(/.test(lead)) return 'paged';
  // Or a person has written down why it is small.
  if (/row-cap:/.test(lead)) return 'annotated';
  return null;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('every read in the codebase says how it is bounded', () => {
  const files = sourceFiles('src');
  const reads = files.flatMap(f => readsIn(f, readFileSync(f, 'utf8')).map(r => ({ r, src: readFileSync(f, 'utf8') })));

  test('the scan actually finds the reads (a check that sees nothing passes everything)', () => {
    assert.ok(reads.length > 80, `found only ${reads.length} reads`);
  });

  test('no read can be silently cut off at 1,000 rows', () => {
    const unbounded = reads.filter(({ r, src }) => !boundOf(r, src)).map(({ r }) => `${r.file}:${r.line} ${r.table}`);
    assert.deepEqual(unbounded, [],
      'These reads can stop at 1,000 rows without saying so. Wrap them in selectAll() from src/lib/paged.ts, ' +
      'or, if the table can never come close (one row per venue, one day of one venue), put a ' +
      '"// row-cap: <why>" comment directly above them.');
  });

  test('no limit at or above the cap is passed off as a bound', () => {
    const fake = files.flatMap(f => {
      const src = stripComments(readFileSync(f, 'utf8'));
      return [...src.matchAll(/\.limit\(\s*(\d+)\s*\)/g)]
        .filter(m => Number(m[1]) >= 1000)
        .map(m => `${f}:${src.slice(0, m.index).split('\n').length} .limit(${m[1]})`);
    });
    assert.deepEqual(fake, [], 'The database caps every request at 1,000 rows; a larger limit is ignored. Use selectAll().');
  });

  /**
   * selectAll pages in `id` order, so a table without an `id` column fails at
   * the first request. school_calendar has none, and wrapping it broke the
   * school-holiday tool in testing. The migrations say which tables have one.
   */
  test('selectAll is only used on tables that have an id column', () => {
    const migrations = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(join('supabase/migrations', f), 'utf8')).join('\n');
    const hasId = (table: string) =>
      new RegExp(`create table[^(]*\\b${table}\\b\\s*\\(\\s*id\\b`, 'i').test(migrations);
    const wrapped = reads.filter(({ r, src }) => {
      const lines = src.split('\n');
      return /selectAll\(/.test(lines.slice(Math.max(0, r.line - 4), r.line).join('\n'));
    }).map(({ r }) => r);
    assert.ok(wrapped.length > 30, 'the scan should find the wrapped reads');
    const missing = wrapped.filter(r => !hasId(r.table)).map(r => `${r.file}:${r.line} ${r.table}`);
    assert.deepEqual(missing, []);
  });

  test('the check recognises what it is meant to', () => {
    const bounded = (code: string) => readsIn('x.ts', code).map(r => boundOf(r, code));
    assert.deepEqual(bounded(`const a = await supabase.from('t').select('x').eq('a', 1);`), [null]);
    assert.deepEqual(bounded(`const a = await supabase.from('t').select('x').limit(5000);`), [null]);
    assert.deepEqual(bounded(`const a = await supabase.from('t').select('x').maybeSingle();`), ['one row']);
    assert.deepEqual(bounded(`const a = await selectAll(() => supabase\n  .from('t').select('x'));`), ['paged']);
    assert.deepEqual(bounded(`// row-cap: one per venue\nconst a = await supabase.from('t').select('x');`), ['annotated']);
    // A comma in a comment is not the end of the chain.
    assert.deepEqual(bounded(`const a = await supabase.from('t').select('x')\n  // a, b\n  .limit(1);`), ['top-N']);
    // Writes are not reads.
    assert.deepEqual(bounded(`await supabase.from('t').upsert(rows).select('id');`), []);
  });
});
