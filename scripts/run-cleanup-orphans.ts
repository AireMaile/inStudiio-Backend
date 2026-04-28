#!/usr/bin/env tsx
/**
 * Cron entrypoint for the orphan-video janitor (Plan 5 Phase 5).
 *
 * Run with: pnpm tsx scripts/run-cleanup-orphans.ts [--hours=24]
 *
 * Wire to a cron runner (Supabase pg_cron, GitHub Actions cron, or your
 * platform's scheduler). Recommended cadence: hourly.
 *
 * The sweep is idempotent (status filter excludes already-errored rows),
 * so over-firing is harmless. Exits 0 on success, non-zero on DB error.
 */
import { parseArgs } from 'node:util';
import { cleanupOrphanVideos } from '../src/jobs/cleanupOrphanVideos.js';
import { logger } from '../src/logger.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { hours: { type: 'string' } },
    strict: true,
  });
  const staleHours = values.hours ? Number(values.hours) : undefined;
  if (staleHours !== undefined && (!Number.isFinite(staleHours) || staleHours <= 0)) {
    console.error(`invalid --hours value: ${values.hours}`);
    process.exit(2);
  }

  const { updated } = await cleanupOrphanVideos({ staleHours });
  logger.info({ updated, staleHours: staleHours ?? 24 }, 'cleanupOrphanVideos: done');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'cleanupOrphanVideos: fatal');
  process.exit(1);
});
