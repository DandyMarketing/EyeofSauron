-- When somebody last USED Sauron, not when they last signed in.
--
-- WHY. 13 Oct 2026, Khai: "the last seen is not the actual last seen, I saw
-- Lukasz logged in today". "Last seen" came from Supabase Auth's
-- last_sign_in_at -- the last time a person typed a password or used a link.
-- A session lasts for weeks, so someone who opens Sauron every day on a phone
-- that stays signed in shows a sign-in from long ago. The admin page called
-- that "last seen", which it is not.
--
-- The server now stamps this column when a signed-in request arrives, at most
-- once every ten minutes per person, so it costs one small write per person
-- per ten minutes of use. The admin page shows the later of this and the last
-- sign-in. It starts counting from the deploy: activity before then was never
-- recorded anywhere.

alter table public.profiles add column if not exists last_active_at timestamptz;

comment on column public.profiles.last_active_at is
  'Last time this person used Sauron (any signed-in request), stamped at most '
  'every ten minutes. Not the last sign-in: a session lasts for weeks.';
