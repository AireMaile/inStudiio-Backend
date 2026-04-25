import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
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

const SLUG_PREFIX = 'plan3-vid-read-';

function makeFakeMux() {
  return {
    video: { uploads: { create: async () => ({ id: 'x', url: 'y' }) }, assets: { delete: async () => {} } },
    webhooks: { unwrap: () => { throw new Error('unused'); } },
  } as any;
}

describe('GET /studios/:slug/videos', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteTestVideosByStudioPrefix('plan4-vid-page-');
    await deleteTestStudiosBySlugPrefix('plan4-vid-page-');
  });
  afterEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteTestVideosByStudioPrefix('plan4-vid-page-');
    await deleteTestStudiosBySlugPrefix('plan4-vid-page-');
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('owner sees videos in all statuses', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}owner-all-${Date.now()}`,
    });
    await insertTestVideo({ studioId: studio.id, status: 'ready', title: 'r' });
    await insertTestVideo({ studioId: studio.id, status: 'preparing', title: 'p' });
    await insertTestVideo({ studioId: studio.id, status: 'errored', title: 'e', errorMessage: 'boom' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);

    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(3);
    expect(res.body.videos.every((v: any) => v.mux_upload_id === undefined)).toBe(true);
    expect(res.body.videos.every((v: any) => v.mux_asset_id === undefined)).toBe(true);
  });

  it('active subscriber sees only ready videos', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    const viewer = await createTestUser('plan3-vid-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}sub-ready-${Date.now()}`,
    });
    await insertTestSubscription({ userId: viewer.id, studioId: studio.id });
    await insertTestVideo({ studioId: studio.id, status: 'ready', title: 'r1' });
    await insertTestVideo({ studioId: studio.id, status: 'preparing', title: 'p' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].title).toBe('r1');
  });

  it('returns 403 for non-owner non-subscriber', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    const viewer = await createTestUser('plan3-vid-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}nosub-${Date.now()}`,
    });
    await insertTestVideo({ studioId: studio.id, status: 'ready' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toMatch(/subscription/i);
  });

  it('returns 401 without auth', async () => {
    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app).get(`/studios/anything/videos`);
    expect(res.status).toBe(401);
  });

  it('returns 404 when studio slug does not exist', async () => {
    const viewer = await createTestUser('plan3-vid-viewer');
    users.push(viewer);
    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/studios/${SLUG_PREFIX}nope-${Date.now()}/videos`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);
    expect(res.status).toBe(404);
  });

  it('GET /studios/:slug/videos respects limit', async () => {
    const owner = await createTestUser('plan4-vid-page-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `plan4-vid-page-limit-${Date.now()}`,
    });
    for (let i = 0; i < 5; i++) {
      await insertTestVideo({ studioId: studio.id, status: 'ready' });
    }
    const app = createApp();
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos?limit=3`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);
    expect(res.status).toBe(200);
    expect(res.body.videos.length).toBe(3);
    expect(typeof res.body.nextCursor).toBe('string');
  });

  it('GET /studios/:slug/videos respects cursor for next page', async () => {
    const owner = await createTestUser('plan4-vid-page-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `plan4-vid-page-cursor-${Date.now()}`,
    });
    for (let i = 0; i < 4; i++) {
      await insertTestVideo({ studioId: studio.id, status: 'ready' });
      await new Promise((r) => setTimeout(r, 5));
    }
    const app = createApp();
    const page1 = await request(app)
      .get(`/studios/${studio.slug}/videos?limit=2`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);
    expect(page1.status).toBe(200);
    expect(page1.body.videos.length).toBe(2);
    const cursor = page1.body.nextCursor;

    const page2 = await request(app)
      .get(`/studios/${studio.slug}/videos?limit=2&cursor=${encodeURIComponent(cursor)}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);
    expect(page2.status).toBe(200);
    expect(page2.body.videos.length).toBe(2);
    const page1Ids = page1.body.videos.map((v: any) => v.id);
    const page2Ids = page2.body.videos.map((v: any) => v.id);
    for (const id of page2Ids) expect(page1Ids).not.toContain(id);
  });

  it('GET /studios/:slug/videos caps limit to 100', async () => {
    const owner = await createTestUser('plan4-vid-page-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `plan4-vid-page-cap-${Date.now()}`,
    });
    const app = createApp();
    const res = await request(app)
      .get(`/studios/${studio.slug}/videos?limit=9999`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_request');
  });
});

describe('GET /videos/:id', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteTestVideosByStudioPrefix('plan4-vid-read-leak-');
    await deleteTestStudiosBySlugPrefix('plan4-vid-read-leak-');
  });
  afterEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteTestVideosByStudioPrefix('plan4-vid-read-leak-');
    await deleteTestStudiosBySlugPrefix('plan4-vid-read-leak-');
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('owner sees any status; internal fields hidden', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}one-owner-${Date.now()}`,
    });
    const v = await insertTestVideo({ studioId: studio.id, status: 'preparing' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/videos/${v.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);
    expect(res.status).toBe(200);
    expect(res.body.video.status).toBe('preparing');
    expect(res.body.video.mux_upload_id).toBeUndefined();
  });

  it('subscriber gets 404 when video is not ready', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    const viewer = await createTestUser('plan3-vid-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}sub-404-${Date.now()}`,
    });
    await insertTestSubscription({ userId: viewer.id, studioId: studio.id });
    const v = await insertTestVideo({ studioId: studio.id, status: 'preparing' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/videos/${v.id}`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);
    expect(res.status).toBe(404);
  });

  it('subscriber sees ready video', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    const viewer = await createTestUser('plan3-vid-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}sub-ok-${Date.now()}`,
    });
    await insertTestSubscription({ userId: viewer.id, studioId: studio.id });
    const v = await insertTestVideo({ studioId: studio.id, status: 'ready' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/videos/${v.id}`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);
    expect(res.status).toBe(200);
  });

  it('non-owner non-subscriber gets 404', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    const intruder = await createTestUser('plan3-vid-intruder');
    users.push(owner, intruder);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}one-403-${Date.now()}`,
    });
    const v = await insertTestVideo({ studioId: studio.id, status: 'ready' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .get(`/videos/${v.id}`)
      .set('Authorization', `Bearer ${signUserToken(intruder)}`);
    expect(res.status).toBe(404);
  });

  it('GET /videos/:id returns 404 (not 403) when caller is non-owner + non-subscriber', async () => {
    const owner = await createTestUser('plan4-vid-read-owner');
    const viewer = await createTestUser('plan4-vid-read-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `plan4-vid-read-leak-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, status: 'ready' });

    const app = createApp();
    const res = await request(app)
      .get(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(viewer)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('GET /videos/:id with non-UUID id returns 400 bad_request', async () => {
    const user = await createTestUser('plan4-vid-badid');
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/videos/not-a-uuid')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_request');
  });
});
