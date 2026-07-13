-- Atomically ledger a Mux webhook event and apply its video mutation.
--
-- The previous handler used separate PostgREST requests for the ledger insert
-- and video update, then tried to compensate by deleting the ledger row when
-- the update failed. If both the update and compensation failed, all retries
-- were incorrectly treated as duplicates. One RPC call gives both writes the
-- same PostgreSQL transaction: either both commit or both roll back.
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

  -- Unknown events, missing passthrough, and callers that supplied a video id
  -- but no mutation are ledger-only. In particular, do not touch updated_at.
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
  where id = p_video_id;

  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then
    return 'no_video';
  end if;

  return 'processed';
end;
$$;

-- Functions in exposed schemas are executable by PUBLIC by default. Only the
-- backend's service-role client may invoke this write-capable RPC.
revoke all on function public.process_mux_webhook_event(
  text, text, uuid, text, text, text, boolean, text, text, numeric
) from public;
revoke all on function public.process_mux_webhook_event(
  text, text, uuid, text, text, text, boolean, text, text, numeric
) from anon, authenticated;
grant execute on function public.process_mux_webhook_event(
  text, text, uuid, text, text, text, boolean, text, text, numeric
) to service_role;

-- Make the security posture executable documentation: every local reset and
-- remote migration fails if either public API role can execute the function.
do $$
begin
  if pg_catalog.has_function_privilege(
    'anon',
    'public.process_mux_webhook_event(text,text,uuid,text,text,text,boolean,text,text,numeric)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.process_mux_webhook_event(text,text,uuid,text,text,text,boolean,text,text,numeric)',
    'execute'
  ) then
    raise exception 'process_mux_webhook_event must not be executable by anon/authenticated';
  end if;
end;
$$;
