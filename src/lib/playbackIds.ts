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
function isMuxPlaybackId(value: unknown): value is MuxPlaybackId {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { policy?: unknown; id?: unknown };
  return (
    (candidate.policy === 'signed' || candidate.policy === 'public') &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0
  );
}

export function pickPlayback(ids: readonly unknown[]): MuxPlaybackId | null {
  const valid = ids.filter(isMuxPlaybackId);
  return (
    valid.find((p) => p.policy === 'signed') ??
    valid.find((p) => p.policy === 'public') ??
    null
  );
}
