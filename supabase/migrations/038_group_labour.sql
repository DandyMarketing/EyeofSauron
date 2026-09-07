-- Group staff belong to no venue, and are stored that way rather than split.
--
-- The Dandy Collection is a StaffAny SECTION like any other, and the people in
-- it -- group operations, finance, the interns -- work across all three venues.
-- Their salaries already reach the venues through Xero, because CLAUDE.md
-- records that the umbrella has no P&L and genuinely shared costs are split
-- across venues where necessary. Finance has therefore already chosen a basis
-- for that split.
--
-- WHY THE WAREHOUSE DOES NOT SPLIT THEM. An allocation is a JUDGEMENT and
-- these hours are a MEASUREMENT, and storing the first as though it were the
-- second is the failure this codebase keeps finding. The basis will also
-- change: baked into the rows, changing it means rewriting history; stored
-- unallocated, it can be applied at query time and revised freely. And a second
-- split of the same five salaries, ours beside Finance's, is two figures for
-- one cost -- the Monday-versus-Revel problem bought voluntarily.
--
-- It is also the group-fee argument from CLAUDE.md in a second place. For "is
-- this venue a good business" group cost belongs in the venue. For "is the
-- manager running it well" it is a cost nobody on that floor controls, and
-- charging it against their labour percentage reports arithmetic as
-- performance. Two honest numbers, named apart: VENUE LABOUR is the venue's own
-- sections, FULLY LOADED LABOUR adds a share of group.
--
-- MEASURED 7 Sep 2026: zero hours were recorded against The Dandy Collection
-- section for the probed week -- both the shift and work-hour breakdowns list
-- six sections and not this one. So this is currently a schema that permits a
-- row rather than a row that exists, and that absence is itself a finding: the
-- group's salaried staff are in the Xero wages line and not in StaffAny, which
-- is part of why rostered labour cost will sit below total employment cost.

alter table public.labour_daily
  alter column venue_id drop not null;

comment on column public.labour_daily.venue_id is
  'NULL means group staff, belonging to no single venue. Never allocated here — '
  'the split is a judgement and belongs at query time, mirroring the basis '
  'Finance already uses in Xero.';

-- --- who may see a row that belongs to no venue -----------------------------
--
-- Owner only, and for the reason migration 034 gives for ingestion_log: a
-- venue-scoped policy hides a NULL-venue row from EVERYONE, including the
-- people who need it. A restaurant manager also has no use for the group
-- operations manager's hours, and the WHAT dimension of the security model says
-- function decides need rather than seniority.
--
-- The existing venue policy is left exactly as it is. It already evaluates to
-- false for a NULL venue_id, so the two do not overlap and a venue manager
-- gains nothing.

drop policy if exists "Owners can view group labour" on public.labour_daily;
create policy "Owners can view group labour"
  on public.labour_daily for select
  using (
    venue_id is null
    and exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

-- --- the mapping must be able to say "group, and no venue" ------------------
--
-- A section is CONFIRMED when somebody has decided what it is. For a venue
-- section that means a venue and an area; for the group section it means area
-- GROUP and deliberately no venue. Without this the group section can never
-- leave the unmapped list, and an unmapped section is never ingested -- so the
-- one section we have decided about would look like the one nobody had touched.

alter table public.staffany_sections
  add constraint staffany_sections_group_has_no_venue
  check (area is distinct from 'GROUP' or venue_id is null);

comment on column public.staffany_sections.area is
  'BOH, FOH or GROUP. GROUP carries no venue_id: those hours are worked across '
  'every venue and are never allocated to one in the warehouse.';
