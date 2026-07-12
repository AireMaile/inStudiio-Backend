// Plan: close the anonymous-video-access hole (verified finding #1).
// New Mux assets must be created with the `signed` playback policy, and the
// read endpoints must hand entitled callers short-lived signed playback /
// thumbnail tokens — without them, stream.mux.com / image.mux.com refuse to
// serve, so a leaked playback id is no longer a paywall bypass.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/index.js';
import {
  createTestUser,
  deleteTestUser,
  signUserToken,
  type TestUser,
} from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestSubscription,
  insertTestVideo,
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
} from '../helpers/testData.js';
import { testMuxPublicKeyPem } from '../helpers/muxSigningKey.js';

const SLUG_PREFIX = 'plan6-vid-tok-';

function verifyToken(token: string, audience: 'v' | 't') {
  return jwt.verify(token, testMuxPublicKeyPem, {
    algorithms: ['RS256'],
    audience,
  }) as jwt.JwtPayload;
}

describe('signed playback (videos routes)', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
  });
  afterEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('POST /studios/:slug/videos creates Mux uploads with the signed playback policy', async () => {
    const owner = await createTestUser('plan6-vid-tok-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}create-${Date.now()}`,
    });

    let capturedCreateArgs: any = null;
    const fakeMux = {
      video: {
        uploads: {
          create: async (args: any) => {
            capturedCreateArgs = args;
            return { id: 'up_test', url: 'https://upload.example' };
          },
        },
        assets: { delete: async () => {} },
      },
      webhooks: { unwrap: () => { throw new Error('unused'); } },
    } as any;

    const app = createApp({ mux: fakeMux });
    const res = await request(app)
      .post(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`)
      .send({ title: 'signed policy check' });

    expect(res.status).toBe(201);
    expect(capturedCreateArgs?.new_asset_settings?.playback_policies).toEqual(['signed']);
  });

  it('GET /studios/:slug/videos attaches verifiable playback + thumbnail tokens to ready videos for subscribers', async () => {
    const owner = await createTestUser('plan6-vid-tok-owner');
    const viewer = await createTestUser('plan6-vid-tok-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}list-${Date.now()}`,
    });
    await insertTestSubscription({ userId: viewer.id, studioId: studio.id });
    const v = await insertTestVideo({
      studioId: studio.id,
      status: 'ready',
      muxPlaybackId: 'pb_tok_list',
    });

    const app = createApp();
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.videos).toHaveLength(1);
    const row = res.body.videos[0];
    expect(row.id).toBe(v.id);
    expect(verifyToken(row.playback_token, 'v').sub).toBe('pb_tok_list');
    expect(verifyToken(row.thumbnail_token, 't').sub).toBe('pb_tok_list');
  });

  it('does not attach tokens to legacy public playback ids', async () => {
    const owner = await createTestUser('plan6-vid-tok-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}public-${Date.now()}`,
    });
    await insertTestVideo({
      studioId: studio.id,
      status: 'ready',
      muxPlaybackId: 'pb_public_legacy',
      muxPlaybackPolicy: 'public',
    });

    const app = createApp();
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);

    expect(res.status).toBe(200);
    expect(res.body.videos[0].mux_playback_policy).toBe('public');
    expect(res.body.videos[0].playback_token).toBeUndefined();
    expect(res.body.videos[0].thumbnail_token).toBeUndefined();
  });

  it('GET /studios/:slug/videos gives the owner tokens too, but none for non-ready videos', async () => {
    const owner = await createTestUser('plan6-vid-tok-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}owner-${Date.now()}`,
    });
    await insertTestVideo({
      studioId: studio.id,
      status: 'ready',
      title: 'ready',
      muxPlaybackId: 'pb_tok_owner',
    });
    await insertTestVideo({ studioId: studio.id, status: 'preparing', title: 'preparing' });

    const app = createApp();
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const ready = res.body.videos.find((r: any) => r.title === 'ready');
    const preparing = res.body.videos.find((r: any) => r.title === 'preparing');
    expect(verifyToken(ready.playback_token, 'v').sub).toBe('pb_tok_owner');
    expect(preparing.playback_token).toBeUndefined();
    expect(preparing.thumbnail_token).toBeUndefined();
  });

  it('PATCH /videos/:id returns the same token contract as the GET routes', async () => {
    const owner = await createTestUser('plan6-vid-tok-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}patch-${Date.now()}`,
    });
    const v = await insertTestVideo({
      studioId: studio.id,
      status: 'ready',
      muxPlaybackId: 'pb_tok_patch',
    });

    const app = createApp();
    const res = await request(app)
      .patch(`/videos/${v.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`)
      .send({ title: 'renamed' });

    expect(res.status).toBe(200);
    // A client refreshing its model from the PATCH response must get a row it
    // can still play: tokens present, and the response uncacheable.
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(verifyToken(res.body.video.playback_token, 'v').sub).toBe('pb_tok_patch');
    expect(verifyToken(res.body.video.thumbnail_token, 't').sub).toBe('pb_tok_patch');
  });

  it('playback token expiry tracks video duration through the HTTP route', async () => {
    const owner = await createTestUser('plan6-vid-tok-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}ttl-${Date.now()}`,
    });
    const twoHours = 2 * 60 * 60;
    const v = await insertTestVideo({
      studioId: studio.id,
      status: 'ready',
      muxPlaybackId: 'pb_tok_ttl',
      durationSeconds: twoHours,
    });

    const app = createApp();
    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .get(`/videos/${v.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);

    expect(res.status).toBe(200);
    const payload = verifyToken(res.body.video.playback_token, 'v');
    // duration (2h) + 10min buffer, not the 1h default.
    expect(payload.exp).toBeGreaterThanOrEqual(before + twoHours + 10 * 60 - 5);
    expect(payload.exp).toBeLessThanOrEqual(before + twoHours + 10 * 60 + 10);
  });

  it('GET /videos/:id attaches tokens for an entitled subscriber', async () => {
    const owner = await createTestUser('plan6-vid-tok-owner');
    const viewer = await createTestUser('plan6-vid-tok-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}one-${Date.now()}`,
    });
    await insertTestSubscription({ userId: viewer.id, studioId: studio.id });
    const v = await insertTestVideo({
      studioId: studio.id,
      status: 'ready',
      muxPlaybackId: 'pb_tok_one',
    });

    const app = createApp();
    const res = await request(app)
      .get(`/videos/${v.id}`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(verifyToken(res.body.video.playback_token, 'v').sub).toBe('pb_tok_one');
    expect(verifyToken(res.body.video.thumbnail_token, 't').sub).toBe('pb_tok_one');
  });
});
