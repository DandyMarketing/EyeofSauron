-- Stories alongside posts.
--
-- Same shape -- one row, a timestamp, metrics as Meta names them -- so they
-- share a table rather than getting a near-identical second one. What separates
-- them is `content_type`, and it has to be separate because the two are NOT
-- comparable: a story goes only to people who already follow you, a post can
-- reach beyond them. Ranking them together would tell you posts always win, and
-- that would be an artefact of the audience, not a finding about the content.
--
-- The reason stories matter more than their numbers suggest: they EXPIRE after
-- about 24 hours, and their insights expire with them. There is no backfill and
-- there never will be. Every day nobody captures them is gone permanently --
-- the same problem as followers_count, but stories are where the daily specials
-- and the full-house shots go, which for a restaurant is the trading, not the
-- marketing.

alter table public.social_posts
  add column if not exists content_type text not null default 'post';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'social_posts_content_type_check'
  ) then
    alter table public.social_posts
      add constraint social_posts_content_type_check
      check (content_type in ('post', 'story'));
  end if;
end $$;

comment on column public.social_posts.content_type is
  'post or story. Kept apart because their reach is not comparable: a story reaches followers only. Never rank the two together.';

create index if not exists social_posts_type_date_idx
  on public.social_posts (venue_id, content_type, business_date desc);
