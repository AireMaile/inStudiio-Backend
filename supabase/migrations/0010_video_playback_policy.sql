-- The playback ID alone is insufficient to decide whether a Mux token belongs
-- on its URL. Mux intentionally rejects tokenized URLs for public playback IDs.
alter table public.videos
  add column mux_playback_policy text;

-- Every asset created before signed playback was introduced used public policy.
update public.videos
set mux_playback_policy = 'public'
where mux_playback_id is not null;

alter table public.videos
  add constraint videos_mux_playback_policy_check
    check (mux_playback_policy in ('public', 'signed')),
  add constraint videos_mux_playback_pair_check
    check ((mux_playback_id is null) = (mux_playback_policy is null));
