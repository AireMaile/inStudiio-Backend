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
    await insertTestStudio({
      ownerUserId: ownerId,
      slug: `${SLUG_PREFIX}branded`,
      name: 'Branded',
      imageUrl: 'https://example.com/avatar.jpg',
      backgroundImageUrl: 'https://example.com/hero.jpg',
      website: 'https://example.com',
      instagramUrl: 'https://instagram.com/example',
    });
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
      [
        'background_image_url',
        'created_at',
        'description',
        'id',
        'image_url',
        'instagram_url',
        'name',
        'price_monthly',
        'slug',
        'website',
      ].sort(),
    );
    expect(seeded).not.toHaveProperty('owner_user_id');
    expect(seeded).not.toHaveProperty('stripe_product_id');
    expect(seeded).not.toHaveProperty('stripe_price_id');
  });

  it('passes branding values through and emits null when unset', async () => {
    const res = await request(app).get('/studios?limit=100');
    expect(res.status).toBe(200);
    const branded = res.body.studios.find((s: any) => s.slug === `${SLUG_PREFIX}branded`);
    const plain = res.body.studios.find((s: any) => s.slug === `${SLUG_PREFIX}alpha`);
    expect(branded).toMatchObject({
      image_url: 'https://example.com/avatar.jpg',
      background_image_url: 'https://example.com/hero.jpg',
      website: 'https://example.com',
      instagram_url: 'https://instagram.com/example',
    });
    expect(plain.image_url).toBeNull();
    expect(plain.background_image_url).toBeNull();
    expect(plain.website).toBeNull();
    expect(plain.instagram_url).toBeNull();
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
