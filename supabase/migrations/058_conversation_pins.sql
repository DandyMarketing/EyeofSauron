-- 058: pin a plan or chat to the top of the left sidebar.
--
-- Khai, 13 Oct 2026: "the ability to PIN events on the left column". A pinned
-- conversation is listed first, above the recent ones, however long ago it was
-- last touched -- the sidebar otherwise shows only the newest fifty, so a plan
-- worked on once a month would fall off it. Saved in the database rather than
-- the browser so a pin is the same on a phone and a laptop.
--
-- pinned_at is when it was pinned (null = not pinned); pins are listed newest
-- pin first. Owner-only like rename and delete -- the server filters on
-- user_id. Additive only.

alter table public.conversations
  add column if not exists pinned_at timestamptz;

create index if not exists conversations_user_kind_pinned_idx
  on public.conversations (user_id, kind, pinned_at desc)
  where pinned_at is not null;

-- Check after running:
--   select column_name, data_type from information_schema.columns
--   where table_name = 'conversations' and column_name = 'pinned_at';
-- Expect one row: pinned_at, timestamp with time zone.
