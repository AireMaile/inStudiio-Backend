import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { createTestUser, deleteTestUser, signUserToken } from '../helpers/testUsers.js';
import { insertTestStudio, deleteTestStudiosBySlugPrefix } from '../helpers/testData.js';

const SLUG_PREFIX = 'plan2-me-studios-';

describe('GET /me/studios', () => {
  const app = createApp();
  let aliceId: string, aliceEmail: string;
  let bobId: string;

  beforeAll(async () => {
    const alice = await createTestUser('plan2-me-studios-alice');
    aliceId = alice.id;
    aliceEmail = alice.email;
    const bob = await createTestUser('plan2-me-studios-bob');
    bobId = bob.id;
    await insertTestStudio({ ownerUserId: aliceId, slug: `${SLUG_PREFIX}alice-1`, name: 'Alice One' });
    await insertTestStudio({ ownerUserId: aliceId, slug: `${SLUG_PREFIX}alice-2`, name: 'Alice Two' });
    await insertTestStudio({ ownerUserId: bobId, slug: `${SLUG_PREFIX}bob-1`, name: 'Bob One' });
  });

  afterAll(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteTestUser(aliceId);
    await deleteTestUser(bobId);
  });

  it('returns 401 without Authorization header', async () => {
    const res = await request(app).get('/me/studios');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('returns only caller-owned studios, whitelisted fields, sorted asc', async () => {
    const token = signUserToken({ id: aliceId, email: aliceEmail });
    const res = await request(app).get('/me/studios').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.studios).toHaveLength(2);
    const slugs = res.body.studios.map((s: any) => s.slug);
    expect(slugs).toEqual([`${SLUG_PREFIX}alice-1`, `${SLUG_PREFIX}alice-2`]);
    const first = res.body.studios[0];
    expect(Object.keys(first).sort()).toEqual(
      ['created_at', 'description', 'id', 'name', 'price_monthly', 'slug'].sort(),
    );
    expect(first).not.toHaveProperty('owner_user_id');
    expect(first).not.toHaveProperty('stripe_product_id');
  });

  it('returns empty array for user with zero studios', async () => {
    const loner = await createTestUser('plan2-me-studios-loner');
    const token = signUserToken({ id: loner.id, email: loner.email });
    const res = await request(app).get('/me/studios').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.studios).toEqual([]);
    await deleteTestUser(loner.id);
  });
});
