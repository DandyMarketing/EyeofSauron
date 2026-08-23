-- Is the food or drink being MADE, rather than shown finished?
--
-- Spotted by Khai looking at the first fifty classifications: a good number of
-- posts are the team presenting or building a dish -- a "making" video. Under
-- the taxonomy's own rule those are correctly category "dish", because the food
-- is the subject. But that means a plated shot and a chef building the same
-- plate are indistinguishable in the data, and they are completely different
-- content that almost certainly performs differently.
--
-- So it is a FLAG, not a category -- the same argument as is_trend. Format cuts
-- across subject. Making it a tenth category would remove those posts from the
-- subject analysis and destroy the only question worth asking: does a dish shown
-- being MADE beat a dish shown finished, with the subject held constant.
--
-- shows_people is a near-miss proxy and not the same thing: a guest eating a
-- finished plate shows people and no process.
--
-- ADDED NOW, AT FIFTY POSTS, deliberately. A taxonomy change costs whatever has
-- already been classified, and fifty is cheap where a thousand is not.

alter table public.social_posts
  add column if not exists shows_process boolean;

comment on column public.social_posts.shows_process is
  'Food or drink being made, plated, poured or presented by a person. A FLAG, not a category — a chef making a dish is category "dish" AND shows_process true. NULL means never judged, which is not the same as false.';

-- Posts classified before this flag existed have no judgement on it. Clearing
-- their category returns them to the queue: "not yet classified" is exactly
-- what they now are, because the taxonomy they were judged against no longer
-- exists.
--
-- Run this ONCE, after the column is added and the new build is deployed:
--
--   update public.social_posts
--   set category = null
--   where classified_at is not null and shows_process is null;
