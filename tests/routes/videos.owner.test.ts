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
