-- Individual posts and how they performed.
--
-- social_daily answers "how did the account do on Tuesday". This answers "which
-- post worked", which is the question marketing actually asks, and it is a
-- different shape: one row per post, not a value per day.

create table if not exists public.social_posts (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references public.venues(id) on delete cascade,
  platform      text not null,
  account_id    text not null,
  -- The platform's own id. Captions get edited and permalinks can change form;
  -- the id does not.
  post_id       text not null,

  -- Exactly when it went out, kept raw. Every derived date can be recomputed
  -- from this, and none of them can be recovered if it is thrown away.
  published_at  timestamptz not null,

  -- The trading day it belongs to, on the SAME basis as sales: a Singapore day
  -- that starts at 3am, matching Revel's business date. A post at 1am Sunday
  -- belongs to Saturday night's service, because that is when the room it was
  -- posted from was full. Joining social to trade on any other basis would put
  -- the late-night posts against the wrong night.
  business_date date not null,

  media_type    text,
  permalink     text,
  caption       text,

  -- Metrics as Meta named them, sparse by design.
  --
  -- Long-and-narrow was right for social_daily and is wrong here: a reel
  -- carries metrics an image does not, so a column per metric would be mostly
  -- nulls and would need a migration every time Meta renames one -- and it
  -- renames them (impressions became views). A JSON object absorbs both the
  -- sparseness and the churn, and keeps the platform's own names so a figure
  -- can always be traced back.
  metrics       jsonb not null default '{}'::jsonb,

  -- Engagement accrues for days after publishing, so a post is re-read while it
  -- is still young. This says how fresh the numbers are.
  fetched_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  unique (platform, post_id)
);

comment on column public.social_posts.business_date is
  'Trading day on the same 3am-to-3am Singapore basis as Revel, so posts join to sales correctly. Derived from published_at; recompute rather than trust if the venue basis ever changes.';

comment on column public.social_posts.metrics is
  'Per-post metrics keyed by Meta''s own metric names. Sparse: a reel carries keys an image does not. Absent is not zero -- it means the platform does not report that metric for that media type.';

create index if not exists social_posts_venue_date_idx
  on public.social_posts (venue_id, business_date desc);

create index if not exists social_posts_published_idx
  on public.social_posts (venue_id, published_at desc);

alter table public.social_posts enable row level security;
