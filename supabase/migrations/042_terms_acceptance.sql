-- Who agreed to what, and when.
--
-- WHY A TABLE AND NOT A FLAG ON THE USER. A boolean says somebody once agreed
-- to something. It cannot say WHICH wording, so the day the text changes every
-- existing true becomes a claim nobody can support -- a record that looks like
-- evidence and is not. One row per acceptance, carrying the version, means the
-- history survives a rewrite of the terms and re-acceptance is a new row rather
-- than an overwrite.
--
-- WHY AN EMAIL IS NOT ENOUGH. The invitation warns people, and a warning is not
-- an agreement. If this is ever needed -- a P&L forwarded outside the company, a
-- login shared with a supplier -- "we emailed them" is a much weaker position
-- than a row naming the person, the exact text in force, and the minute they
-- accepted it.
--
-- The gate this feeds is enforced SERVER-SIDE as well as in the browser. A
-- blocking screen is the experience; the check in /ask is the control. That is
-- the same split as the AI tool list against enforceDomainScope(): what we
-- offer is a hint, what we refuse is a boundary.

create table if not exists public.terms_acceptances (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  -- The exact wording agreed to. Matches TERMS_VERSION in src/auth/terms.ts,
  -- which is where the text itself lives so the two move together in one commit.
  terms_version text not null,

  accepted_at   timestamptz not null default now(),

  -- Weak corroboration, kept deliberately thin. Enough to distinguish an
  -- acceptance from a mis-click months later; not a behavioural log. Neither is
  -- relied on, and both may be null -- a proxy strips one and a scripted client
  -- omits the other.
  ip            text,
  user_agent    text,

  -- One acceptance per person per version. Re-reading the terms and pressing
  -- the button twice is not two agreements, and without this the second press
  -- would quietly rewrite the timestamp of the first.
  unique (user_id, terms_version)
);

create index if not exists idx_terms_acceptances_user
  on public.terms_acceptances (user_id);

comment on table public.terms_acceptances is
  'One row per person per version of the confidentiality terms. The text and '
  'its version live in src/auth/terms.ts; bump TERMS_VERSION and everyone is '
  'asked again.';

-- --- row-level security ------------------------------------------------------
--
-- The anon key is public by design, so RLS is the only barrier between it and a
-- table. Two tables once went a year without it (BUILD_LOG 4.4); this one
-- starts with it rather than relying on rls_audit() to find it later.

alter table public.terms_acceptances enable row level security;

-- A person may see their own acceptances. Needed so the browser can ask "have I
-- agreed to the current version" without the service role.
drop policy if exists "Users can view their own acceptances" on public.terms_acceptances;
create policy "Users can view their own acceptances"
  on public.terms_acceptances for select
  using (user_id = auth.uid());

-- Owners may see everyone's. This is the record you would actually need to
-- produce, and a record only its subject can read is not a record.
drop policy if exists "Owners can view all acceptances" on public.terms_acceptances;
create policy "Owners can view all acceptances"
  on public.terms_acceptances for select
  using (exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner'));

-- No insert, update or delete policy, deliberately. Acceptances are written by
-- the server with the service role after it has checked the session, so the
-- browser cannot forge one for somebody else, backdate it, or remove it. An
-- agreement a person can delete is not an agreement.
