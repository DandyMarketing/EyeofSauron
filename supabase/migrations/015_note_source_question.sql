-- What was asked when this was learned.
--
-- A note captured from a conversation is much harder to use six months later
-- without the question that produced it. "Food cost runs high in July" is
-- nearly useless on its own; "asked why July margin dropped -> durian season
-- pushes fruit cost up" is a fact someone can act on.
--
-- It is also the honest provenance: a note is one person's answer to one
-- question at one moment, not a standing truth, and showing the question makes
-- that visible rather than implied.
alter table public.venue_notes
  add column if not exists source_question text;

comment on column public.venue_notes.source_question is
  'The question being asked when this note was captured. Null for notes typed '
  'directly into the admin page, which have no originating question.';
