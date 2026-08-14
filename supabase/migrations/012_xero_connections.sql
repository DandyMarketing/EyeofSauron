-- Xero connections: one row per Xero organisation Sauron can read.
--
-- A Xero "tenant" is one organisation, and organisations are LEGAL ENTITIES,
-- not trading names -- the org behind Neon Pigeon is called POTUS. So the
-- tenant-to-venue mapping can never be inferred from the name. It is confirmed
-- by a human, exactly like revel_venue_keys, and an unmapped tenant is flagged
-- rather than guessed. BUILD_LOG 2.2 is the entry that cost a day to this
-- class of assumption.
--
-- Tokens live here rather than in Railway sealed variables because they
-- rotate: the access token lasts ~30 minutes, and every refresh issues a NEW
-- refresh token and invalidates the old one. A store that cannot be written at
-- runtime cannot hold them. They are encrypted with XERO_TOKEN_KEY, which does
-- live in Railway -- the split the security model in CLAUDE.md describes.

create table if not exists public.xero_connections (
  id                      uuid primary key default gen_random_uuid(),

  -- Xero's tenantId for this organisation. The stable identifier; the name
  -- can be edited in Xero at any time.
  tenant_id               text not null unique,
  tenant_name             text,

  -- Null until a human confirms which venue this organisation belongs to.
  -- Nothing is ingested against an unmapped tenant.
  venue_id                uuid references public.venues(id) on delete set null,

  access_token_encrypted  text,
  refresh_token_encrypted text,
  -- When the ACCESS token expires (~30 min). The refresh token's own 60-day
  -- clock is tracked by last_refreshed_at.
  access_expires_at       timestamptz,

  status                  text not null default 'pending_mapping'
    check (status in ('pending_mapping', 'active', 'disconnected', 'error')),
  last_error              text,

  connected_at            timestamptz not null default now(),
  last_refreshed_at       timestamptz,
  updated_at              timestamptz not null default now()
);

create index if not exists xero_connections_venue_idx
  on public.xero_connections (venue_id);

comment on column public.xero_connections.venue_id is
  'Null means the organisation is connected but not yet mapped to a venue. '
  'Confirm by hand -- Xero organisation names are legal entities and do not '
  'match venue trading names.';

comment on column public.xero_connections.refresh_token_encrypted is
  'Rotates on every refresh. If a refresh succeeds and the new token is not '
  'stored, the connection is dead and must be re-authorised by a human -- so '
  'the store must be written before the new access token is used.';

-- RLS on, though the application reaches this with the service-role key and so
-- bypasses it. Defence in depth only; the boundary is in application code.
-- No SELECT policy is defined: nothing in the client should ever read tokens,
-- and an absent policy denies by default.
alter table public.xero_connections enable row level security;
