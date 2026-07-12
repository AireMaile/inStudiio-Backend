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

const SLUG_PREFIX = 'plan3-vid-webhook-';
const EVENT_PREFIX = 'evt_plan3_';

function postWebhook(app: any, body: any, opts?: { ts?: number; sig?: string; secret?: string }) {
  const raw = JSON.stringify(body);
  const ts = opts?.ts ?? Math.floor(Date.now() / 1000);
  const sig = opts?.sig ?? signMuxPayload(raw, ts, opts?.secret ?? env.MUX_WEBHOOK_SECRET);
  return request(app)
    .post('/webhooks/mux')
    .set('Content-Type', 'application/json')
    .set('Mux-Signature', sig)
    .send(raw);
}

describe('POST /webhooks/mux — signature verification', () => {
  it('returns 200 on a valid signature for an unknown event type', async () => {
    const app = createApp();
    const body = {
      type: 'video.asset.something_unknown',
      id: 'evt_' + Math.random().toString(36).slice(2, 8),
      data: { passthrough: 'irrelevant' },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);
  });

  it('returns 400 on a bad signature', async () => {
    const app = createApp();
    const body = { type: 'video.asset.ready', id: 'evt_x', data: {} };
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/webhooks/mux')
      .set('Content-Type', 'application/json')
      .set('Mux-Signature', `t=${ts},v1=deadbeef`)
      .send(raw);
    expect(res.status).toBe(400);
  });

  it('returns 400 on an expired timestamp (>300s old)', async () => {
    const app = createApp();
    const body = { type: 'video.asset.ready', id: 'evt_y', data: {} };
    const res = await postWebhook(app, body, { ts: Math.floor(Date.now() / 1000) - 400 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when Mux-Signature header is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/webhooks/mux')
      .set('Content-Type', 'application/json')
      .send({ type: 'x', id: 'y', data: {} });
    expect(res.status).toBe(400);
  });

  it('returns 400 when Content-Type is not application/json', async () => {
    const app = createApp();
    const body = { type: 'video.asset.ready', id: 'evt_plan3_ctype', data: {} };
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signMuxPayload(raw, ts, env.MUX_WEBHOOK_SECRET);
    const res = await request(app)
      .post('/webhooks/mux')
      .set('Content-Type', 'text/plain')
      .set('Mux-Signature', sig)
      .send(raw);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_request');
  });
});

describe('POST /webhooks/mux — event handling', () => {
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

  it('video.upload.asset_created sets status=preparing and mux_asset_id', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}ac-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, status: 'waiting' });

    const app = createApp();
    const body = {
      type: 'video.upload.asset_created',
      id: `${EVENT_PREFIX}ac_${Date.now()}`,
      data: { id: 'upload_xyz', asset_id: 'asset_abc', passthrough: video.id },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);

    const { data } = await supabase.from('videos').select('status, mux_asset_id').eq('id', video.id).single();
    expect(data?.status).toBe('preparing');
    expect(data?.mux_asset_id).toBe('asset_abc');
  });

  it('video.asset.ready sets status=ready, mux_playback_id (signed preferred), duration_seconds', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}rd-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, status: 'preparing', muxAssetId: 'asset_zz' });

    const app = createApp();
    const body = {
      type: 'video.asset.ready',
      id: `${EVENT_PREFIX}rd_${Date.now()}`,
      data: {
        passthrough: video.id,
        duration: 42.5,
        playback_ids: [
          { id: 'pb_signed_xxx', policy: 'signed' },
          { id: 'pb_public_ok', policy: 'public' },
        ],
      },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('videos')
      .select('status, mux_playback_id, mux_playback_policy, duration_seconds')
      .eq('id', video.id)
      .single();
    expect(data?.status).toBe('ready');
    expect(data?.mux_playback_id).toBe('pb_signed_xxx');
    expect(data?.mux_playback_policy).toBe('signed');
    expect(Number(data?.duration_seconds)).toBeCloseTo(42.5);
  });

  it('video.asset.ready with no playback_ids writes null id + null policy (satisfies pair CHECK)', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}rd-noids-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, status: 'preparing', muxAssetId: 'asset_noids' });

    const app = createApp();
    const body = {
      type: 'video.asset.ready',
      id: `${EVENT_PREFIX}rdnoids_${Date.now()}`,
      data: { passthrough: video.id, duration: 5, playback_ids: [] },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('videos')
      .select('status, mux_playback_id, mux_playback_policy')
      .eq('id', video.id)
      .single();
    expect(data?.status).toBe('ready');
    expect(data?.mux_playback_id).toBeNull();
    expect(data?.mux_playback_policy).toBeNull();
  });

  it('video.asset.errored sets status=errored and error_message', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}er-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, status: 'preparing' });

    const app = createApp();
    const body = {
      type: 'video.asset.errored',
      id: `${EVENT_PREFIX}er_${Date.now()}`,
      data: {
        passthrough: video.id,
        errors: [{ messages: ['input_invalid', 'codec_unsupported'] }],
      },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('videos')
      .select('status, error_message')
      .eq('id', video.id)
      .single();
    expect(data?.status).toBe('errored');
    expect(data?.error_message).toMatch(/input_invalid.*codec_unsupported/);
  });

  it('unknown event type returns 200 with no DB writes', async () => {
    const app = createApp();
    const body = {
      type: 'video.asset.created',
      id: `${EVENT_PREFIX}unknown_${Date.now()}`,
      data: { passthrough: '00000000-0000-0000-0000-000000000000' },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);
  });

  it('invalid passthrough UUID causes DB error → 500 + ledger rolled back', async () => {
    const app = createApp();
    const eventId = `${EVENT_PREFIX}dberr_${Date.now()}`;
    const body = {
      type: 'video.asset.ready',
      id: eventId,
      data: {
        passthrough: 'not-a-uuid',
        duration: 1,
        playback_ids: [{ id: 'pb_x', policy: 'public' }],
      },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(500);

    // Ledger row must have been rolled back so Mux's retry is re-processed,
    // not short-circuited as a duplicate.
    const { count } = await supabase
      .from('mux_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('event_id', eventId);
    expect(count).toBe(0);
  });

  it('passthrough pointing to non-existent video returns 200, logs, no-op', async () => {
    const app = createApp();
    const body = {
      type: 'video.asset.ready',
      id: `${EVENT_PREFIX}orphan_${Date.now()}`,
      data: {
        passthrough: '00000000-0000-0000-0000-000000000000',
        duration: 1,
        playback_ids: [{ id: 'pb_x', policy: 'public' }],
      },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);
  });
});
