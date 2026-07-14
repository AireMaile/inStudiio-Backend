import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  deleteAllWebhookEventsByPrefix,
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
  insertTestStudio,
  insertTestVideo,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'mux-reconcile-rpc-';
const EVENT_PREFIX = 'evt_mux_reconcile_rpc_';

describe('Mux playback reconciliation RPCs', () => {
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

  async function makeVideo(opts?: {
    status?: 'waiting' | 'preparing' | 'ready' | 'errored';
    assetId?: string | null;
    playbackId?: string | null;
  }) {
    const owner = await createTestUser('mux-reconcile-rpc-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return insertTestVideo({
      studioId: studio.id,
      status: opts?.status ?? 'preparing',
      muxAssetId: opts?.assetId === undefined ? 'asset_reconcile' : opts.assetId,
      muxPlaybackId: opts?.playbackId,
      muxPlaybackPolicy: opts?.playbackId ? 'signed' : null,
    });
  }

  function eventId(label: string): string {
    return `${EVENT_PREFIX}${label}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  async function enqueue(videoId: string, assetId: string, label = 'enqueue') {
    const id = eventId(label);
    const result = await supabase.rpc('queue_mux_playback_reconciliation_event', {
      p_event_id: id,
      p_event_type: 'video.asset.ready',
      p_video_id: videoId,
      p_mux_asset_id: assetId,
    });
    return { ...result, eventId: id };
  }

  async function jobFor(videoId: string, assetId = 'asset_reconcile') {
    const { data, error } = await supabase
      .from('mux_playback_reconciliations')
      .select('*')
      .eq('video_id', videoId)
      .eq('mux_asset_id', assetId)
      .single();
    if (error || !data) throw error ?? new Error('reconciliation job missing');
    return data;
  }

  async function claimOne() {
    const { data, error } = await supabase.rpc('claim_mux_playback_reconciliations', {
      p_limit: 1,
      p_lease_seconds: 60,
    });
    if (error) throw error;
    if (!data?.[0]) throw new Error('expected one claimed reconciliation');
    return data[0];
  }

  async function makeDue(jobId: string): Promise<void> {
    const { error } = await supabase
      .from('mux_playback_reconciliations')
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', jobId);
    if (error) throw error;
  }

  it('atomically ledgers and enqueues; duplicate and pending conflicts are idempotent', async () => {
    const video = await makeVideo();
    const first = await enqueue(video.id, 'asset_reconcile', 'first');
    expect(first.error).toBeNull();
    expect(first.data).toBe('queued');

    const firstJob = await jobFor(video.id);
    expect(firstJob).toMatchObject({
      state: 'pending',
      attempt_count: 0,
      reopen_count: 0,
      source_event_id: first.eventId,
    });

    const duplicate = await supabase.rpc('queue_mux_playback_reconciliation_event', {
      p_event_id: first.eventId,
      p_event_type: 'video.asset.ready',
      p_video_id: video.id,
      p_mux_asset_id: 'asset_reconcile',
    });
    expect(duplicate.error).toBeNull();
    expect(duplicate.data).toBe('duplicate');

    const second = await enqueue(video.id, 'asset_reconcile', 'pending-conflict');
    expect(second.data).toBe('queued');
    const unchanged = await jobFor(video.id);
    expect(unchanged.source_event_id).toBe(first.eventId);
    expect(unchanged.next_attempt_at).toBe(firstJob.next_attempt_at);
    expect(unchanged.reopen_count).toBe(0);
  });

  it('does not ledger an asset mismatch that the route must retry', async () => {
    const video = await makeVideo({ assetId: 'asset_original' });
    const result = await enqueue(video.id, 'asset_wrong', 'mismatch');
    expect(result.error).toBeNull();
    expect(result.data).toBe('asset_mismatch');

    const { count } = await supabase
      .from('mux_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('event_id', result.eventId);
    expect(count).toBe(0);
    const { count: jobs } = await supabase
      .from('mux_playback_reconciliations')
      .select('id', { count: 'exact', head: true })
      .eq('video_id', video.id);
    expect(jobs).toBe(0);
  });

  it('records no-video and already-resolved events without creating work', async () => {
    const missing = await enqueue(crypto.randomUUID(), 'asset_missing', 'no-video');
    expect(missing.data).toBe('no_video');

    const ready = await makeVideo({
      status: 'ready',
      assetId: 'asset_ready',
      playbackId: 'pb_ready',
    });
    const resolved = await enqueue(ready.id, 'asset_ready', 'already-resolved');
    expect(resolved.data).toBe('already_resolved');
    const { count } = await supabase
      .from('mux_playback_reconciliations')
      .select('id', { count: 'exact', head: true })
      .eq('video_id', ready.id);
    expect(count).toBe(0);
  });

  it.each(['blocked', 'failed', 'succeeded', 'obsolete'] as const)(
    'reopens a %s workflow on distinct signed upstream evidence',
    async (state) => {
      const video = await makeVideo();
      const first = await enqueue(video.id, 'asset_reconcile', `seed-${state}`);
      expect(first.data).toBe('queued');
      const seeded = await jobFor(video.id);
      const terminalAt = new Date().toISOString();
      const { error: seedError } = await supabase
        .from('mux_playback_reconciliations')
        .update({
          state,
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null,
          finished_at: terminalAt,
          last_error_class: state === 'blocked' ? 'infrastructure' : null,
        })
        .eq('id', seeded.id);
      expect(seedError).toBeNull();

      const reopened = await enqueue(video.id, 'asset_reconcile', `reopen-${state}`);
      expect(reopened.data).toBe('queued');
      const row = await jobFor(video.id);
      expect(row.state).toBe('pending');
      expect(row.reopen_count).toBe(1);
      expect(row.source_event_id).toBe(reopened.eventId);
      expect(row.finished_at).toBeNull();
      expect(row.infra_attempt_count).toBe(0);
      expect(row.not_found_attempt_count).toBe(0);
    },
  );

  it('never mutates a live lease when another event converges on the same workflow', async () => {
    const video = await makeVideo();
    const first = await enqueue(video.id, 'asset_reconcile', 'leased-first');
    expect(first.data).toBe('queued');
    const claimed = await claimOne();

    const second = await enqueue(video.id, 'asset_reconcile', 'leased-second');
    expect(second.data).toBe('queued');
    const row = await jobFor(video.id);
    expect(row.state).toBe('leased');
    expect(row.lease_token).toBe(claimed.lease_token);
    expect(row.source_event_id).toBe(first.eventId);
    expect(row.reopen_count).toBe(0);
  });

  it('claims due work, reclaims expired leases, and fences the stale worker token', async () => {
    const video = await makeVideo();
    expect((await enqueue(video.id, 'asset_reconcile', 'lease')).data).toBe('queued');
    const first = await claimOne();
    expect(first.attempt_count).toBe(1);

    const { error: expireError } = await supabase
      .from('mux_playback_reconciliations')
      .update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', first.job_id);
    expect(expireError).toBeNull();
    const second = await claimOne();
    expect(second.attempt_count).toBe(2);
    expect(second.lease_token).not.toBe(first.lease_token);

    const stale = await supabase.rpc('finish_mux_playback_reconciliation', {
      p_job_id: first.job_id,
      p_lease_token: first.lease_token,
      p_outcome: 'infrastructure',
    });
    expect(stale.error).toBeNull();
    expect(stale.data).toBe('stale_lease');

    const current = await supabase.rpc('finish_mux_playback_reconciliation', {
      p_job_id: second.job_id,
      p_lease_token: second.lease_token,
      p_outcome: 'content_preparing',
    });
    expect(current.error).toBeNull();
    expect(current.data).toBe('retry_scheduled');
  });

  it('uses skip-locked claims so concurrent workers never receive the same job', async () => {
    const firstVideo = await makeVideo({ assetId: 'asset_concurrent_first' });
    const secondVideo = await makeVideo({ assetId: 'asset_concurrent_second' });
    expect((await enqueue(firstVideo.id, 'asset_concurrent_first', 'concurrent-first')).data).toBe(
      'queued',
    );
    expect(
      (await enqueue(secondVideo.id, 'asset_concurrent_second', 'concurrent-second')).data,
    ).toBe('queued');

    const [firstClaim, secondClaim] = await Promise.all([
      supabase.rpc('claim_mux_playback_reconciliations', {
        p_limit: 1,
        p_lease_seconds: 60,
      }),
      supabase.rpc('claim_mux_playback_reconciliations', {
        p_limit: 1,
        p_lease_seconds: 60,
      }),
    ]);

    expect(firstClaim.error).toBeNull();
    expect(secondClaim.error).toBeNull();
    expect(firstClaim.data).toHaveLength(1);
    expect(secondClaim.data).toHaveLength(1);
    expect(firstClaim.data?.[0]?.job_id).not.toBe(secondClaim.data?.[0]?.job_id);
    expect(
      new Set([firstClaim.data?.[0]?.video_id, secondClaim.data?.[0]?.video_id]),
    ).toEqual(new Set([firstVideo.id, secondVideo.id]));
  });

  it('prunes already-resolved work before making a Mux claim', async () => {
    const video = await makeVideo();
    expect((await enqueue(video.id, 'asset_reconcile', 'prune')).data).toBe('queued');
    const { error: resolveError } = await supabase
      .from('videos')
      .update({
        status: 'ready',
        mux_playback_id: 'pb_elsewhere',
        mux_playback_policy: 'signed',
      })
      .eq('id', video.id);
    expect(resolveError).toBeNull();

    const claimed = await supabase.rpc('claim_mux_playback_reconciliations', {
      p_limit: 10,
      p_lease_seconds: 60,
    });
    expect(claimed.error).toBeNull();
    expect(claimed.data).toEqual([]);
    expect((await jobFor(video.id)).state).toBe('succeeded');
  });

  it('finishes a valid authoritative snapshot transactionally', async () => {
    const video = await makeVideo();
    expect((await enqueue(video.id, 'asset_reconcile', 'success')).data).toBe('queued');
    const claim = await claimOne();
    const result = await supabase.rpc('finish_mux_playback_reconciliation', {
      p_job_id: claim.job_id,
      p_lease_token: claim.lease_token,
      p_outcome: 'succeeded',
      p_playback_id: 'pb_reconciled',
      p_playback_policy: 'signed',
      p_duration_seconds: 42.5,
    });
    expect(result.error).toBeNull();
    expect(result.data).toBe('succeeded');

    const row = await jobFor(video.id);
    expect(row.state).toBe('succeeded');
    expect(row.finished_at).not.toBeNull();
    const { data: updated } = await supabase
      .from('videos')
      .select('status, mux_playback_id, mux_playback_policy, duration_seconds')
      .eq('id', video.id)
      .single();
    expect(updated).toMatchObject({
      status: 'ready',
      mux_playback_id: 'pb_reconciled',
      mux_playback_policy: 'signed',
      duration_seconds: 42.5,
    });
  });

  it('uses age only after a successful content observation and resets class counters', async () => {
    const video = await makeVideo();
    expect((await enqueue(video.id, 'asset_reconcile', 'class-reset')).data).toBe('queued');

    let claim = await claimOne();
    let result = await supabase.rpc('finish_mux_playback_reconciliation', {
      p_job_id: claim.job_id,
      p_lease_token: claim.lease_token,
      p_outcome: 'not_found',
    });
    expect(result.data).toBe('retry_scheduled');
    await makeDue(claim.job_id);

    claim = await claimOne();
    result = await supabase.rpc('finish_mux_playback_reconciliation', {
      p_job_id: claim.job_id,
      p_lease_token: claim.lease_token,
      p_outcome: 'infrastructure',
    });
    expect(result.data).toBe('retry_scheduled');
    await makeDue(claim.job_id);

    claim = await claimOne();
    result = await supabase.rpc('finish_mux_playback_reconciliation', {
      p_job_id: claim.job_id,
      p_lease_token: claim.lease_token,
      p_outcome: 'content_preparing',
    });
    expect(result.data).toBe('retry_scheduled');
    const row = await jobFor(video.id);
    expect(row.infra_attempt_count).toBe(0);
    expect(row.not_found_attempt_count).toBe(0);
    expect(row.last_error_class).toBe('content_preparing');
  });

  it('fails ready-without-playback only after a successful observation beyond 24 hours', async () => {
    const video = await makeVideo();
    expect((await enqueue(video.id, 'asset_reconcile', 'content-deadline')).data).toBe('queued');
    const claim = await claimOne();
    const { error: ageError } = await supabase
      .from('mux_playback_reconciliations')
      .update({ created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
      .eq('id', claim.job_id);
    expect(ageError).toBeNull();

    const result = await supabase.rpc('finish_mux_playback_reconciliation', {
      p_job_id: claim.job_id,
      p_lease_token: claim.lease_token,
      p_outcome: 'content_missing_playback',
      p_error_code: 'missing_playback',
    });
    expect(result.data).toBe('failed');
    expect((await jobFor(video.id)).state).toBe('failed');
    const { data: failedVideo } = await supabase
      .from('videos')
      .select('status, error_message')
      .eq('id', video.id)
      .single();
    expect(failedVideo?.status).toBe('errored');
    expect(failedVideo?.error_message).toContain('no supported playback ID');
  });

  it('blocks repeated infrastructure failures without falsely erroring the video', async () => {
    const video = await makeVideo();
    expect((await enqueue(video.id, 'asset_reconcile', 'infra-budget')).data).toBe('queued');
    let finalResult: string | null = null;
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const claim = await claimOne();
      const result = await supabase.rpc('finish_mux_playback_reconciliation', {
        p_job_id: claim.job_id,
        p_lease_token: claim.lease_token,
        p_outcome: 'infrastructure',
        p_error_code: 'timeout',
        p_error_message: 'Mux asset lookup unavailable',
      });
      expect(result.error).toBeNull();
      finalResult = result.data;
      if (attempt < 9) await makeDue(claim.job_id);
    }
    expect(finalResult).toBe('blocked');
    const job = await jobFor(video.id);
    expect(job.state).toBe('blocked');
    expect(job.infra_attempt_count).toBe(9);
    const { data: unchangedVideo } = await supabase
      .from('videos')
      .select('status, error_message')
      .eq('id', video.id)
      .single();
    expect(unchangedVideo).toMatchObject({ status: 'preparing', error_message: null });

    const requeue = await supabase.rpc('requeue_mux_playback_reconciliation', {
      p_job_id: job.id,
    });
    expect(requeue.data).toBe('requeued');
    const requeued = await jobFor(video.id);
    expect(requeued.state).toBe('pending');
    expect(requeued.infra_attempt_count).toBe(0);
    expect(requeued.reopen_count).toBe(1);
  });
});
