-- When somebody last opened the weekly brief, so the menu can say what is new.
--
-- WHY. 13 Oct 2026, Khai: "the weekly brief ... no one actually knows it's
-- there." No menu linked to it; the only way in was a link inside a collapsed
-- card on the dashboard. The fix is a "Weekly brief" link in every menu with a
-- badge counting what this person has not opened yet -- and "not opened" has
-- to follow the PERSON across phone and laptop, so it is stored here rather
-- than in one browser.
--
-- Stamped when they open the brief page. The badge counts the latest week's
-- recommendations they are allowed to see that were written after this time.
-- Null means never opened: everything in the latest week counts as new.

alter table public.profiles add column if not exists brief_seen_at timestamptz;

comment on column public.profiles.brief_seen_at is
  'Last time this person opened the weekly brief. The menu badge counts the '
  'latest week''s recommendations written after it.';
