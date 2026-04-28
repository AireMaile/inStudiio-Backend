import { logger } from '../logger.js';
import { supabase } from '../supabase.js';

const DEFAULT_STALE_HOURS = 24;

/**
 * Plan 5 Phase 5: orphan-video janitor.
 *
 * A `videos` row is created in `status='waiting'` before the Mux direct
 * upload starts. If the upload is abandoned or the Mux webhook is lost,
 * the row stays in 'waiting' forever. This sweep flips any 'waiting' row
 * older than `staleHours` to 'errored' with a fixed error_message so the
 * owner-facing UI can surface it instead of treating it as in-progress.
 *
 * Idempotent: a second run produces no further changes (status filter).
 * Safe to run on a cron / one-off invocation; returns the affected count.
 *
 * Wiring: this is invoked by `scripts/run-cleanup-orphans.ts`, which is
 * the entrypoint a cron runner (Supabase pg_cron, GitHub Actions cron,
 * or platform job) should call. Not wired into the express process on a
 * timer because multi-instance deployments would run concurrent sweeps.
 */
export async function cleanupOrphanVideos(opts?: {
  now?: Date;
  staleHours?: number;
}): Promise<{ updated: number }> {
  const now = opts?.now ?? new Date();
  const staleHours = opts?.staleHours ?? DEFAULT_STALE_HOURS;
  const cutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000).toISOString();
  const reason = `orphaned by janitor: stale waiting row >${staleHours}h`;

  const { data, error } = await supabase
    .from('videos')
    .update({ status: 'errored', error_message: reason })
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
