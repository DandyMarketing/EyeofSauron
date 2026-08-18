-- The policies social_posts and social_accounts never got.
--
-- 014 enabled row-level security on social_accounts and 017 enabled it on
-- social_posts, and neither created a policy. In Postgres that is not "not
-- secured yet" -- it is DENY ALL. Every query made with a user's token returns
-- zero rows.
--
-- Nothing has broken because the only reader today is queryTopPosts, which uses
-- the service-role key and bypasses RLS entirely. The gap is waiting for the
-- Phase 2 dashboards, which will read with a user token, get an empty array,
-- and render "no posts" -- indistinguishable from a venue that posted nothing.
-- An empty result that means "denied" is the most expensive kind of bug this
-- warehouse can have, because it looks exactly like an answer.
--
-- The scoping matches social_daily's word for word. It is deliberately the same
-- venue rule as every other table, and it is deliberately NOT the real
-- boundary: enforceVenueScope() in application code is, because the service-role
-- key ignores all of this. This is defence in depth, not the defence.
--
-- Marketing is the known exception -- it needs social across every venue and
-- the owner/finance/manager/staff enum cannot express that. Unresolved, and
-- recorded in the role-model note in CLAUDE.md rather than guessed at here.

drop policy if exists "Users can view posts for their venues" on public.social_posts;
create policy "Users can view posts for their venues"
  on public.social_posts for select
  using (
    venue_id in (
      select venue_id from public.user_venue_roles where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );

-- Accounts carry no trade figures, but they carry the venue mapping, and a
-- reader who can see the mapping can see which handle belongs to which
-- business. Same rule, for consistency rather than for secrecy.
drop policy if exists "Users can view social accounts for their venues" on public.social_accounts;
create policy "Users can view social accounts for their venues"
  on public.social_accounts for select
  using (
    venue_id in (
      select venue_id from public.user_venue_roles where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );
