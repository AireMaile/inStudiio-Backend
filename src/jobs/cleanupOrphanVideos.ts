import { logger } from '../logger.js';
import { supabase } from '../supabase.js';

const STALE_HOURS = 24;
const ORPHAN_REASON = 'orphaned by janitor: stale waiting row >24h';

/**
 * Plan 5 Phase 5: orphan-video janitor.
 *
 * A `videos` row is created in `status='waiting'` before the Mux direct
 * upload starts. If the upload is abandoned or the Mux webhook is lost,
 * the row stays in 'waiting' forever. This sweep flips any 'waiting' row
 * older than STALE_HOURS to 'errored' with a fixed error_message so the
 * owner-facing UI can surface it instead of treating it as in-progress.
 *
 * Idempotent: a second run produces no further changes (status filter).
 * Safe to run on a cron / one-off invocation; returns the affected count.
 */
export async function cleanupOrphanVideos(now: Date = new Date()): Promise<{ updated: number }> {
  const cutoff = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('videos')
    .update({ status: 'errored', error_message: ORPHAN_REASON })
    .eq('status', 'waiting')
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    logger.error({ err: error, cutoff }, 'cleanupOrphanVideos: update failed');
    throw error;
  }

  const updated = data?.length ?? 0;
  if (updated > 0) {
    logger.warn({ updated, cutoff }, 'cleanupOrphanVideos: marked orphan videos errored');
  } else {
    logger.info({ cutoff }, 'cleanupOrphanVideos: no orphans found');
  }
  return { updated };
}
