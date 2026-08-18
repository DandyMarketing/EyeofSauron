-- How a post was DISTRIBUTED, which explains reach better than content does.
--
-- Found by probing what Graph actually exposes per media item on 18 Aug 2026,
-- rather than by designing against the documentation. Two fields we were not
-- asking for, both of which change how a breakout should be read.
--
-- media_product_type separates REELS from FEED. We stored media_type, which
-- says "VIDEO" for both a feed video and a reel -- and Instagram distributes
-- those completely differently. Every "do reels beat photos" answer so far has
-- been comparing two things stirred together.
--
-- collaborator_count is the one that could have produced a badly wrong finding.
-- A collab post appears on BOTH accounts and reaches both audiences, so it can
-- out-reach everything around it for a reason that has nothing to do with the
-- content. Without this, a classifier looking for what breakouts have in common
-- would happily conclude "cocktail reels go viral" when the truth was "we
-- posted it with an account that has two hundred thousand followers".

alter table public.social_posts
  add column if not exists media_product_type text,
  add column if not exists collaborator_count integer,
  add column if not exists children_count     integer;

comment on column public.social_posts.media_product_type is
  'REELS or FEED, from Graph. NOT the same as media_type, which reports VIDEO for both a feed video and a reel. Reels are distributed differently, so this is the right column for "do reels work" — media_type is not.';

comment on column public.social_posts.collaborator_count is
  'How many accounts a post was published WITH. Above zero means it reached the collaborator''s audience too, so its reach is not comparable to a solo post. Check this before attributing a breakout to the content. Null means not yet captured.';

comment on column public.social_posts.children_count is
  'Slides in a carousel. Null for single-media posts and for posts captured before this column existed.';

create index if not exists social_posts_product_type_idx
  on public.social_posts (venue_id, media_product_type, business_date desc);
