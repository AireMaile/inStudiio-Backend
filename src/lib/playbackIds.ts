export interface MuxPlaybackId {
  policy: 'signed' | 'public';
  id: string;
}

/**
 * Pick the playback id to persist from a Mux asset's playback_ids.
 *
 * New uploads carry only a `signed` id; assets created before the signed-
 * playback migration carry a `public` one, which we keep honoring until they
 * are rotated. Prefer signed so a rotated asset immediately switches over.
 */
export function pickPlayback(ids: MuxPlaybackId[]): MuxPlaybackId | null {
  return (
    ids.find((p) => p.policy === 'signed') ??
    ids.find((p) => p.policy === 'public') ??
    null
  );
}
