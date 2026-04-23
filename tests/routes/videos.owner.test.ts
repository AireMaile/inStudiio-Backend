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
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan3-vid-owner-';

function makeFakeMux() {
  const calls: Array<{ method: string; args: unknown }> = [];
  return {
    calls,
    video: {
      uploads: {
        create: async (args: any) => {
          calls.push({ method: 'uploads.create', args });
          return { id: 'upl_fake_' + Date.now(), url: 'https://upload.mux.com/fake' };
        },
      },
      assets: {
        delete: async (id: string) => {
          calls.push({ method: 'assets.delete', args: id });
        },
      },
    },
    webhooks: {
      unwrap: () => {
        throw new Error('not used in owner tests');
      },
    },
  } as any;
}

describe('POST /studios/:slug/videos', () => {
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

  it('creates a video row in waiting + calls mux uploads.create with expected args', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}happy-${Date.now()}`,
    });
    const mux = makeFakeMux();
    const app = createApp({ mux });

    const res = await request(app)
      .post(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`)
      .send({ title: 'Morning Flow', description: 'Gentle flow.' });

    expect(res.status).toBe(201);
    expect(res.body.video).toMatchObject({
      title: 'Morning Flow',
      description: 'Gentle flow.',
      status: 'waiting',
      studio_id: studio.id,
    });
    expect(res.body.video.mux_upload_id).toBeUndefined();
    expect(res.body.video.mux_asset_id).toBeUndefined();
    expect(res.body.uploadUrl).toBe('https://upload.mux.com/fake');
    expect(res.body.uploadId).toMatch(/^upl_fake_/);

    expect(mux.calls).toHaveLength(1);
    const args = mux.calls[0].args as any;
    expect(args.cors_origin).toBe('*');
    expect(args.test).toBe(true);
    expect(args.new_asset_settings.playback_policies).toEqual(['public']);
    expect(args.new_asset_settings.passthrough).toBe(res.body.video.id);
  });

  it('returns 401 without Authorization', async () => {
    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .post('/studios/whatever/videos')
      .send({ title: 'X' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when slug does not exist', async () => {
    const caller = await createTestUser('plan3-vid-owner');
    users.push(caller);
    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .post(`/studios/${SLUG_PREFIX}does-not-exist-${Date.now()}/videos`)
      .set('Authorization', `Bearer ${signUserToken(caller)}`)
      .send({ title: 'X' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not the owner', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    const intruder = await createTestUser('plan3-vid-intruder');
    users.push(owner, intruder);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}forbid-${Date.now()}`,
    });
    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .post(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(intruder)}`)
      .send({ title: 'X' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when title is missing', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}bad-${Date.now()}`,
    });
    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .post(`/studios/${studio.slug}/videos`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('PATCH /videos/:id', () => {
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

  it('updates title/description for owner, returns whitelisted projection', async () => {
    const { insertTestVideo } = await import('../helpers/testData.js');
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}patch-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, title: 'Old', status: 'ready' });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .patch(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`)
      .send({ title: 'New title', description: 'new desc' });

    expect(res.status).toBe(200);
    expect(res.body.video.title).toBe('New title');
    expect(res.body.video.description).toBe('new desc');
    expect(res.body.video.mux_upload_id).toBeUndefined();
    expect(res.body.video.mux_asset_id).toBeUndefined();
  });

  it('returns 400 when body is empty', async () => {
    const { insertTestVideo } = await import('../helpers/testData.js');
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}patch-empty-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .patch(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-owner', async () => {
    const { insertTestVideo } = await import('../helpers/testData.js');
    const owner = await createTestUser('plan3-vid-owner');
    const intruder = await createTestUser('plan3-vid-intruder');
    users.push(owner, intruder);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}patch-403-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .patch(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(intruder)}`)
      .send({ title: 'nope' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown video id', async () => {
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .patch('/videos/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${signUserToken(owner)}`)
      .send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /videos/:id', () => {
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

  it('calls mux.assets.delete when mux_asset_id set, deletes row, returns 204', async () => {
    const { insertTestVideo } = await import('../helpers/testData.js');
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}del-${Date.now()}`,
    });
    const video = await insertTestVideo({
      studioId: studio.id,
      muxAssetId: 'asset_fake_123',
      status: 'ready',
    });

    const mux = makeFakeMux();
    const app = createApp({ mux });
    const res = await request(app)
      .delete(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);

    expect(res.status).toBe(204);
    expect(mux.calls.some((c: { method: string; args: unknown }) => c.method === 'assets.delete' && c.args === 'asset_fake_123')).toBe(true);
  });

  it('skips mux call when mux_asset_id is null, still returns 204', async () => {
    const { insertTestVideo } = await import('../helpers/testData.js');
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}del-nomux-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, muxAssetId: null, status: 'waiting' });

    const mux = makeFakeMux();
    const app = createApp({ mux });
    const res = await request(app)
      .delete(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);

    expect(res.status).toBe(204);
    expect(mux.calls.find((c: { method: string; args: unknown }) => c.method === 'assets.delete')).toBeUndefined();
  });

  it('returns 204 even when Mux asset delete throws (best-effort)', async () => {
    const { insertTestVideo } = await import('../helpers/testData.js');
    const owner = await createTestUser('plan3-vid-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}del-muxerr-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id, muxAssetId: 'asset_boom' });

    const mux: any = {
      video: {
        uploads: { create: async () => ({ id: 'x', url: 'y' }) },
        assets: {
          delete: async () => {
            throw new Error('mux down');
          },
        },
      },
      webhooks: { unwrap: () => { throw new Error('unused'); } },
    };
    const app = createApp({ mux });
    const res = await request(app)
      .delete(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(owner)}`);
    expect(res.status).toBe(204);
  });

  it('returns 403 for non-owner', async () => {
    const { insertTestVideo } = await import('../helpers/testData.js');
    const owner = await createTestUser('plan3-vid-owner');
    const intruder = await createTestUser('plan3-vid-intruder');
    users.push(owner, intruder);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}del-403-${Date.now()}`,
    });
    const video = await insertTestVideo({ studioId: studio.id });

    const app = createApp({ mux: makeFakeMux() });
    const res = await request(app)
      .delete(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${signUserToken(intruder)}`);
    expect(res.status).toBe(403);
  });
});
