-- Post-application enforcement. Apply in production only after the 0012-aware
-- webhook and reconciliation worker are fully deployed and production counts
-- have been reviewed. This migration removes historical false-ready states,
-- queues repairable rows, and then makes the invariant database-enforced.

insert into public.mux_playback_reconciliations as existing (
  video_id,
  mux_asset_id,
  source_event_id
)
select
  video.id,
  video.mux_asset_id,
  null
from public.videos as video
where video.status = 'ready'
  and (video.mux_playback_id is null or video.mux_playback_policy is null)
  and video.mux_asset_id is not null
on conflict (video_id, mux_asset_id) do update
set
  state = case
    when existing.state in ('pending', 'leased') then existing.state
    else 'pending'
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

update public.videos
set status = 'preparing',
    error_message = null,
    updated_at = pg_catalog.now()
where status = 'ready'
  and (mux_playback_id is null or mux_playback_policy is null)
  and mux_asset_id is not null;

update public.videos
set status = 'errored',
    error_message = 'Playback reconciliation unavailable: video has no Mux asset ID',
    updated_at = pg_catalog.now()
where status = 'ready'
  and (mux_playback_id is null or mux_playback_policy is null)
  and mux_asset_id is null;

alter table public.videos
  add constraint videos_ready_playback_pair_check
  check (
    status <> 'ready'
    or (mux_playback_id is not null and mux_playback_policy is not null)
  );
