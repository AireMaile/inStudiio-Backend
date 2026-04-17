create table public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text not null,
  stripe_customer_id text,
  created_at         timestamptz not null default now()
);

create table public.studios (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text unique not null,
  description       text,
  price_monthly     numeric not null default 9.99,
  stripe_product_id text not null,
  stripe_price_id   text not null,
  owner_user_id     uuid references public.profiles(id),
  created_at        timestamptz not null default now()
);

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  studio_id              uuid not null references public.studios(id) on delete cascade,
  stripe_subscription_id text unique not null,
  stripe_customer_id     text not null,
  status                 text not null check (status in ('active','past_due','canceled','incomplete')),
  current_period_start   timestamptz not null,
  current_period_end     timestamptz not null,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  unique (user_id, studio_id)
);

create index subscriptions_user_id_idx on public.subscriptions(user_id);
create index subscriptions_studio_id_idx on public.subscriptions(studio_id);

create table public.videos (
  id               uuid primary key default gen_random_uuid(),
  studio_id        uuid not null references public.studios(id) on delete cascade,
  title            text not null,
  description      text,
  cloudflare_uid   text not null,
  duration_seconds int,
  published_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index videos_studio_id_idx on public.videos(studio_id);
