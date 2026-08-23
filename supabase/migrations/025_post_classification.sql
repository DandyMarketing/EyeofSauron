-- What each post is ABOUT, so performance can be explained rather than ranked.
--
-- Layer 1 is what a post IS -- media type, hashtags, caption length, posting
-- hour -- and it is already stored. It answers "reels beat images" and cannot
-- answer the question marketing actually has, which is what to post next.
--
-- Layer 2 is what a post is about: a dish, a drink, the room, the team. The
-- vocabulary has been defined in src/ai/post-taxonomy.ts since the taxonomy
-- conversation and nothing consumed it -- no columns, no classifier, no query
-- dimension. This is the missing half.
--
-- CATEGORY AND FLAGS ARE DIFFERENT SHAPES, deliberately. A post has exactly one
-- subject and any number of attributes. A trending-audio reel of a cocktail is
-- a Drink post wearing a trend format: making "trend" a tenth category would
-- delete it from the subject analysis and destroy the only question worth
-- asking -- whether trend formats beat straight ones with the subject held
-- constant.
--
-- THE MODEL AND THE DATE ARE STORED. A classification is a judgement made by a
-- particular model on a particular day, not a fact about the post. Without
-- those two columns a re-run with a better model is indistinguishable from the
-- old pass, and there is no way to compare them or to re-do only the weak ones.

alter table public.social_posts
  -- One of the nine keys in POST_CATEGORIES. Null means not yet classified,
  -- which is NOT the same as uncategorisable and must never be read as a group.
  add column if not exists category            text,
  -- The classifier's own confidence, 0-1. A post it found genuinely ambiguous
  -- should be visible as such rather than counted equally in an average.
  add column if not exists category_confidence numeric(3,2),

  -- Flags cut across categories. Null means unknown, false means judged absent
  -- -- the same distinction the collaborator_count fix had to learn.
  add column if not exists shows_people        boolean,
  add column if not exists has_call_to_action  boolean,
  add column if not exists is_repost           boolean,
  -- Marked LOW confidence in the taxonomy and it means it: trends live largely
  -- in audio, which the classifier cannot hear, and a trend that ran after the
  -- model's training cutoff cannot be recognised at all. A wrong yes is worse
  -- than a missed one, because the whole point is testing whether trend formats
  -- work.
  add column if not exists is_trend            boolean,

  -- Provenance of the judgement.
  add column if not exists classified_at       timestamptz,
  add column if not exists classifier_model    text,
  -- What the classifier saw. A caption-only pass and a caption+image pass are
  -- not comparable, and Dish vs Drink vs Room is mostly invisible in a caption.
  add column if not exists classified_from     text;

comment on column public.social_posts.category is
  'One of the nine POST_CATEGORIES keys. NULL means not yet classified — never treat it as a category or include it in a distribution.';

comment on column public.social_posts.is_trend is
  'LOW CONFIDENCE by design. Trends live in audio the classifier cannot hear. Report it as an indication, never as a count.';

comment on column public.social_posts.classified_from is
  'caption | caption+image. Not comparable across passes — subject is largely invisible in a caption alone.';

-- Partial index: the classifier job asks for unclassified posts every run, and
-- that is the only query that scans on this column.
create index if not exists social_posts_unclassified_idx
  on public.social_posts (venue_id, timestamp desc)
  where category is null;

create index if not exists social_posts_category_idx
  on public.social_posts (venue_id, category)
  where category is not null;
