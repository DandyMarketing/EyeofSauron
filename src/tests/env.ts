/**
 * Test environment shim.
 *
 * `src/lib/supabase.ts` throws at import time when credentials are absent, so
 * any module that imports it — covers.ts, monday.ts — cannot be loaded by a
 * unit test without them. These placeholders let the pure functions in those
 * modules be tested; no network call is made, because creating a Supabase
 * client does not open a connection.
 *
 * Import this FIRST in any test that reaches a module touching the database.
 * ES modules execute in the order they are declared, so the assignment below
 * runs before the imports that follow it.
 *
 * Real values are never used here. If a test starts genuinely needing a
 * database, that is a signal it is no longer a unit test.
 */
process.env.SUPABASE_URL ||= 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
