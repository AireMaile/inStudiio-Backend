-- Durable reconciliation for Mux ready events that do not contain a usable
-- playback ID. Webhooks atomically ledger + enqueue; a separately scheduled
-- worker claims rows with leases and submits fenced outcomes through RPCs.

create table public.mux_playback_reconciliations (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  mux_asset_id text not null check (btrim(mux_asset_id) <> ''),
  source_event_id text,
  state text not null default 'pending'
    check (state in ('pending', 'leased', 'succeeded', 'failed', 'blocked', 'obsolete')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  infra_attempt_count integer not null default 0 check (infra_attempt_count >= 0),
  not_found_attempt_count integer not null default 0 check (not_found_attempt_count >= 0),
  reopen_count integer not null default 0 check (reopen_count >= 0),
  next_attempt_at timestamptz default pg_catalog.now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_class text
    check (
      last_error_class is null
      or last_error_class in (
        'content_preparing',
        'content_missing_playback',
        'not_found',
        'infrastructure',
        'mux_errored',
        'integrity'
      )
    ),
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  finished_at timestamptz,
  unique (video_id, mux_asset_id),
  constraint mux_playback_reconciliations_counter_check
    check (
      infra_attempt_count <= attempt_count
      and not_found_attempt_count <= attempt_count
    ),
  constraint mux_playback_reconciliations_lifecycle_check
    check (
      (
        state = 'pending'
        and next_attempt_at is not null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is null
      )
      or (
        state = 'leased'
        and next_attempt_at is null
        and lease_token is not null
        and lease_expires_at is not null
        and finished_at is null
      )
      or (
        state in ('succeeded', 'failed', 'blocked', 'obsolete')
        and next_attempt_at is null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is not null
      )
    )
);

create index mux_playback_reconciliations_due_idx
  on public.mux_playback_reconciliations (next_attempt_at, created_at)
  where state = 'pending';

create index mux_playback_reconciliations_expired_lease_idx
  on public.mux_playback_reconciliations (lease_expires_at, created_at)
  where state = 'leased';

alter table public.mux_playback_reconciliations enable row level security;

revoke all on table public.mux_playback_reconciliations from public, anon, authenticated;
grant select, insert, update, delete on table public.mux_playback_reconciliations to service_role;

-- Atomically record an anomalous signed ready event and create/reopen exactly
-- one reconciliation workflow for its video + asset pair.
create function public.queue_mux_playback_reconciliation_event(
  p_event_id text,
  p_event_type text,
  p_video_id uuid,
  p_mux_asset_id text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted_rows integer;
  video_row public.videos%rowtype;
begin
  if p_event_id is null or pg_catalog.btrim(p_event_id) = '' then
    raise exception 'event id is required' using errcode = '22023';
  end if;
  if p_event_type is null or pg_catalog.btrim(p_event_type) = '' then
    raise exception 'event type is required' using errcode = '22023';
  end if;
  if p_video_id is null then
    raise exception 'video id is required' using errcode = '22023';
  end if;
  if p_mux_asset_id is null or pg_catalog.btrim(p_mux_asset_id) = '' then
    raise exception 'Mux asset id is required' using errcode = '22023';
  end if;

  insert into public.mux_webhook_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;

  get diagnostics inserted_rows = row_count;
  if inserted_rows = 0 then
    return 'duplicate';
  end if;

  -- Lock-order note: enqueue locks video then workflow, while finish/requeue
  -- lock workflow then video. A same-pair collision can therefore deadlock.
  -- PostgreSQL aborts one transaction (40P01); callers deliberately retry via
  -- Mux redelivery or lease expiry, so do not catch/suppress that exception.
  select *
  into video_row
  from public.videos
  where id = p_video_id
  for update;

  if not found then
    return 'no_video';
  end if;

  if video_row.mux_asset_id is not null
     and video_row.mux_asset_id <> p_mux_asset_id then
    -- The route will return 500. Remove only the row inserted by this call so
    -- the sender can retry and the mismatch cannot become a false duplicate.
    delete from public.mux_webhook_events where event_id = p_event_id;
    return 'asset_mismatch';
  end if;

  if video_row.status = 'ready'
     and video_row.mux_playback_id is not null
     and video_row.mux_playback_policy is not null then
    if video_row.mux_asset_id is null then
      update public.videos
      set mux_asset_id = p_mux_asset_id,
          updated_at = pg_catalog.now()
      where id = p_video_id;
    end if;
    return 'already_resolved';
  end if;

  update public.videos
  set mux_asset_id = p_mux_asset_id,
      status = 'preparing',
      updated_at = pg_catalog.now()
  where id = p_video_id;

  insert into public.mux_playback_reconciliations as existing (
    video_id,
    mux_asset_id,
    source_event_id
  )
  values (
    p_video_id,
    p_mux_asset_id,
    p_event_id
  )
  on conflict (video_id, mux_asset_id) do update
  set
    state = case
      when existing.state in ('pending', 'leased') then existing.state
      else 'pending'
    end,
    source_event_id = case
      when existing.state in ('pending', 'leased') then existing.source_event_id
      else excluded.source_event_id
    end,
    infra_attempt_count = case
      when existing.state in ('pending', 'leased') then existing.infra_attempt_count
      else 0
    end,
    not_found_attempt_count = case
      when existing.state in ('pending', 'leased') then existing.not_found_attempt_count
      else 0
    end,
    reopen_count = case
      when existing.state in ('pending', 'leased') then existing.reopen_count
      else existing.reopen_count + 1
    end,
    next_attempt_at = case
      when existing.state in ('pending', 'leased') then existing.next_attempt_at
      else pg_catalog.now()
    end,
    lease_token = case
      when existing.state in ('pending', 'leased') then existing.lease_token
      else null
    end,
    lease_expires_at = case
      when existing.state in ('pending', 'leased') then existing.lease_expires_at
      else null
    end,
    last_error_class = case
      when existing.state in ('pending', 'leased') then existing.last_error_class
      else null
    end,
    last_error_code = case
      when existing.state in ('pending', 'leased') then existing.last_error_code
      else null
    end,
    last_error_message = case
      when existing.state in ('pending', 'leased') then existing.last_error_message
      else null
    end,
    updated_at = case
      when existing.state in ('pending', 'leased') then existing.updated_at
      else pg_catalog.now()
    end,
    finished_at = case
      when existing.state in ('pending', 'leased') then existing.finished_at
      else null
    end;

  return 'queued';
end;
$$;

-- Claim due rows atomically. Before claiming, converge active jobs that the
-- database already proves are resolved or obsolete, avoiding needless Mux
-- reads and false blocked incidents after another event repaired the video.
create function public.claim_mux_playback_reconciliations(
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns table (
  job_id uuid,
  video_id uuid,
  mux_asset_id text,
  attempt_count integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'claim limit must be between 1 and 50' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 15 and 300' using errcode = '22023';
  end if;

  update public.mux_playback_reconciliations as reconciliation
  set
    state = case
      when video.status = 'ready'
       and video.mux_asset_id = reconciliation.mux_asset_id
       and video.mux_playback_id is not null
       and video.mux_playback_policy is not null
      then 'succeeded'
      else 'obsolete'
    end,
    next_attempt_at = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = pg_catalog.now(),
    finished_at = pg_catalog.now()
  from public.videos as video
  where reconciliation.video_id = video.id
    and (
      reconciliation.state = 'pending'
      or (
        reconciliation.state = 'leased'
        and reconciliation.lease_expires_at <= pg_catalog.now()
      )
    )
    and (
      (
        video.status = 'ready'
        and video.mux_asset_id = reconciliation.mux_asset_id
        and video.mux_playback_id is not null
        and video.mux_playback_policy is not null
      )
      or (
        video.mux_asset_id is not null
        and video.mux_asset_id <> reconciliation.mux_asset_id
      )
    );

  return query
  with candidates as (
    select reconciliation.id
    from public.mux_playback_reconciliations as reconciliation
    where (
      reconciliation.state = 'pending'
      and reconciliation.next_attempt_at <= pg_catalog.now()
    ) or (
      reconciliation.state = 'leased'
      and reconciliation.lease_expires_at <= pg_catalog.now()
    )
    order by
      coalesce(reconciliation.next_attempt_at, reconciliation.lease_expires_at),
      reconciliation.created_at,
      reconciliation.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.mux_playback_reconciliations as reconciliation
    set
      state = 'leased',
      attempt_count = reconciliation.attempt_count + 1,
      next_attempt_at = null,
      lease_token = gen_random_uuid(),
      lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.now(),
      finished_at = null
    from candidates
    where reconciliation.id = candidates.id
    returning reconciliation.*
  )
  select
    claimed.id,
    claimed.video_id,
    claimed.mux_asset_id,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.lease_expires_at
  from claimed;
end;
$$;

-- Submit one authoritative observation. The lease token fences stale workers;
-- retry timing and terminal classification are owned by PostgreSQL.
create function public.finish_mux_playback_reconciliation(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_playback_id text default null,
  p_playback_policy text default null,
  p_duration_seconds numeric default null,
  p_error_code text default null,
  p_error_message text default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.mux_playback_reconciliations%rowtype;
  video public.videos%rowtype;
  workflow_age interval;
  retry_delay interval;
  new_infra_attempt_count integer;
  new_not_found_attempt_count integer;
  terminal_message text;
begin
  if p_outcome is null or p_outcome not in (
    'succeeded',
    'content_preparing',
    'content_missing_playback',
    'not_found',
    'infrastructure',
    'mux_errored',
    'integrity'
  ) then
    raise exception 'unknown reconciliation outcome' using errcode = '22023';
  end if;

  select *
  into job
  from public.mux_playback_reconciliations
  where id = p_job_id
  for update;

  if not found then
    return 'no_job';
  end if;
  if job.state <> 'leased' or job.lease_token is distinct from p_lease_token then
    return 'stale_lease';
  end if;

  select *
  into video
  from public.videos
  where id = job.video_id
  for update;

  if not found then
    -- Normally ON DELETE CASCADE removes the job. This branch covers a
    -- concurrent/manual integrity edge without applying a stale result.
    update public.mux_playback_reconciliations
    set state = 'obsolete', next_attempt_at = null, lease_token = null,
        lease_expires_at = null, updated_at = pg_catalog.now(),
        finished_at = pg_catalog.now()
    where id = job.id;
    return 'obsolete';
  end if;

  if video.mux_asset_id is not null and video.mux_asset_id <> job.mux_asset_id then
    update public.mux_playback_reconciliations
    set state = 'obsolete', next_attempt_at = null, lease_token = null,
        lease_expires_at = null, updated_at = pg_catalog.now(),
        finished_at = pg_catalog.now()
    where id = job.id;
    return 'obsolete';
  end if;

  if video.status = 'ready'
     and video.mux_asset_id = job.mux_asset_id
     and video.mux_playback_id is not null
     and video.mux_playback_policy is not null then
    update public.mux_playback_reconciliations
    set state = 'succeeded', next_attempt_at = null, lease_token = null,
        lease_expires_at = null, updated_at = pg_catalog.now(),
        finished_at = pg_catalog.now()
    where id = job.id;
    return 'already_resolved';
  end if;

  if p_outcome = 'succeeded' then
    if p_playback_id is null or pg_catalog.btrim(p_playback_id) = '' then
      raise exception 'successful reconciliation requires a playback id' using errcode = '22023';
    end if;
    if p_playback_policy is null or p_playback_policy not in ('signed', 'public') then
      raise exception 'successful reconciliation requires a supported playback policy'
        using errcode = '22023';
    end if;

    update public.videos
    set status = 'ready',
        mux_asset_id = job.mux_asset_id,
        mux_playback_id = p_playback_id,
        mux_playback_policy = p_playback_policy,
        duration_seconds = p_duration_seconds,
        error_message = null,
        updated_at = pg_catalog.now()
    where id = job.video_id;

    update public.mux_playback_reconciliations
    set state = 'succeeded', next_attempt_at = null, lease_token = null,
        lease_expires_at = null, last_error_class = null,
        last_error_code = null, last_error_message = null,
        updated_at = pg_catalog.now(), finished_at = pg_catalog.now()
    where id = job.id;
    return 'succeeded';
  end if;

  workflow_age := pg_catalog.now() - job.created_at;

  if p_outcome in ('content_preparing', 'content_missing_playback') then
    if (p_outcome = 'content_missing_playback' and workflow_age >= interval '24 hours')
       or (p_outcome = 'content_preparing' and workflow_age >= interval '72 hours') then
      terminal_message := coalesce(
        p_error_message,
        case
          when p_outcome = 'content_missing_playback'
            then 'Mux asset is ready but has no supported playback ID'
          else 'Mux asset did not finish preparing within 72 hours'
        end
      );
      update public.videos
      set status = 'errored', error_message = terminal_message,
          updated_at = pg_catalog.now()
      where id = job.video_id;
      update public.mux_playback_reconciliations
      set state = 'failed', infra_attempt_count = 0,
          not_found_attempt_count = 0,
          next_attempt_at = null, lease_token = null, lease_expires_at = null,
          last_error_class = p_outcome,
          last_error_code = p_error_code,
          last_error_message = terminal_message,
          updated_at = pg_catalog.now(), finished_at = pg_catalog.now()
      where id = job.id;
      return 'failed';
    end if;

    retry_delay := case
      when workflow_age < interval '5 minutes' then interval '1 minute'
      when workflow_age < interval '20 minutes' then interval '5 minutes'
      when workflow_age < interval '1 hour' then interval '15 minutes'
      when workflow_age < interval '6 hours' then interval '1 hour'
      when workflow_age < interval '24 hours' then interval '3 hours'
      when workflow_age < interval '48 hours' then interval '6 hours'
      else interval '12 hours'
    end;
    update public.mux_playback_reconciliations
    set state = 'pending', infra_attempt_count = 0,
        not_found_attempt_count = 0,
        next_attempt_at = pg_catalog.now() + retry_delay,
        lease_token = null, lease_expires_at = null,
        last_error_class = p_outcome,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        updated_at = pg_catalog.now(), finished_at = null
    where id = job.id;
    return 'retry_scheduled';
  end if;

  if p_outcome = 'not_found' then
    new_not_found_attempt_count := job.not_found_attempt_count + 1;
    if new_not_found_attempt_count >= 3 then
      terminal_message := coalesce(p_error_message, 'Mux asset was not found');
      update public.videos
      set status = 'errored', error_message = terminal_message,
          updated_at = pg_catalog.now()
      where id = job.video_id;
      update public.mux_playback_reconciliations
      set state = 'failed', infra_attempt_count = 0,
          not_found_attempt_count = new_not_found_attempt_count,
          next_attempt_at = null, lease_token = null, lease_expires_at = null,
          last_error_class = 'not_found', last_error_code = p_error_code,
          last_error_message = terminal_message,
          updated_at = pg_catalog.now(), finished_at = pg_catalog.now()
      where id = job.id;
      return 'failed';
    end if;

    retry_delay := case new_not_found_attempt_count
      when 1 then interval '1 minute'
      else interval '5 minutes'
    end;
    update public.mux_playback_reconciliations
    set state = 'pending', infra_attempt_count = 0,
        not_found_attempt_count = new_not_found_attempt_count,
        next_attempt_at = pg_catalog.now() + retry_delay,
        lease_token = null, lease_expires_at = null,
        last_error_class = 'not_found', last_error_code = p_error_code,
        last_error_message = p_error_message,
        updated_at = pg_catalog.now(), finished_at = null
    where id = job.id;
    return 'retry_scheduled';
  end if;

  if p_outcome = 'infrastructure' then
    new_infra_attempt_count := job.infra_attempt_count + 1;
    if new_infra_attempt_count > 8 then
      update public.mux_playback_reconciliations
      set state = 'blocked', infra_attempt_count = new_infra_attempt_count,
          next_attempt_at = null, lease_token = null, lease_expires_at = null,
          last_error_class = 'infrastructure', last_error_code = p_error_code,
          last_error_message = p_error_message,
          updated_at = pg_catalog.now(), finished_at = pg_catalog.now()
      where id = job.id;
      return 'blocked';
    end if;

    retry_delay := case new_infra_attempt_count
      when 1 then interval '1 minute'
      when 2 then interval '5 minutes'
      when 3 then interval '15 minutes'
      when 4 then interval '1 hour'
      when 5 then interval '3 hours'
      when 6 then interval '6 hours'
      when 7 then interval '12 hours'
      else interval '24 hours'
    end;
    update public.mux_playback_reconciliations
    set state = 'pending', infra_attempt_count = new_infra_attempt_count,
        next_attempt_at = pg_catalog.now() + retry_delay,
        lease_token = null, lease_expires_at = null,
        last_error_class = 'infrastructure', last_error_code = p_error_code,
        last_error_message = p_error_message,
        updated_at = pg_catalog.now(), finished_at = null
    where id = job.id;
    return 'retry_scheduled';
  end if;

  if p_outcome = 'mux_errored' then
    terminal_message := coalesce(p_error_message, 'Mux asset processing failed');
    update public.videos
    set status = 'errored', error_message = terminal_message,
        updated_at = pg_catalog.now()
    where id = job.video_id;
    update public.mux_playback_reconciliations
    set state = 'failed', infra_attempt_count = 0,
        not_found_attempt_count = 0,
        next_attempt_at = null, lease_token = null, lease_expires_at = null,
        last_error_class = 'mux_errored', last_error_code = p_error_code,
        last_error_message = terminal_message,
        updated_at = pg_catalog.now(), finished_at = pg_catalog.now()
    where id = job.id;
    return 'failed';
  end if;

  -- Integrity observations are operationally blocked. Do not turn inability
  -- to trust the response into an owner-visible encoding failure.
  update public.mux_playback_reconciliations
  set state = 'blocked', next_attempt_at = null, lease_token = null,
      lease_expires_at = null, last_error_class = 'integrity',
      last_error_code = p_error_code, last_error_message = p_error_message,
      updated_at = pg_catalog.now(), finished_at = pg_catalog.now()
  where id = job.id;
  return 'blocked';
end;
$$;

-- Manual recovery is intentionally limited to operationally blocked work.
-- Content failures require new signed upstream evidence through the enqueue
-- RPC or a separately reviewed product/operator runbook.
create function public.requeue_mux_playback_reconciliation(p_job_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.mux_playback_reconciliations%rowtype;
  video public.videos%rowtype;
begin
  select * into job
  from public.mux_playback_reconciliations
  where id = p_job_id
  for update;

  if not found then
    return 'no_job';
  end if;
  if job.state <> 'blocked' then
    return 'not_requeueable';
  end if;

  select * into video
  from public.videos
  where id = job.video_id
  for update;

  if not found or (video.mux_asset_id is not null and video.mux_asset_id <> job.mux_asset_id) then
    update public.mux_playback_reconciliations
    set state = 'obsolete', next_attempt_at = null, lease_token = null,
        lease_expires_at = null, updated_at = pg_catalog.now(),
        finished_at = pg_catalog.now()
    where id = job.id;
    return 'obsolete';
  end if;

  if video.status = 'ready'
     and video.mux_asset_id = job.mux_asset_id
     and video.mux_playback_id is not null
     and video.mux_playback_policy is not null then
    update public.mux_playback_reconciliations
    set state = 'succeeded', next_attempt_at = null, lease_token = null,
        lease_expires_at = null, updated_at = pg_catalog.now(),
        finished_at = pg_catalog.now()
    where id = job.id;
    return 'already_resolved';
  end if;

  update public.mux_playback_reconciliations
  set state = 'pending', infra_attempt_count = 0,
      not_found_attempt_count = 0, reopen_count = reopen_count + 1,
      next_attempt_at = pg_catalog.now(), lease_token = null,
      lease_expires_at = null, last_error_class = null,
      last_error_code = null, last_error_message = null,
      updated_at = pg_catalog.now(), finished_at = null
  where id = job.id;
  return 'requeued';
end;
$$;

-- Prevent a late upload.asset_created event from regressing a ready video.
-- Signature and calling contract are unchanged, so this body-only replacement
-- is safe before the new application deploy.
create or replace function public.process_mux_webhook_event(
  p_event_id text,
  p_event_type text,
  p_video_id uuid default null,
  p_status text default null,
  p_mux_asset_id text default null,
  p_error_message text default null,
  p_set_media boolean default false,
  p_mux_playback_id text default null,
  p_mux_playback_policy text default null,
  p_duration_seconds numeric default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted_rows integer;
  updated_rows integer;
  mutation_requested boolean;
  video_exists boolean;
begin
  insert into public.mux_webhook_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;

  get diagnostics inserted_rows = row_count;
  if inserted_rows = 0 then
    return 'duplicate';
  end if;

  mutation_requested :=
    p_status is not null
    or p_mux_asset_id is not null
    or p_error_message is not null
    or coalesce(p_set_media, false);

  if p_video_id is null or not mutation_requested then
    return 'recorded';
  end if;

  update public.videos
  set
    status = case when p_status is not null then p_status else status end,
    mux_asset_id = case
      when p_mux_asset_id is not null then p_mux_asset_id
      else mux_asset_id
    end,
    error_message = case
      when p_error_message is not null then p_error_message
      else error_message
    end,
    mux_playback_id = case
      when coalesce(p_set_media, false) then p_mux_playback_id
      else mux_playback_id
    end,
    mux_playback_policy = case
      when coalesce(p_set_media, false) then p_mux_playback_policy
      else mux_playback_policy
    end,
    duration_seconds = case
      when coalesce(p_set_media, false) then p_duration_seconds
      else duration_seconds
    end,
    updated_at = pg_catalog.now()
  where id = p_video_id
    and (p_status is distinct from 'preparing' or status <> 'ready');

  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then
    select exists(
      select 1 from public.videos where id = p_video_id
    ) into video_exists;
    if video_exists then
      return 'stale_transition';
    end if;
    return 'no_video';
  end if;

  return 'processed';
end;
$$;

revoke all on function public.queue_mux_playback_reconciliation_event(text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.queue_mux_playback_reconciliation_event(text, text, uuid, text)
  to service_role;

revoke all on function public.claim_mux_playback_reconciliations(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_mux_playback_reconciliations(integer, integer)
  to service_role;

revoke all on function public.finish_mux_playback_reconciliation(
  uuid, uuid, text, text, text, numeric, text, text
) from public, anon, authenticated;
grant execute on function public.finish_mux_playback_reconciliation(
  uuid, uuid, text, text, text, numeric, text, text
) to service_role;

revoke all on function public.requeue_mux_playback_reconciliation(uuid)
  from public, anon, authenticated;
grant execute on function public.requeue_mux_playback_reconciliation(uuid)
  to service_role;

-- The replaced function keeps the explicit service-role-only posture from
-- migration 0011; reassert it here so the migration is self-checking.
revoke all on function public.process_mux_webhook_event(
  text, text, uuid, text, text, text, boolean, text, text, numeric
) from public, anon, authenticated;
grant execute on function public.process_mux_webhook_event(
  text, text, uuid, text, text, text, boolean, text, text, numeric
) to service_role;

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.queue_mux_playback_reconciliation_event(text,text,uuid,text)',
    'public.claim_mux_playback_reconciliations(integer,integer)',
    'public.finish_mux_playback_reconciliation(uuid,uuid,text,text,text,numeric,text,text)',
    'public.requeue_mux_playback_reconciliation(uuid)',
    'public.process_mux_webhook_event(text,text,uuid,text,text,text,boolean,text,text,numeric)'
  ] loop
    if pg_catalog.has_function_privilege('anon', signature, 'execute')
       or pg_catalog.has_function_privilege('authenticated', signature, 'execute') then
      raise exception '% must not be executable by anon/authenticated', signature;
    end if;
  end loop;
end;
$$;
