-- Planning conversations are saved too, in the same tables as chats.
--
-- WHY. The event planner (/plan.html) kept its conversation in browser memory
-- only: a refresh, a closed tab or a phone call lost the whole argument, and a
-- plan is exactly the kind of thing that is worked on over several days.
-- Khai, 12 Oct 2026: "the plan also should have a history chat so they can
-- carry on the conversation and planning."
--
-- THE SAME TABLES, NOT NEW ONES. A planning thread needs everything migration
-- 050 already built: your own and only your own (RLS), a year's retention from
-- the last message, and the re-check on read that withholds a turn when the
-- reader's venues or role have changed since it was written. A second pair of
-- tables would be a second copy of all of that, and the copy is the one that
-- drifts.
--
-- `kind` keeps the two LISTS apart, nothing more: the chat page lists chats and
-- the planner lists plans. Existing rows are chats, which is what they are.

alter table public.conversations
  add column if not exists kind text not null default 'chat';

alter table public.conversations
  drop constraint if exists conversations_kind_check;
alter table public.conversations
  add constraint conversations_kind_check check (kind in ('chat', 'plan'));

comment on column public.conversations.kind is
  'Which page the thread belongs to: chat (/chat.html) or plan (/plan.html). '
  'Separates the two history lists; access rules are identical for both.';

-- The list query is "my threads of this kind, newest first".
create index if not exists conversations_user_kind_idx
  on public.conversations (user_id, kind, updated_at desc);
