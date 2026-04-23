import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { signMuxPayload } from '../helpers/muxSignature.js';
import { env } from '../../src/env.js';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestVideo,
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
  deleteAllWebhookEventsByPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan3-vid-idem-';
const EVENT_PREFIX = 'evt_plan3idem_';

describe('POST /webhooks/mux — idempotency', () => {
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
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('replaying the same event_id 3 times only applies the change once', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, status: 'waiting' });

    const app = createApp();
    const body = {
      type: 'video.upload.asset_created',
      id: `${EVENT_PREFIX}replay_${Date.now()}`,
      data: { id: 'asset_first', passthrough: video.id },
    };

    for (let i = 0; i < 3; i++) {
      const raw = JSON.stringify(body);
      const ts = Math.floor(Date.now() / 1000);
      const sig = signMuxPayload(raw, ts, env.MUX_WEBHOOK_SECRET);
      const res = await request(app)
        .post('/webhooks/mux')
        .set('Content-Type', 'application/json')
        .set('Mux-Signature', sig)
        .send(raw);
      expect(res.status).toBe(200);
    }

    const { data: vid } = await supabase
      .from('videos')
      .select('status, mux_asset_id')
      .eq('id', video.id)
      .single();
    expect(vid?.status).toBe('preparing');
    expect(vid?.mux_asset_id).toBe('asset_first');

    const { count } = await supabase
      .from('mux_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('event_id', body.id);
    expect(count).toBe(1);
  });
});
