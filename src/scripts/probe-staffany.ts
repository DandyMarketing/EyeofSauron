import 'dotenv/config';
import { probeStaffAny } from '../lib/staffany-probe.js';

/**
 * The terminal front end for the StaffAny probe.
 *
 * All of the logic lives in src/lib/staffany-probe.ts so the admin console can
 * run the same thing from a button. That is the point of the split: everything
 * else in this system ships through GitHub and runs on Railway, and a
 * diagnostic that needed a local clone and a CLI login was the one thing that
 * did not. This file remains for the case where somebody already has a terminal
 * open, and it must never grow logic of its own -- two implementations of a
 * probe would eventually disagree, and the one nobody ran would be the one
 * still believed.
 */

const KEY = process.env.STAFFANY_API_KEY;
if (!KEY) {
  console.error('STAFFANY_API_KEY is not set. Add it as a sealed variable on this service.');
  process.exit(1);
}

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];

const r = await probeStaffAny({ key: KEY, start: arg('start'), end: arg('end') });

const line = (label: string, o: { ok: boolean; status: number; error: string | null }) =>
  `${label}: ${o.ok ? 'OK' : `${o.status} — ${o.error}`}`;

console.log(`StaffAny probe — ${r.window.start} to ${r.window.end}`);
console.log('Reads only. Nothing is written, no payroll or compensation endpoint is called.\n');

console.log(line('me', r.me));
console.log(`  organisation: ${r.organisation ?? '(not named in response)'}\n`);

console.log(line('sections', r.sections));
for (const s of r.sections.items) console.log(`  ${s.id_prefix}…  ${s.name}${s.tag ? `  [${s.tag}]` : ''}`);
console.log('');

console.log(line('roles', r.roles));
for (const n of r.roles.names) console.log(`  ${n}`);
console.log(`  (${r.roles.names.length} role(s) — what the BOH/FOH mapping table must cover)\n`);

console.log(line('shifts (incl. unpublished)', r.shifts));
console.log(`  ${r.shifts.total} shift(s): ${r.shifts.published} published, ${r.shifts.unpublished} unpublished; hasMore=${r.shifts.has_more}`);
for (const s of r.shifts.by_section) console.log(`    ${String(s.count).padStart(4)}  ${s.name}`);
console.log('');

console.log(line('shift-slots', r.shift_slots));
console.log(`  ${r.shift_slots.published_only} published-only, ${r.shift_slots.incl_unpublished} including unpublished`);
console.log(`  ${r.shift_slots.with_role} carry a roleId, ${r.shift_slots.assigned} are assigned to somebody`);
console.log(`  ${r.shift_slots.person_days} person-day(s), of which ${r.shift_slots.multi_role_person_days} span more than one role`);
if (r.shift_slots.unnamed_role_ids > 0) {
  console.log(`  ${r.shift_slots.unnamed_role_ids} roleId(s) have no matching role definition — flag, do not guess`);
}
console.log('');

console.log(line('schedule-costs', r.schedule_costs));
if (r.schedule_costs.ok) {
  console.log(`  ${r.schedule_costs.rows} row(s) across ${r.schedule_costs.days} day(s) for "${r.schedule_costs.section}"`);
  console.log(`  section total for the week: ${r.schedule_costs.total?.toFixed(2)}`);
  console.log(`  breakdown keys: ${r.schedule_costs.breakdown_keys.join(', ') || 'none'}`);
}
console.log('');

console.log(line(`timesheets v1${r.timesheets_v1.encoding ? ` (${r.timesheets_v1.encoding})` : ''}`, r.timesheets_v1));
if (r.timesheets_v1.ok) {
  console.log(`  ${r.timesheets_v1.shift_records} shift record(s), ${r.timesheets_v1.work_hours} work-hour row(s)`);
  console.log(`  ${r.timesheets_v1.distinct_staff} distinct staff appear`);
  console.log(`  work-hour fields: ${r.timesheets_v1.work_hour_fields.join(', ') || 'none'}`);
  console.log(`  shift-record fields: ${r.timesheets_v1.shift_record_fields.join(', ') || 'none'}`);
  for (const s of r.timesheets_v1.by_section) console.log(`    ${String(s.count).padStart(4)}  ${s.name}`);
}
console.log('');

console.log('--- what this settles ---');
for (const v of r.verdicts) console.log(`  • ${v}`);
if (r.verdicts.length === 0) console.log('  (nothing conclusive — read the counts above)');

console.log('\nNot called, deliberately:');
for (const p of r.not_called) console.log(`  ${p}`);
console.log('NONE of those is gated. Every one is on the free surface of this API, reachable');
console.log('with the token we already hold. With Xero the protection is a scope we refused and');
console.log('therefore cannot use by accident; here there is no scope to refuse, so not writing');
console.log('the call is the entire protection.');
