-- The distinct account names in the ledger, so the admin console stops reading
-- the whole ledger to find them.
--
-- WHY THIS EXISTS, and it is a correctness bug before it is a speed one. The
-- /admin/api/account-map handler answers "which ledger accounts are not mapped
-- yet" by pulling EVERY non-summary row of profit_and_loss and reducing it to
-- distinct (venue_id, account_name) pairs in JavaScript. Two things are wrong
-- with that:
--
--   1. PostgREST caps a response at 1,000 rows. The query had no paging, so it
--      has been reading the first thousand rows and no more -- and three venues
--      over two years is several thousand. Any account appearing only outside
--      that first page was reported as MAPPED when nobody had mapped it. A list
--      whose entire job is to say what still needs attention was quietly short.
--      This is the same cap recorded in BUILD_LOG 1.x and in the comment on
--      fetchAccountMap(), which says it has cost this project data four times.
--      Five.
--
--   2. It is thousands of rows across the wire, on every admin page load, to
--      compute a few dozen names.
--
-- A view fixes both: Postgres does the DISTINCT, and what crosses the wire is
-- the answer rather than the raw material.
--
-- NOT A MATERIALISED VIEW, deliberately. This is read when somebody opens the
-- admin console -- a handful of times a day -- and a materialised view would
-- need refreshing after every Xero ingest or it would answer with yesterday's
-- accounts, which is precisely the silent staleness this migration is removing.

create or replace view public.profit_and_loss_accounts
with (security_invoker = true)
as
  select distinct
    venue_id,
    account_name
  from public.profit_and_loss
  where is_summary = false
    and account_name is not null
    and account_name <> '';

comment on view public.profit_and_loss_accounts is
  'Distinct (venue_id, account_name) pairs from the ledger, for the admin '
  'console''s unmapped-accounts list. A view rather than a client-side reduce '
  'because the client-side version read only the first 1,000 rows and under-'
  'reported what was unmapped.';

-- SECURITY_INVOKER = TRUE is the important word in this file.
--
-- A view in Postgres runs as its OWNER by default, which would make this a hole
-- straight through the row-level security on profit_and_loss: any signed-in
-- client could read every venue's account names regardless of their own venue
-- grant. With security_invoker the view is evaluated as the CALLER, so the
-- policies on the underlying table apply exactly as they do to a direct query.
--
-- The admin console reads it with the service role, which bypasses RLS as it
-- does everywhere else, and is gated by requireOwner() in the handler.
--
-- Account names carry no amounts, so the exposure would have been mild. It
-- would also have been invisible, and rls_audit() does not inspect views --
-- which is exactly why this is stated here rather than assumed.

grant select on public.profit_and_loss_accounts to authenticated;
