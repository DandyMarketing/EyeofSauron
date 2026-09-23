-- The MOE school calendar, so the engine stops calling it a known gap.
--
-- WHY THIS EXISTS. CLAUDE.md records school terms as genuinely not held, and
-- instructs the engine to say they are missing rather than go and find them.
-- That was right while the only sources were holiday blogs -- the 7 Sep 2026
-- run had already spent eleven searches across seventy-eight pages on the
-- holiday and school calendar and cited none of them. It is not right any more:
-- the Ministry of Education publishes the calendar itself, machine-readable, at
-- moe.gov.sg/calendar. That makes it the SOURCE rather than a report of one,
-- the same standing MOM has for public holidays in migration 040.
--
-- WHY A RESTAURANT CARES. The June break is four weeks and the year-end one is
-- six; between them they take the family trade out of the room and move what is
-- left earlier in the evening. A week containing a term break is not comparable
-- to the week before it, and the briefing for Neon Pigeon on 22 Sep 2026 had to
-- end a section with "if you think a term break is in play, that one needs a
-- human check". This is that check.
--
-- PUBLIC HOLIDAYS ARE NOT INGESTED HERE, ON PURPOSE. MOE's feed carries them
-- and `public_holidays` already holds them from the body that gazettes them.
-- Taking both would give two figures for one fact, disagreeing at the edges --
-- the Monday-versus-Revel problem CLAUDE.md names, bought voluntarily. National
-- exams are left out too: MOE lists the 2026 O-Levels as 2 Jun to 10 Nov, a
-- five-month window that would mark almost every week as an exam week.

create table if not exists public.school_calendar (
  start_date date not null,
  -- A single-day event stores the same date twice rather than a null, so every
  -- query is one shape and an overlap test never has to special-case.
  end_date   date not null,

  -- The event without its level parenthetical: "Term 1", "Teachers' Day".
  name       text not null,

  -- MOE's own category, verbatim: 'School terms' or 'School holidays'.
  category   text not null,

  -- The parenthetical when there was one: 'MK, Primary & Secondary',
  -- 'Post-secondary'. MOE lists most breaks TWICE, once per level, usually on
  -- identical dates -- so anything counting days must count distinct dates and
  -- never sum the rows.
  --
  -- EMPTY STRING, NOT NULL, and only because it is part of the key: Postgres
  -- will not put a nullable column in a primary key, and a unique index over
  -- coalesce(level, '') cannot be named in a PostgREST upsert. '' means MOE
  -- stated no level -- Teachers' Day applies to everyone -- and the query tool
  -- drops the field rather than showing a blank.
  level      text not null default '',

  -- Provenance on the row, the shape CLAUDE.md specifies for any external fact.
  source     text not null default 'Ministry of Education',
  source_url text not null,

  -- 'fetched'      — read from moe.gov.sg/calendar by the ingest job.
  -- 'transcribed'  — typed in from a dated MOE press release for a year the
  --                  live calendar no longer serves. Kept distinct so nobody
  --                  has to guess which rows a human should re-check.
  origin     text not null default 'fetched'
             check (origin in ('fetched', 'transcribed')),

  fetched_at timestamptz not null default now(),

  -- Level is part of the key because the same break is published once per
  -- level on the same dates, and they are different rows about different
  -- populations. Keying without it would make the Post-secondary year-end
  -- break overwrite the MK/Primary one every run.
  primary key (start_date, name, level)
);

comment on table public.school_calendar is
  'MOE school terms and school holidays. Public holidays are deliberately NOT '
  'here — public_holidays holds those from MOM, the gazetting authority, and '
  'two sources for one fact is the failure this codebase keeps finding. Most '
  'breaks appear twice, once per education level, on identical dates: count '
  'DISTINCT DAYS, never the sum of rows.';

create index if not exists school_calendar_range_idx
  on public.school_calendar (start_date, end_date);

-- --- row-level security -----------------------------------------------------
--
-- Public information with no venue and no money in it, so every signed-in user
-- may read it. It still gets a policy, because the anon key is public by design
-- and rls_audit() would otherwise report this table as a fault every day.

alter table public.school_calendar enable row level security;

drop policy if exists "Signed-in users can read the school calendar" on public.school_calendar;
create policy "Signed-in users can read the school calendar"
  on public.school_calendar for select
  using (auth.uid() is not null);

-- --- back years -------------------------------------------------------------
--
-- SEEDING PAST YEARS IS SAFE AND SEEDING FUTURE ONES IS NOT, which is the whole
-- reason these are rows in a migration while everything from 2026 on comes from
-- a job. ingest-holidays.ts argues against seeds because a calendar gazetted a
-- year ahead goes stale on a schedule; 2024 and 2025 are finished and cannot
-- change. They are here because moe.gov.sg/calendar only ever server-renders
-- the CURRENT year -- 2025 is already gone from it -- so without this the
-- warehouse could never answer a year-on-year question.
--
-- Transcribed from the dated press releases named on each row, which carry the
-- term and vacation tables in prose. They are typed rather than parsed: those
-- tables put footnote markers against the dates ("Fri 19 Nov 2"), and a parser
-- reading that as a date would be wrong in a way nobody would see.
--
-- They cross-check: every vacation begins the day after a term ends, in both
-- years, and there is a test asserting exactly that.
--
-- MARKED origin = 'transcribed'. Khai should eyeball them once against the two
-- press releases; they are the only rows in this table no machine has read.

insert into public.school_calendar
  (start_date, end_date, name, category, level, source_url, origin)
values
  -- ---- 2024 — https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024
  ('2024-01-02', '2024-03-08', 'Term 1', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-03-18', '2024-05-24', 'Term 2', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-06-24', '2024-08-30', 'Term 3', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-09-09', '2024-11-15', 'Term 4', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),

  ('2024-03-09', '2024-03-17', 'Term 1 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-05-25', '2024-06-23', 'Term 2 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-08-31', '2024-09-08', 'Term 3 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-11-16', '2024-12-31', 'Term 4 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),

  -- Post-secondary differs from the school year ONLY at the end of it. The
  -- three mid-year breaks are the same dates and are not repeated here.
  ('2024-11-23', '2024-12-31', 'Term 4 school holidays', 'School holidays', 'Post-secondary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),

  -- Youth Day fell on a Sunday, so the Monday after is the day off. Stored as
  -- two rows, matching how the live feed publishes it, because for a restaurant
  -- the Monday is the one that moves covers.
  ('2024-06-30', '2024-06-30', 'Youth Day', 'School holidays', '', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-07-01', '2024-07-01', 'School Holiday for Youth Day', 'School holidays', '', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-08-30', '2024-08-30', 'Teachers'' Day', 'School holidays', '', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),
  ('2024-10-04', '2024-10-04', 'Children''s Day', 'School holidays', 'MK, Primary', 'https://www.moe.gov.sg/news/press-releases/20230807-school-terms-and-holidays-for-2024', 'transcribed'),

  -- ---- 2025 — https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025
  ('2025-01-02', '2025-03-14', 'Term 1', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-03-24', '2025-05-30', 'Term 2', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-06-30', '2025-09-05', 'Term 3', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-09-15', '2025-11-21', 'Term 4', 'School terms', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),

  ('2025-03-15', '2025-03-23', 'Term 1 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-05-31', '2025-06-29', 'Term 2 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-09-06', '2025-09-14', 'Term 3 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-11-22', '2025-12-31', 'Term 4 school holidays', 'School holidays', 'MK, Primary & Secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),

  ('2025-11-29', '2025-12-31', 'Term 4 school holidays', 'School holidays', 'Post-secondary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),

  ('2025-07-06', '2025-07-06', 'Youth Day', 'School holidays', '', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-07-07', '2025-07-07', 'School Holiday for Youth Day', 'School holidays', '', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-09-05', '2025-09-05', 'Teachers'' Day', 'School holidays', '', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed'),
  ('2025-10-03', '2025-10-03', 'Children''s Day', 'School holidays', 'MK, Primary', 'https://www.moe.gov.sg/news/press-releases/20240812-school-terms-and-holidays-for-2025', 'transcribed')
on conflict (start_date, name, level) do nothing;
