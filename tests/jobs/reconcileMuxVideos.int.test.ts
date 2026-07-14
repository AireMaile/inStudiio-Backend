import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileMuxVideos } from '../../src/jobs/reconcileMuxVideos.js';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  deleteAllWebhookEventsByPrefix,
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
  insertTestStudio,
  insertTestVideo,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'mux-reconcile-job-';
const EVENT_PREFIX = 'evt_mux_reconcile_job_';

describe('reconcileMuxVideos', () => {
  const users: TestUser[] = [];

  beforeEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllWebhookEventsByPrefix(EVENT_PREFIX);
  });

  afterEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllWebhookEventsByPrefix(EVENT_PREFIX);
    for (const user of users) await deleteTestUser(user.id);
    users.length = 0;
  });

  async function queuedVideo(assetId = `asset_job_${Math.random().toString(36).slice(2, 8)}`) {
    const owner = await createTestUser('mux-reconcile-job-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const video = await insertTestVideo({
      studioId: studio.id,
      status: 'preparing',
      muxAssetId: assetId,
    });
    const eventId = `${EVENT_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const queued = await supabase.rpc('queue_mux_playback_reconciliation_event', {
      p_event_id: eventId,
      p_event_type: 'video.asset.ready',
      p_video_id: video.id,
      p_mux_asset_id: assetId,
    });
    if (queued.error || queued.data !== 'queued') {
      throw queued.error ?? new Error(`unexpected enqueue result: ${queued.data}`);
    }
    return { video, assetId, eventId };
  }

  function fakeMux(retrieve: ReturnType<typeof vi.fn>) {
    return { video: { assets: { retrieve } } } as any;
  }

  it('retrieves authoritative media with bounded SDK options and resolves the video', async () => {
    const { video, assetId } = await queuedVideo();
    const retrieve = vi.fn().mockResolvedValue({
      id: assetId,
      passthrough: video.id,
      status: 'ready',
      duration: 31.25,
      playback_ids: [
        { id: 'pb_public', policy: 'public' },
        { id: 'pb_signed', policy: 'signed' },
      ],
    });

    const summary = await reconcileMuxVideos(
      { mux: fakeMux(retrieve) },
      { batchSize: 1, concurrency: 1, leaseSeconds: 60, muxTimeoutMs: 1_234 },
    );

    expect(retrieve).toHaveBeenCalledWith(assetId, { timeout: 1_234, maxRetries: 0 });
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, finish_failures: 0 });
    const { data: row } = await supabase
      .from('videos')
      .select('status, mux_playback_id, mux_playback_policy, duration_seconds')
      .eq('id', video.id)
      .single();
    expect(row).toMatchObject({
      status: 'ready',
      mux_playback_id: 'pb_signed',
      mux_playback_policy: 'signed',
      duration_seconds: 31.25,
    });
  });

  it('classifies 404 separately and schedules a database-owned retry', async () => {
    const { video } = await queuedVideo();
    const retrieve = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));

    const summary = await reconcileMuxVideos(
      { mux: fakeMux(retrieve) },
      { batchSize: 1, concurrency: 1 },
    );
    expect(summary).toMatchObject({ claimed: 1, retry_scheduled: 1 });
    const { data: job } = await supabase
      .from('mux_playback_reconciliations')
      .select('state, not_found_attempt_count, infra_attempt_count, last_error_class')
      .eq('video_id', video.id)
      .single();
    expect(job).toEqual({
      state: 'pending',
      not_found_attempt_count: 1,
      infra_attempt_count: 0,
      last_error_class: 'not_found',
    });
  });

  it('blocks an identity mismatch without changing the video business state', async () => {
    const { video } = await queuedVideo();
    const retrieve = vi.fn().mockResolvedValue({
      id: 'asset_unexpected',
      passthrough: video.id,
      status: 'ready',
      playback_ids: [{ id: 'pb_wrong', policy: 'signed' }],
    });

    const summary = await reconcileMuxVideos(
      { mux: fakeMux(retrieve) },
      { batchSize: 1, concurrency: 1 },
    );
    expect(summary).toMatchObject({ claimed: 1, blocked: 1 });
    const { data: job } = await supabase
      .from('mux_playback_reconciliations')
      .select('state, last_error_class, last_error_code')
      .eq('video_id', video.id)
      .single();
    expect(job).toEqual({
      state: 'blocked',
      last_error_class: 'integrity',
      last_error_code: 'mux_asset_id_mismatch',
    });
    const { data: row } = await supabase.from('videos').select('status').eq('id', video.id).single();
    expect(row?.status).toBe('preparing');
  });

  it('bounds concurrent Mux reads', async () => {
    const items = await Promise.all([queuedVideo(), queuedVideo(), queuedVideo(), queuedVideo()]);
    let active = 0;
    let maxActive = 0;
    const retrieve = vi.fn().mockImplementation(async (assetId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      const item = items.find((candidate) => candidate.assetId === assetId);
      return {
        id: assetId,
        passthrough: item?.video.id,
        status: 'ready',
        playback_ids: [{ id: `pb_${assetId}`, policy: 'signed' }],
      };
    });

    const summary = await reconcileMuxVideos(
      { mux: fakeMux(retrieve) },
      { batchSize: 4, concurrency: 2 },
    );
    expect(summary).toMatchObject({ claimed: 4, succeeded: 4 });
    expect(maxActive).toBe(2);
  });

  it('prunes a database-resolved job without calling Mux', async () => {
    const { video } = await queuedVideo();
    const { error } = await supabase
      .from('videos')
      .update({ status: 'ready', mux_playback_id: 'pb_other', mux_playback_policy: 'signed' })
      .eq('id', video.id);
    expect(error).toBeNull();
    const retrieve = vi.fn();

    const summary = await reconcileMuxVideos(
      { mux: fakeMux(retrieve) },
      { batchSize: 1, concurrency: 1 },
    );
    expect(summary.claimed).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
    const { data: job } = await supabase
      .from('mux_playback_reconciliations')
      .select('state')
      .eq('video_id', video.id)
      .single();
    expect(job?.state).toBe('succeeded');
  });
});
