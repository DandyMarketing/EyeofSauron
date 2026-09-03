import { supabase } from './supabase.js';

/**
 * Is every table in `public` actually protected?
 *
 * WHAT THIS IS FOR. The anon key is public by design: the web app fetches it
 * from /api/config so the browser can authenticate. Row-level security is
 * therefore the ONLY barrier between that key and a table's entire contents,
 * readable and writable through PostgREST. A table created without it is not
 * partly exposed. It is open.
 *
 * WHY IT IS AUTOMATED RATHER THAN REMEMBERED. reconciliation_alerts and
 * ingestion_log were added in migrations 004 and 008 and went about a year
 * without RLS. Every other table in the schema had it from creation, which is
 * precisely why nobody looked: the convention was so consistent that it read as
 * a property of the system rather than a step somebody has to take. A vendor's
 * periodic scan found it. Nothing of ours did, and nothing of ours could have.
 *
 * THE CHECK IS CHEAP AND THE FAILURE IS NOT. One query against the catalogue,
 * against reality rather than against the migrations we believe we ran -- which
 * matters here, because an un-run migration has already been a defect in this
 * codebase more than once.
 */

/** One table as the catalogue reports it. */
export interface TableSecurity {
  table_name: string;
  rls_enabled: boolean;
  policy_count: number;
}

/**
 * `exposed` is a fault. `deny_all` is a state worth seeing and usually correct.
 *
 * The distinction is real and it is not a hedge. xero_connections has RLS
 * enabled with no policy, and that is the CORRECT configuration for it: it
 * holds encrypted OAuth tokens, no client should ever read it, and the service
 * role bypasses RLS so the server still can. Reporting that as a fault would
 * put a permanent red line on a panel, and a monitor that is permanently red is
 * one nobody reads -- the Firangi Sunday lesson, which this codebase has now
 * learned in three separate places.
 */
export type RlsSeverity = 'exposed' | 'deny_all';

export interface RlsFinding {
  table: string;
  severity: RlsSeverity;
  detail: string;
}

export interface RlsAudit {
  /** False only when something is actually exposed. A deny-all table is not a fault. */
  ok: boolean;
  checked: number;
  exposed: RlsFinding[];
  deny_all: RlsFinding[];
}

/**
 * Pure, so the rule can be tested without a database.
 *
 * The alternative -- asserting against the live schema in a test -- sounds
 * stronger and is weaker: it needs credentials, so it skips wherever they are
 * absent, and a test that skips is indistinguishable from one that passes. The
 * live check belongs on the admin panel and in the audit script, where an
 * absent credential is an error rather than a silence.
 */
export function classifyTables(tables: TableSecurity[]): RlsAudit {
  const exposed: RlsFinding[] = [];
  const deny_all: RlsFinding[] = [];

  for (const t of tables) {
    if (!t.rls_enabled) {
      exposed.push({
        table: t.table_name,
        severity: 'exposed',
        detail: 'RLS is OFF. Anyone holding the anon key can read, edit and delete every row through PostgREST.',
      });
      continue;
    }

    if (t.policy_count === 0) {
      /**
       * Reported, never faulted, and with NO allowlist of expected tables.
       *
       * An allowlist would have to be edited every time the schema changed, so
       * it would rot, and a stale allowlist on a security check is worse than
       * none. Deny-all is also the safe direction to be wrong in: the cost of
       * an unintended one is that a feature does not work and somebody says so
       * within the day, where the cost of an unintended exposure is silence.
       */
      deny_all.push({
        table: t.table_name,
        severity: 'deny_all',
        detail: 'RLS is on with no policy, so every client is denied and only the service role can read it. Correct for secrets (xero_connections); a mistake if a user is meant to see this.',
      });
    }
  }

  return { ok: exposed.length === 0, checked: tables.length, exposed, deny_all };
}

/** The human-readable version, for a log line, an alert or a failing script. */
export function describeAudit(audit: RlsAudit): string {
  if (audit.ok && audit.deny_all.length === 0) {
    return `RLS: ${audit.checked} table(s) checked, all protected.`;
  }

  const lines: string[] = [];

  if (audit.exposed.length > 0) {
    lines.push(`TABLES WITHOUT RLS — ${audit.exposed.length} of ${audit.checked} are OPEN:`);
    for (const f of audit.exposed) lines.push(`  - public.${f.table}`);
    lines.push('The anon key is public by design, so these are readable and writable by anyone');
    lines.push('who loads the login page. Add `alter table ... enable row level security` and a');
    lines.push('policy in a migration.');
  }

  if (audit.deny_all.length > 0) {
    // Listed after the faults and worded as information, so it cannot be
    // mistaken for one.
    lines.push(`${audit.deny_all.length} table(s) have RLS on with no policy (deny-all, service role only):`);
    for (const f of audit.deny_all) lines.push(`  - public.${f.table}`);
    lines.push('Correct for a secrets table. Check each one is meant to be invisible to users.');
  }

  return lines.join('\n');
}

/**
 * Ask the database.
 *
 * A failed read must not read as "everything is protected". Same rule as
 * fetchNotes and socialFreshness: returning ok on an error is how a broken
 * check becomes indistinguishable from a healthy system, and on this particular
 * check that is the whole failure mode being defended against.
 */
export async function rlsAudit(): Promise<RlsAudit & { error?: string }> {
  const { data, error } = await supabase.rpc('rls_audit');

  if (error) {
    return {
      ok: false,
      checked: 0,
      exposed: [{
        table: '(audit failed)',
        severity: 'exposed',
        detail: `Could not read the table catalogue: ${error.message}. Migration 035 may not have been applied.`,
      }],
      deny_all: [],
      error: error.message,
    };
  }

  return classifyTables((data ?? []) as TableSecurity[]);
}
