-- What a post IS, so we can ask what kind of post works.
--
-- social_posts can already say which post won. It cannot say WHY, because
-- nothing on the row describes the post beyond its media type. These are the
-- features that need no judgement and no API call -- pure functions of the
-- caption and the timestamp, which means they can be recomputed for every post
-- ever stored without going near Meta.
--
-- That recomputability is the point. Derived data you can only produce at
-- ingest time is derived data you can never change your mind about, and the
-- first version of a definition is rarely the last.
--
-- What is deliberately NOT here is what the post is ABOUT -- a plate of food,
-- the room, a promotion. That needs judgement rather than a regular
-- expression, and the categories have to come from the people who know the
-- three brands rather than be invented in a migration.

alter table public.social_posts
  add column if not exists hashtags       text[] not null default '{}',
  add column if not exists mentions       text[] not null default '{}',
  add column if not exists caption_length integer,
  add column if not exists has_question   boolean,
  add column if not exists posted_hour    smallint;

-- Empty array rather than null, and it matters. A null here cannot be told
-- apart from a row that predates the column; an empty array says "we looked and
-- there were none". The three nullable columns above are null ONLY for rows not
-- yet recomputed, which is what the recompute script looks for.
comment on column public.social_posts.hashtags is
  'Lower-cased, de-duplicated hashtags from the caption. Lower-cased because Instagram treats #SundayRoast and #sundayroast as one tag -- keeping them apart would split one tag''s performance in two. Empty array means none; it is never null.';

comment on column public.social_posts.mentions is
  'Lower-cased, de-duplicated @-handles from the caption. Email addresses are excluded: the @ in one is not a mention.';

comment on column public.social_posts.posted_hour is
  'Hour of day in Singapore, 0-23. NOT the trading-day basis: business_date says which night a post belongs to, this says what time it went out. A 1am post is filed against the previous night and is still a 1am post -- both are true, and only this one answers "when should we post".';

comment on column public.social_posts.has_question is
  'Whether the caption asks the reader anything. A question mark, including the full-width form, is a crude proxy chosen because it cannot be wrong in a way that is hard to notice.';

-- GIN, because the question is "which posts carry this tag" -- array
-- containment, not equality. A btree index cannot answer it.
create index if not exists social_posts_hashtags_idx
  on public.social_posts using gin (hashtags);

-- Finds the rows a recompute has not reached yet. Partial, because once the
-- backfill has run this index is nearly empty and costs almost nothing.
create index if not exists social_posts_unfeatured_idx
  on public.social_posts (venue_id)
  where caption_length is null;
