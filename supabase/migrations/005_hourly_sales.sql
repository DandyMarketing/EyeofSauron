create table public.hourly_sales (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references public.venues(id),
  business_date   date not null,
  hour            smallint not null check (hour >= 0 and hour <= 23),
  time_label      text not null,
  transactions    integer not null default 0,
  items           integer not null default 0,
  avg_check       numeric(10,2),
  sales           numeric(12,2) not null default 0,
  pct_sales       numeric(5,2) not null default 0,
  meal_period     text not null check (meal_period in ('lunch', 'brunch', 'dinner')),
  created_at      timestamptz not null default now(),

  unique (venue_id, business_date, hour)
);

create index idx_hourly_sales_venue_date on public.hourly_sales(venue_id, business_date);
create index idx_hourly_sales_meal_period on public.hourly_sales(venue_id, business_date, meal_period);

alter table public.hourly_sales enable row level security;

create policy "venue_access" on public.hourly_sales
  for select using (
    venue_id in (
      select venue_id from public.user_venue_roles
      where user_id = auth.uid()
    )
  );
