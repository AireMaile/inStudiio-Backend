import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { createTestUser, deleteTestUser } from '../helpers/testUsers.js';
import { insertTestStudio, deleteTestStudiosBySlugPrefix } from '../helpers/testData.js';

const SLUG_PREFIX = 'plan2-studios-';

describe('GET /studios', () => {
  const app = createApp();
  let ownerId: string;

  beforeAll(async () => {
    const owner = await createTestUser('plan2-studios-owner');
    ownerId = owner.id;
    await insertTestStudio({ ownerUserId: ownerId, slug: `${SLUG_PREFIX}alpha`, name: 'Alpha' });
    await insertTestStudio({ ownerUserId: ownerId, slug: `${SLUG_PREFIX}beta`, name: 'Beta' });
  });

  afterAll(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteTestUser(ownerId);
  });

  it('returns wrapped { studios, pagination }', async () => {
    const res = await request(app).get('/studios');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.studios)).toBe(true);
    expect(res.body.pagination).toMatchObject({ limit: 20, offset: 0 });
    expect(typeof res.body.pagination.total).toBe('number');
  });

  it('whitelists fields and excludes internal plumbing', async () => {
    const res = await request(app).get('/studios');
    expect(res.status).toBe(200);
    const seeded = res.body.studios.find((s: any) => s.slug === `${SLUG_PREFIX}alpha`);
    expect(seeded).toBeDefined();
    expect(Object.keys(seeded).sort()).toEqual(
      ['created_at', 'description', 'id', 'name', 'price_monthly', 'slug'].sort(),
    );
    expect(seeded).not.toHaveProperty('owner_user_id');
    expect(seeded).not.toHaveProperty('stripe_product_id');
    expect(seeded).not.toHaveProperty('stripe_price_id');
  });

  it('respects limit and offset query params', async () => {
    const res = await request(app).get('/studios?limit=1&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.studios).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ limit: 1, offset: 0 });
  });

  it('clamps limit above 100 to 100', async () => {
    const res = await request(app).get('/studios?limit=9999');
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });

  it('rejects non-numeric limit with 400', async () => {
    const res = await request(app).get('/studios?limit=foo');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });
});
