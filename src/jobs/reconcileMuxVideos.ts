import { pickPlayback } from '../lib/playbackIds.js';
import { logger } from '../logger.js';
import type { MuxClient } from '../mux.js';
import { supabase } from '../supabase.js';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_MUX_TIMEOUT_MS = 5_000;

type ClaimedJob = {
  job_id: string;
  video_id: string;
  mux_asset_id: string;
  attempt_count: number;
  lease_token: string;
  lease_expires_at: string;
};

type FinishOutcome =
  | 'succeeded'
  | 'content_preparing'
  | 'content_missing_playback'
  | 'not_found'
  | 'infrastructure'
  | 'mux_errored'
  | 'integrity';

type FinishInput = {
  outcome: FinishOutcome;
  playbackId?: string;
  playbackPolicy?: 'signed' | 'public';
  durationSeconds?: number;
  errorCode?: string;
  errorMessage?: string;
};

export interface ReconcileMuxVideosSummary {
  claimed: number;
  succeeded: number;
  retry_scheduled: number;
  failed: number;
  blocked: number;
  already_resolved: number;
  obsolete: number;
  stale_lease: number;
  finish_failures: number;
}

export interface ReconcileMuxVideosOptions {
  batchSize?: number;
  concurrency?: number;
  leaseSeconds?: number;
  muxTimeoutMs?: number;
}

export interface ReconcileMuxVideosDeps {
  mux: Pick<MuxClient, 'video'>;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function httpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function classifyRetrieveError(err: unknown): FinishInput {
  const status = httpStatus(err);
  if (status === 404) {
    return {
      outcome: 'not_found',
      errorCode: 'mux_asset_not_found',
      errorMessage: 'Mux asset was not found',
    };
  }
  return {
    outcome: 'infrastructure',
    errorCode:
      status === 429
        ? 'mux_rate_limited'
        : status && status >= 500
          ? 'mux_server_error'
          : 'mux_request_failed',
    errorMessage: 'Mux asset lookup is temporarily unavailable',
  };
}

function classifyAsset(job: ClaimedJob, asset: Awaited<ReturnType<MuxClient['video']['assets']['retrieve']>>): FinishInput {
  if (asset.id !== job.mux_asset_id) {
    return {
      outcome: 'integrity',
      errorCode: 'mux_asset_id_mismatch',
      errorMessage: 'Mux returned an unexpected asset identity',
    };
  }
  if (typeof asset.passthrough === 'string' && asset.passthrough !== job.video_id) {
    return {
      outcome: 'integrity',
      errorCode: 'mux_passthrough_mismatch',
      errorMessage: 'Mux asset passthrough does not match the video',
    };
  }

  switch (asset.status) {
    case 'ready': {
      const playback = pickPlayback(asset.playback_ids ?? []);
      if (!playback) {
        return {
          outcome: 'content_missing_playback',
          errorCode: 'mux_playback_missing',
          errorMessage: 'Mux asset is ready but has no supported playback ID',
        };
      }
      return {
        outcome: 'succeeded',
        playbackId: playback.id,
        playbackPolicy: playback.policy,
        durationSeconds: typeof asset.duration === 'number' ? asset.duration : undefined,
      };
    }
    case 'preparing':
      return {
        outcome: 'content_preparing',
        errorCode: 'mux_asset_preparing',
        errorMessage: 'Mux asset is still preparing',
      };
    case 'errored':
      return {
        outcome: 'mux_errored',
        errorCode: 'mux_asset_errored',
        errorMessage: 'Mux asset processing failed',
      };
    default:
      return {
        outcome: 'integrity',
        errorCode: 'mux_asset_status_unknown',
        errorMessage: 'Mux returned an unsupported asset status',
      };
  }
}

async function finish(job: ClaimedJob, input: FinishInput): Promise<string> {
  const { data, error } = await supabase.rpc('finish_mux_playback_reconciliation', {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
    p_outcome: input.outcome,
    p_playback_id: input.playbackId,
    p_playback_policy: input.playbackPolicy,
    p_duration_seconds: input.durationSeconds,
    p_error_code: input.errorCode,
    p_error_message: input.errorMessage,
  });
  if (error) throw error;
  return data;
}

async function processJob(
  deps: ReconcileMuxVideosDeps,
  job: ClaimedJob,
  muxTimeoutMs: number,
): Promise<string> {
  let classification: FinishInput;
  try {
    const asset = await deps.mux.video.assets.retrieve(job.mux_asset_id, {
      timeout: muxTimeoutMs,
      maxRetries: 0,
    });
    classification = classifyAsset(job, asset);
  } catch (err) {
    classification = classifyRetrieveError(err);
  }
  return finish(job, classification);
}

/**
 * Claims a bounded batch of durable playback-reconciliation workflows and
 * resolves each from Mux's authoritative Asset API. Mux is read-only here;
 * every state transition is fenced by the database lease token.
 */
export async function reconcileMuxVideos(
  deps: ReconcileMuxVideosDeps,
  opts: ReconcileMuxVideosOptions = {},
): Promise<ReconcileMuxVideosSummary> {
  const batchSize = boundedInteger(opts.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, 50);
  const concurrency = boundedInteger(
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    'concurrency',
    1,
    batchSize,
  );
  const leaseSeconds = boundedInteger(
    opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    'leaseSeconds',
    15,
    300,
  );
  const muxTimeoutMs = boundedInteger(
    opts.muxTimeoutMs ?? DEFAULT_MUX_TIMEOUT_MS,
    'muxTimeoutMs',
    250,
    30_000,
  );

  const { data, error } = await supabase.rpc('claim_mux_playback_reconciliations', {
    p_limit: batchSize,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    logger.error({ err: error }, 'reconcileMuxVideos: claim failed');
    throw error;
  }
  const jobs = (data ?? []) as ClaimedJob[];
  const summary: ReconcileMuxVideosSummary = {
    claimed: jobs.length,
    succeeded: 0,
    retry_scheduled: 0,
    failed: 0,
    blocked: 0,
    already_resolved: 0,
    obsolete: 0,
    stale_lease: 0,
    finish_failures: 0,
  };

  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (!job) return;
      try {
        const result = await processJob(deps, job, muxTimeoutMs);
        if (result in summary && result !== 'claimed' && result !== 'finish_failures') {
          summary[result as keyof Omit<ReconcileMuxVideosSummary, 'claimed' | 'finish_failures'>] += 1;
        } else {
          summary.finish_failures += 1;
          logger.error(
            { jobId: job.job_id, videoId: job.video_id, assetId: job.mux_asset_id, result },
            'reconcileMuxVideos: finish returned unknown result',
          );
        }
      } catch (err) {
        summary.finish_failures += 1;
        logger.error(
          { err, jobId: job.job_id, videoId: job.video_id, assetId: job.mux_asset_id },
          'reconcileMuxVideos: job finish failed; lease will expire for retry',
        );
      }
    }
  });
  await Promise.all(runners);

  logger.info(summary, 'reconcileMuxVideos: batch complete');
  return summary;
}
