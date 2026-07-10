import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, signUserToken, type TestUser } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestSubscription,
  deleteTestStudiosBySlugPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan6-me-detail-';

describe('GET /me/subscriptions/:id', () => {
  const users: TestUser[] = [];

  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6d_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
  });

  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6d_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('200 returns single subscription with embedded studio', async () => {
    const owner = await createTestUser(`${SLUG_PREFIX}owner`);
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}ok-${Date.now()}`,
    });
    const sub = await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      status: 'active',
      stripeSubId: `sub_test_p6d_ok_${Date.now()}`,
    });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions/${sub.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscription.id).toBe(sub.id);
    expect(res.body.subscription.status).toBe('active');
    expect(typeof res.body.subscription.studio).toBe('object');
    expect(Array.isArray(res.body.subscription.studio)).toBe(false);
    expect(res.body.subscription.studio.id).toBe(studio.id);
    expect(res.body.subscription.studio.name).toBeDefined();
    expect(res.body.subscription.studio.slug).toBeDefined();
    expect(res.body.subscription.studio.price_monthly).toBeDefined();
    expect(res.body.subscription.studio.created_at).toBeDefined();
  });

  it('response includes Cache-Control: no-store', async () => {
    const owner = await createTestUser(`${SLUG_PREFIX}owner`);
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}cc-${Date.now()}`,
    });
    const sub = await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      stripeSubId: `sub_test_p6d_cc_${Date.now()}`,
    });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions/${sub.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('401 when no Authorization header', async () => {
    const app = createApp();
    const res = await request(app).get('/me/subscriptions/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });

  it('404 subscription_not_found when id is malformed', async () => {
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions/not-a-uuid')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });

  it('404 subscription_not_found when id does not exist', async () => {
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });

  it('404 subscription_not_found when id belongs to another user', async () => {
    const owner = await createTestUser(`${SLUG_PREFIX}owner`);
    const other = await createTestUser(`${SLUG_PREFIX}other`);
    const me = await createTestUser(`${SLUG_PREFIX}me`);
    users.push(owner, other, me);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}leak-${Date.now()}`,
    });
    const otherSub = await insertTestSubscription({
      userId: other.id,
      studioId: studio.id,
      stripeSubId: `sub_test_p6d_leak_${Date.now()}`,
    });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions/${otherSub.id}`)
      .set('Authorization', `Bearer ${signUserToken(me)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });
});
