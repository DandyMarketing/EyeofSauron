import 'dotenv/config';
import { rlsAudit, describeAudit } from '../lib/rls-audit.js';

/**
 * Fail if any table in `public` is missing row-level security.
 *
 * THE EXIT CODE IS THE POINT. The same audit is rendered on the admin console,
 * where it is a thing somebody may look at; here it is a thing that can stop a
 * deploy. BUILD_LOG 4.4 asks for the check that runs BEFORE an exposure rather
 * than after, and only a non-zero exit does that.
 *
 * It reads the live catalogue, not the migrations directory, which is
 * deliberate: an un-run migration has been a defect here more than once, and a
 * check that reads what we INTENDED would have passed on every one of those
 * days.
 *
 * A deny-all table is printed and does not fail the run. The reasoning is in
 * classifyTables(): xero_connections is meant to be invisible to every client,
 * and failing on it would make this script permanently red and therefore
 * ignored.
 */

const audit = await rlsAudit();

console.log(describeAudit(audit));

if (!audit.ok) {
  console.error('');
  console.error(`FAILED — ${audit.exposed.length} table(s) in public have no row-level security.`);
  process.exit(1);
}
