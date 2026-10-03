-- Chat history: your own conversations, kept for a year, visible to nobody else.
--
-- WHY. Conversations lived in browser memory only: a refresh lost the thread,
-- and the last ten turns were re-sent with each question purely so the model
-- had context. Asking a good question twice because the first answer scrolled
-- away is the kind of friction that makes people stop asking.
--
-- THE HARD PART IS NOT STORAGE, IT IS THAT ACCESS CHANGES. A saved conversation
-- freezes a moment when somebody had a particular access. Finance asks about
-- labour cost, the chat is saved, their role becomes manager — and without a
-- re-check that stored chat goes on serving payroll figures the live path would
-- refuse. Same for venues: a manager who moves from Fat Prince to Neon Pigeon
-- would keep a readable chat full of Fat Prince's P&L.
--
-- Settled 3 Oct 2026 with Khai: RE-CHECK ON READ. Every message is re-tested
-- against the reader's CURRENT role and venues each time a conversation is
-- opened, by the same functions the live path uses. That is why
-- conversation_messages carries venue_slugs and domains — not as metadata, but
-- as the thing the check reads. See src/ai/conversation-scope.ts.
--
-- The alternatives were rejected: freezing what you could see when you asked
-- means access can never truly be revoked, and purging history on a role change
-- destroys work people need.

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),

  -- ON DELETE CASCADE, deliberately. deleteUser() already removes the auth
  -- user; without this their conversations would outlive the account with no
  -- way left to read or remove them.
  user_id uuid not null references auth.users(id) on delete cascade,

  /**
   * Written by the cheap model from the first question. Nullable because the
   * conversation exists the moment somebody asks something, and the title
   * arrives a second later — a row that cannot be written until a model answers
   * is a row that is lost when the model does not.
   */
  title text,

  created_at timestamptz not null default now(),

  /**
   * Bumped on every new message, and it is what retention measures.
   *
   * Not created_at: a thread somebody returns to for months is alive, and
   * deleting it on its first birthday would be deleting the most useful one
   * they have.
   */
  updated_at timestamptz not null default now()
);

comment on table public.conversations is
  'One chat thread, belonging to exactly one person. No owner or admin policy '
  'exists on purpose — reading somebody else''s conversation is not a mistake '
  'to avoid, it is a query the database refuses.';

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,

  role text not null check (role in ('user', 'assistant')),
  content text not null,

  /**
   * The rendered chart SVGs, exactly as the web app already receives them.
   *
   * Stored because a chart is most of why an answer is worth reopening, and
   * re-deriving one would mean re-running the queries against data that has
   * since moved — which would quietly change a historical answer.
   *
   * Withheld WITH the message when the re-check hides it: a chart is drawn from
   * the same figures as the prose, so withholding the sentence and publishing
   * the picture of it would be worse than doing neither.
   */
  charts jsonb,

  /**
   * WHAT THIS TURN READ. The whole re-check rests on these two columns.
   *
   * Derived from the tool calls the engine already records, so nothing extra is
   * tracked at write time. EMPTY IS NOT "EVERYTHING": a turn that ran no tools
   * read no venue data, and a row written before these columns existed records
   * nothing — both are treated as nothing to withhold, because the alternative
   * blanks every conversation that predates this migration.
   */
  venue_slugs text[] not null default '{}',
  domains     text[] not null default '{}',

  created_at timestamptz not null default now()
);

create index if not exists conversations_user_idx
  on public.conversations (user_id, updated_at desc);

create index if not exists conversation_messages_thread_idx
  on public.conversation_messages (conversation_id, created_at);

-- --- row-level security -----------------------------------------------------
--
-- YOUR OWN, AND ONLY YOUR OWN. There is deliberately no owner policy: Khai's
-- decision on 3 Oct 2026 was that an owner does not need to read other people's
-- chats, and writing that as an absent policy rather than as an application
-- rule means it cannot be got wrong later by a handler that forgets to check.
--
-- Usage reporting does not need one either — "how many questions has this
-- person asked, and when was the last" is a COUNT, and a count does not require
-- reading the contents.

alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;

drop policy if exists "Own conversations" on public.conversations;
create policy "Own conversations"
  on public.conversations for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/**
 * Messages are reached THROUGH the conversation, so one rule governs both.
 *
 * `with check` matters as much as `using` here: without it somebody could
 * insert a message into a thread that is not theirs, which is a way to write
 * into another person's history even while being unable to read it.
 */
drop policy if exists "Own conversation messages" on public.conversation_messages;
create policy "Own conversation messages"
  on public.conversation_messages for all
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_messages.conversation_id
        and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- --- retention --------------------------------------------------------------
--
-- A YEAR, measured from the last message rather than the first. Chats are
-- personal data and PDPA is on the Phase 4 list, so "keep forever" is a choice
-- nobody made rather than a default.
--
-- A FUNCTION, called by a scheduled script that REPORTS what it deleted. A
-- retention job running silently is indistinguishable from one that stopped,
-- which is the failure this codebase keeps finding — so the count comes back
-- rather than being discarded.
--
-- SECURITY DEFINER because the pruner runs as the service role on behalf of
-- nobody; search_path is pinned, since a security definer function without one
-- is the classic Postgres privilege-escalation shape.

create or replace function public.prune_old_conversations(older_than_days int default 365)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  removed int;
begin
  delete from public.conversations
  where updated_at < now() - (older_than_days || ' days')::interval;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.prune_old_conversations is
  'Deletes conversations whose last message is older than the retention window '
  '(default 365 days). Messages go with them by cascade. Returns the number '
  'removed, because a retention job nobody can see is one that may have '
  'stopped.';

revoke all on function public.prune_old_conversations(int) from public, anon, authenticated;
