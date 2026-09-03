-- Which tables in `public` are protected, asked of the database rather than of
-- our memory.
--
-- WHY THIS EXISTS. On 31 Aug 2026 a vendor's periodic scan found that
-- public.reconciliation_alerts and public.ingestion_log had never had row-level
-- security. They were added in migrations 004 and 008 and went about a year
-- without it. One of them carries monday_gross, revel_gross and difference:
-- actual daily revenue, per venue, per day. The anon key is public by design --
-- the web app fetches it from /api/config so the browser can authenticate -- so
-- RLS is the only thing between that key and a table, and for those two there
-- was nothing.
--
-- Migration 034 closed both. This closes the CLASS, which is the part that
-- matters: a table added without RLS is silent, and the only thing that has
-- ever found one here was somebody else's scanner. BUILD_LOG 4.4 names this as
-- the item to do before customer #2, on the grounds that it is the only form of
-- the check that runs BEFORE the data is exposed rather than after.
--
-- SECURITY INVOKER, DELIBERATELY. Migration 034's own note on the query RPCs
-- applies with more force here: this reads the system catalogue, so making it
-- SECURITY DEFINER would hand every caller a view of the schema running as the
-- function's owner, to close a hole about visibility. It runs as whoever calls
-- it, and only the service role is allowed to call it.
--
-- The catalogue is world-readable inside Postgres, but PostgREST does not
-- expose pg_class, so this function is the only route to it from a client. That
-- is exactly why the grants below matter more than the function body does.

create or replace function public.rls_audit()
returns table (
  table_name   text,
  rls_enabled  boolean,
  policy_count bigint
)
language sql
stable
set search_path = public, pg_catalog, pg_temp
as $$
  select
    c.relname::text,
    c.relrowsecurity,
    (select count(*) from pg_policy p where p.polrelid = c.oid)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    -- Ordinary tables only. A view has no RLS of its own and is governed by the
    -- tables beneath it, so listing views would put permanent unfixable rows on
    -- a report whose whole value is that a row on it means something.
    and c.relkind = 'r'
  order by c.relname;
$$;

-- The grants ARE the security here, so they are explicit in both directions
-- rather than trusting the default.
revoke execute on function public.rls_audit() from public;
revoke execute on function public.rls_audit() from anon;
revoke execute on function public.rls_audit() from authenticated;
grant  execute on function public.rls_audit() to service_role;

comment on function public.rls_audit() is
  'Every ordinary table in public with its RLS state and policy count. Service '
  'role only. Two tables once went a year without RLS and a vendor found it; '
  'this is how we find the next one first.';
