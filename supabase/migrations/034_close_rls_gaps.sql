-- Two tables were readable by anyone with the project URL, and one of them
-- holds revenue.
--
-- Supabase's security advisor, 31 Aug 2026: `rls_disabled_in_public` on
-- public.reconciliation_alerts and public.ingestion_log. Every other table in
-- this schema has had RLS since it was created; these two were added in
-- migrations 004 and 008 and never got it, and nothing noticed for a year.
--
-- WHY THIS IS NOT THEORETICAL. The anon key is PUBLIC by design -- the web app
-- fetches it from /api/config so the browser can authenticate. RLS is the only
-- thing standing between that key and a table. Without it, anyone who loads the
-- login page can read, edit and delete the table's entire contents through
-- PostgREST.
--
-- reconciliation_alerts is the serious one. It carries monday_gross,
-- revel_gross and difference: actual daily revenue, per venue, per day. That is
-- the WHO dimension of the security model defeated completely -- not a manager
-- seeing another venue, but anybody at all seeing every venue.
--
-- ingestion_log carries no money, and its exposure is the other direction:
-- filenames, venue keys and error messages are readable, and the whole
-- watchdog history is DELETABLE. A watchdog whose record can be erased by a
-- stranger is not a watchdog.
--
-- The service role bypasses RLS, so the server, the jobs and every query tool
-- are unaffected by any of this. Nothing below can break the app; it can only
-- close a door that was standing open.

-- --- reconciliation_alerts: venue-scoped, same rule as everything else ------

alter table public.reconciliation_alerts enable row level security;

drop policy if exists "Users can view alerts for their venues" on public.reconciliation_alerts;
create policy "Users can view alerts for their venues"
  on public.reconciliation_alerts for select
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

-- --- ingestion_log: owners only --------------------------------------------
--
-- Deliberately narrower than venue scoping, and venue_id is why: a row logged
-- against an UNKNOWN venue key has venue_id NULL, which is exactly the row a
-- venue-scoped policy would hide from everyone and exactly the row somebody
-- needs to see. Owner-only keeps the unmapped-key watchdog visible to the
-- people who fix it, and a manager has no use for a parse error.

alter table public.ingestion_log enable row level security;

drop policy if exists "Owners can view the ingestion log" on public.ingestion_log;
create policy "Owners can view the ingestion log"
  on public.ingestion_log for select
  using (
    exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

-- --- handle_new_user: a SECURITY DEFINER function anyone could call ---------
--
-- It runs as its owner, so it writes to public.profiles with privileges the
-- caller does not have. Two advisor warnings land on it together and they
-- compound: the search_path is mutable AND execute is granted to public. A
-- caller who can set search_path can make a definer function resolve `insert`
-- or a called function to something of their own -- the textbook Postgres
-- escalation, and it needs both halves to work.
--
-- SECURITY DEFINER is correct here and stays: the trigger must insert a
-- profile for a user who does not exist yet and has no rights of their own.
-- What changes is that the path is pinned and nobody can call it directly.
-- A trigger does not need EXECUTE granted to anyone.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;

-- --- the query RPCs: pin the path ------------------------------------------
--
-- Far less serious than the above: these are SECURITY INVOKER, so they already
-- run with the caller's rights and RLS applies to them normally. A mutable
-- search_path here cannot escalate anything. It is pinned because an unpinned
-- path is a latent hazard the day one of them is ever changed to DEFINER, and
-- because a security advisor with eight standing warnings is one nobody reads.

alter function public.guest_retention(date, date, int)        set search_path = public, pg_temp;
alter function public.guest_cohorts(text, int, date)          set search_path = public, pg_temp;
alter function public.booking_channel_months(date, date, int) set search_path = public, pg_temp;
alter function public.visit_distribution(date, date)          set search_path = public, pg_temp;

-- NOT CHANGED, and deliberately: public.xero_connections has RLS enabled with
-- no policy, which the advisor reports as information rather than a fault. That
-- table holds encrypted OAuth tokens, and "no policy" means it denies every
-- client outright while the service role still reads it. That is the correct
-- state for it. Adding a policy to clear the notice would be a regression.
