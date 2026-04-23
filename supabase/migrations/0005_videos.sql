-- Replace the legacy Cloudflare-based videos table (from 0001_schema.sql) with a
-- Mux-centric schema. CASCADE drops the old `videos_select_subscribed` policy
-- defined in 0003_rls.sql; we replace it with a permissive SELECT policy because
-- Plan 3 enforces read access at the route layer (service-role client bypasses RLS
-- anyway for writes).
drop table if exists public.videos cascade;

-- Videos belong to a studio and mirror Mux asset state.
-- updated_at is maintained by application code, not a trigger.
create table public.videos (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  title text not null,
  description text,
  status text not null check (status in ('waiting','preparing','ready','errored')) default 'waiting',
  mux_upload_id text,
  mux_asset_id text,
  mux_playback_id text,
  duration_seconds numeric,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index videos_studio_id_created_at_idx
  on public.videos (studio_id, created_at desc);

-- Writes go through the service-role client; RLS stays off for writes.
-- Enable row-level SELECT so the authenticated role could read directly later if needed.
alter table public.videos enable row level security;
create policy "videos_select_all" on public.videos for select using (true);
