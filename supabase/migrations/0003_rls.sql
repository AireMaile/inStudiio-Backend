-- RLS policies below are SELECT-only by design. All writes in Plan 1/2/3 go
-- through the Express API using the service-role key (which bypasses RLS).
-- When/if authenticated writes are introduced (e.g., mobile app talking to
-- Supabase directly with the anon key), add matching INSERT/UPDATE policies
-- here — see the owner/RBAC design spec for the owner-scoped write policies
-- to add (studios_update_own, etc.).

alter table public.profiles       enable row level security;
alter table public.studios        enable row level security;
alter table public.subscriptions  enable row level security;
alter table public.videos         enable row level security;

-- profiles: user can read only their own
create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

-- studios: everyone can read (public catalog)
create policy "studios_select_all"
  on public.studios for select
  using (true);

-- subscriptions: user can read only their own
create policy "subscriptions_select_own"
  on public.subscriptions for select
  using (user_id = auth.uid());

-- videos: user can read only if they have an active sub to the studio
create policy "videos_select_subscribed"
  on public.videos for select
  using (
    exists (
      select 1
      from public.subscriptions s
      where s.user_id = auth.uid()
        and s.studio_id = public.videos.studio_id
        and s.status = 'active'
        and s.current_period_end > now()
    )
  );
