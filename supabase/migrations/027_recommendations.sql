-- Proactive advice: the thing this product is actually for.
--
-- Everything built so far is the plumbing that makes this possible. CLAUDE.md
-- is explicit that the analytics are table stakes and the RECOMMENDATIONS are
-- the product -- and until now the engine has only ever answered questions
-- somebody thought to ask. A venue leader who does not know to ask "why is my
-- beverage margin drifting" never finds out.
--
-- WHY THE EVIDENCE IS STORED WITH THE CONCLUSION. The anti-hallucination rule
-- says every figure comes from a query tool. In a chat the user sees the
-- reasoning as it happens; here nobody is watching. "Your food cost is four
-- points above the group" arriving unprompted on a Monday morning is
-- uncheckable unless the queries behind it came with it. A recommendation
-- without its evidence is a claim, and this system does not deal in claims.
--
-- WHY A RATING AND A STATUS, WHICH ARE NOT THE SAME THING. "I did it" and "this
-- was good advice" are different facts and both are needed: advice can be acted
-- on and turn out wrong, and good advice can be right and impractical this
-- month. Collapsing them into one column would make the only measure of whether
-- this feature works unreadable.
--
-- WHY THERE IS NO UNIQUE CONSTRAINT ON THE FINGERPRINT. It is derived from the
-- headline, so it is a DESCRIPTION of a row rather than its identity -- exactly
-- the shape that put 213 duplicate rows in profit_and_loss when a parser fix
-- changed the columns a unique key was built on. It is also legitimate for a
-- recommendation to recur: a problem that was fixed in March and came back in
-- September is a real finding, not a duplicate. Suppression is a decision the
-- generator makes against a recent window, not a constraint the database
-- enforces forever.

create table if not exists public.recommendations (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references public.venues(id) on delete cascade,

  -- One run produces up to a handful of recommendations for a venue. Grouped
  -- so a weak run can be judged, and dismissed, as a whole.
  run_id       uuid not null,

  -- The window the analysis actually covered. Without it "sales are down" has
  -- no referent, and two recommendations from different periods look
  -- contradictory when they are simply about different weeks.
  period_start date not null,
  period_end   date not null,

  -- One line: the thing to DO. Not the observation -- "move the Tuesday set
  -- menu to Wednesday", not "Tuesdays are quiet".
  headline     text not null,
  -- Markdown. The reasoning, the figures, and what would change if it worked.
  body         text not null,

  -- sales | marketing | cost | labour | covers | product | other.
  -- Deliberately NOT a check constraint: adding a domain would then need a
  -- migration, and the same judgement lives in code beside the prompt that
  -- produces it. Same choice as social_posts.category.
  domain       text not null,

  -- 0-1, and it must actually vary. A drop of forty covers on one Tuesday is
  -- not the same finding as a four-week margin trend, and an engine that
  -- presents both at full confidence teaches people to discount all of it.
  confidence   numeric(3,2),

  -- PROVENANCE. The tool calls and the figures they returned, verbatim.
  evidence     jsonb not null default '[]'::jsonb,
  -- SVG specs the engine drew while reasoning. The brief promises advice
  -- "backed by charts"; storing them is what makes that true rather than
  -- aspirational.
  charts       jsonb not null default '[]'::jsonb,

  -- A judgement made by a particular model on a particular day, not a fact.
  -- Same reasoning as social_posts.classifier_model: without these a re-run
  -- with a better model is indistinguishable from the old pass.
  generated_at timestamptz not null default now(),
  model        text not null,

  -- Normalised headline, for suppressing a repeat of something still open.
  -- A lookup key, never a constraint -- see the header.
  fingerprint  text not null,

  -- What happened to it.
  status       text not null default 'new',   -- new | acted_on | dismissed
  -- Whether it was any good. Independent of status, on purpose.
  rating       text,                          -- useful | not_useful | wrong
  feedback     text,
  rated_by     uuid references auth.users(id),
  rated_at     timestamptz,

  created_at   timestamptz not null default now()
);

comment on table public.recommendations is
  'Unprompted, per-venue advice with the evidence that produced it. Rows are a model judgement on a date, not facts — generated_at and model are part of the record.';

comment on column public.recommendations.headline is
  'The action, not the observation. "Move the Tuesday set menu", never "Tuesdays are quiet".';

comment on column public.recommendations.evidence is
  'The tool calls and figures behind the claim. A recommendation arriving unprompted is uncheckable without this.';

comment on column public.recommendations.fingerprint is
  'Normalised headline, used to suppress repeats of something still open. NEVER a unique key: a problem that returns months later is a real finding, and a derived column must not be part of an identity.';

comment on column public.recommendations.status is
  'new | acted_on | dismissed. Separate from rating: advice can be acted on and still turn out wrong.';

-- The panel's query: this venue, newest first, unresolved at the top.
create index if not exists recommendations_venue_idx
  on public.recommendations (venue_id, generated_at desc);

-- The generator's query: what did we already tell this venue recently.
create index if not exists recommendations_fingerprint_idx
  on public.recommendations (venue_id, fingerprint, generated_at desc);

alter table public.recommendations enable row level security;

-- Same WHO dimension as every other table: your venues, or everything if owner.
drop policy if exists "Users can view recommendations for their venues" on public.recommendations;
create policy "Users can view recommendations for their venues"
  on public.recommendations for select
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

-- Rating is the only thing a reader may change, and only for a venue they can
-- already see. The generator writes through the service role and bypasses this.
drop policy if exists "Users can rate recommendations for their venues" on public.recommendations;
create policy "Users can rate recommendations for their venues"
  on public.recommendations for update
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );
