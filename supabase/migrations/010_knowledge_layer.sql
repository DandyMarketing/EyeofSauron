-- Knowledge layer: turn venue_notes into accumulated operator judgment.
--
-- venue_notes already exists in production but was created directly in
-- Supabase and never committed, so a fresh environment does not have it.
-- This migration adopts it into version control (create if not exists) and
-- adds the provenance a note needs to be trusted, taught from, and eventually
-- sold.
--
-- The distinction this table exists to protect: a figure comes from the
-- warehouse and is a fact; a note comes from a person and is judgment. Both
-- are useful, they are never the same kind of thing, and a junior reading an
-- answer has to be able to tell which is which.

create table if not exists public.venue_notes (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid references public.venues(id) on delete cascade,  -- null = applies to every venue
  note       text not null,
  category   text not null default 'general',
  created_at timestamptz not null default now()
);

-- Who taught it. An unattributed claim cannot be weighed or argued with, and
-- attribution is what makes an answer teach rather than just assert.
alter table public.venue_notes
  add column if not exists author_id uuid references auth.users(id) on delete set null;

-- Does this travel to another customer?
--   dandy_specific — "Firangi shuts Sundays". Must never leave this company.
--   universal      — "cocktail-led venues run higher bev cost". Sellable.
-- Defaults to dandy_specific: the safe direction, and existing rows are all
-- about these venues. Getting this field in now avoids untangling hundreds of
-- notes by hand at the multi-tenant phase.
alter table public.venue_notes
  add column if not exists portability text not null default 'dandy_specific'
    check (portability in ('dandy_specific', 'universal'));

-- How firmly it is held. A hypothesis and a rule should not read alike.
alter table public.venue_notes
  add column if not exists confidence text not null default 'observed'
    check (confidence in ('rule', 'observed', 'hypothesis'));

-- Review queue. Nothing reaches a prompt until a senior approves it.
-- Existing rows default to approved: they were hand-entered by an owner
-- through the admin screen, which was already an act of approval.
alter table public.venue_notes
  add column if not exists status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected', 'retired'));

-- Knowledge decays. "Terrace closed for renovation" is true for one quarter.
-- Null means it does not expire; a past date does not delete the note, it
-- marks it for re-confirmation (see formatNotes -- a silently vanishing fact
-- is worse than a visibly stale one).
alter table public.venue_notes
  add column if not exists review_by date;

-- Typed into admin, or captured from a conversation and awaiting review.
alter table public.venue_notes
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'captured'));

-- Retrieval always filters on status and venue, in that order.
create index if not exists venue_notes_status_venue_idx
  on public.venue_notes (status, venue_id);

-- RLS, consistent with the rest of the schema. The application reaches this
-- table with the service-role key, which bypasses RLS entirely -- so this is
-- defence in depth, NOT the isolation boundary. The boundary is
-- scopeNotes() in src/ai/knowledge.ts. See docs/BUILD_LOG.md 4.1.
alter table public.venue_notes enable row level security;

drop policy if exists "Users can view notes for their venues" on public.venue_notes;
create policy "Users can view notes for their venues"
  on public.venue_notes for select
  using (
    venue_id is null
    or venue_id in (
      select venue_id from public.user_venue_roles where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );
