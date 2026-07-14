import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { env } from '../../src/env.js';
import { createApp } from '../../src/index.js';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  deleteAllWebhookEventsByPrefix,
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
  insertTestStudio,
  insertTestVideo,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'internal-mux-job-';
const EVENT_PREFIX = 'evt_internal_mux_job_';

function fakeMux(retrieve = vi.fn()) {
  return {
    video: {
      assets: { retrieve, delete: vi.fn() },
      uploads: { create: vi.fn() },
    },
    webhooks: { unwrap: vi.fn() },
  } as any;
}

describe('POST /internal/jobs/mux-reconciliation', () => {
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

  it('rejects missing and incorrect bearer secrets without invoking Mux', async () => {
    const retrieve = vi.fn();
    const app = createApp({ mux: fakeMux(retrieve) });

    const missing = await request(app).post('/internal/jobs/mux-reconciliation').send({});
    expect(missing.status).toBe(401);
    const wrong = await request(app)
      .post('/internal/jobs/mux-reconciliation')
      .set('Authorization', `Bearer ${'x'.repeat(env.CRON_SECRET?.length ?? 16)}`)
      .send({});
    expect(wrong.status).toBe(401);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('runs a bounded reconciliation batch with the exact configured bearer secret', async () => {
    const owner = await createTestUser('internal-mux-job-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}${Date.now()}`,
    });
    const assetId = 'asset_internal_job';
    const video = await insertTestVideo({
      studioId: studio.id,
      status: 'preparing',
      muxAssetId: assetId,
    });
    const eventId = `${EVENT_PREFIX}${Date.now()}`;
    const queued = await supabase.rpc('queue_mux_playback_reconciliation_event', {
      p_event_id: eventId,
      p_event_type: 'video.asset.ready',
      p_video_id: video.id,
      p_mux_asset_id: assetId,
    });
    expect(queued.data).toBe('queued');

    const retrieve = vi.fn().mockResolvedValue({
      id: assetId,
      passthrough: video.id,
      status: 'ready',
      duration: 12,
      playback_ids: [{ id: 'pb_internal_job', policy: 'signed' }],
    });
    const app = createApp({ mux: fakeMux(retrieve) });
    const res = await request(app)
      .post('/internal/jobs/mux-reconciliation')
      .set('Authorization', `Bearer ${env.CRON_SECRET}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ claimed: 1, succeeded: 1, finish_failures: 0 });
    const { data: row } = await supabase
      .from('videos')
      .select('status, mux_playback_id')
      .eq('id', video.id)
      .single();
    expect(row).toMatchObject({ status: 'ready', mux_playback_id: 'pb_internal_job' });
  });
});
