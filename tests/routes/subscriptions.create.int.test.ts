import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { supabase } from '../../src/supabase.js';
import { makeStripeMock } from '../helpers/stripeMock.js';
import { createTestUser, deleteTestUser, signUserToken, type TestUser } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestSubscription,
  deleteTestStudiosBySlugPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan4-sub-create-';

describe('POST /subscriptions', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p4c_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
  });
  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p4c_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('400 invalid_body when studioId missing', async () => {
    const user = await createTestUser('plan4-sub-create-u');
    users.push(user);
    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_body');
  });

  it('400 invalid_body when studioId is not a UUID', async () => {
    const user = await createTestUser('plan4-sub-create-u');
    users.push(user);
    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({ studioId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_body');
  });

  it('401 when no auth header', async () => {
    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .post('/subscriptions')
      .send({ studioId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(401);
  });

  it('404 studio_not_found when studio does not exist', async () => {
    const user = await createTestUser('plan4-sub-create-u');
    users.push(user);
    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({ studioId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('studio_not_found');
  });

  it('lazily creates a Stripe customer and persists stripe_customer_id on profile', async () => {
    const owner = await createTestUser('plan4-sub-create-owner');
    const user = await createTestUser('plan4-sub-create-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}lazy-${Date.now()}`,
    });

    const stripe = makeStripeMock();
    stripe.customers.create.mockResolvedValueOnce({ id: 'cus_test_p4c_lazy' });

    const app = createApp({ stripe });
    await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({ studioId: studio.id });

    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: user.email, metadata: { user_id: user.id } }),
    );

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();
    expect(profile?.stripe_customer_id).toBe('cus_test_p4c_lazy');
  });

  it('reuses existing stripe_customer_id — does NOT call customers.create', async () => {
    const owner = await createTestUser('plan4-sub-create-owner');
    const user = await createTestUser('plan4-sub-create-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}reuse-${Date.now()}`,
    });
    await supabase.from('profiles').update({ stripe_customer_id: 'cus_preexisting' }).eq('id', user.id);

    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({ studioId: studio.id });
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('200 returns checkoutUrl and passes metadata + success/cancel URLs to Stripe', async () => {
    const owner = await createTestUser('plan4-sub-create-owner');
    const user = await createTestUser('plan4-sub-create-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}ok-${Date.now()}`,
    });

    const stripe = makeStripeMock();
    stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: 'cs_test_happy',
      url: 'https://checkout.stripe.com/c/pay/cs_test_happy',
    });

    const app = createApp({ stripe });
    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({ studioId: studio.id });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_happy');

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        line_items: [{ price: expect.stringContaining('price_test_'), quantity: 1 }],
        metadata: { user_id: user.id, studio_id: studio.id },
        subscription_data: { metadata: { user_id: user.id, studio_id: studio.id } },
        success_url: expect.stringContaining('/subscribe/success'),
        cancel_url: expect.stringContaining('/subscribe/cancel'),
      }),
    );
  });

  it('200 allowed after canceled subscription (resubscribe)', async () => {
    const owner = await createTestUser('plan4-sub-create-owner');
    const user = await createTestUser('plan4-sub-create-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}resub-${Date.now()}`,
    });
    await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      status: 'canceled',
      stripeSubId: `sub_test_p4c_cancel_${Date.now()}`,
    });

    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({ studioId: studio.id });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBeDefined();
  });

  it('502 stripe_error when checkout.sessions.create throws', async () => {
    const owner = await createTestUser('plan4-sub-create-owner');
    const user = await createTestUser('plan4-sub-create-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}502-${Date.now()}`,
    });

    const stripe = makeStripeMock();
    stripe.checkout.sessions.create.mockRejectedValueOnce(new Error('stripe is down'));

    const app = createApp({ stripe });
    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`)
      .send({ studioId: studio.id });
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe('stripe_error');
  });

  for (const status of ['active', 'past_due', 'incomplete'] as const) {
    it(`409 already_subscribed when existing subscription is ${status}`, async () => {
      const owner = await createTestUser('plan4-sub-create-owner');
      const user = await createTestUser('plan4-sub-create-u');
      users.push(owner, user);
      const studio = await insertTestStudio({
        ownerUserId: owner.id,
        slug: `${SLUG_PREFIX}${status}-${Date.now()}`,
      });
      await insertTestSubscription({
        userId: user.id,
        studioId: studio.id,
        status,
        stripeSubId: `sub_test_p4c_${status}_${Date.now()}`,
      });

      const stripe = makeStripeMock();
      const app = createApp({ stripe });
      const res = await request(app)
        .post('/subscriptions')
        .set('Authorization', `Bearer ${signUserToken(user)}`)
        .send({ studioId: studio.id });
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('already_subscribed');
    });
  }
});
