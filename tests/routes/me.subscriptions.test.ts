import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { supabase } from '../../src/supabase.js';
import { makeStripeMock } from '../helpers/stripeMock.js';
import { createTestUser, deleteTestUser, signUserToken, type TestUser } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestSubscription,
  deleteTestStudiosBySlugPrefix,
  deleteAllStripeWebhookEventsByPrefix,
} from '../helpers/testData.js';
import { checkoutSessionCompleted } from '../fixtures/stripeEvents.js';

const SLUG_PREFIX = 'plan2-me-subs-';

describe('GET /me/subscriptions', () => {
  const app = createApp();
  let alice: TestUser;
  let bob: TestUser;
  let studio1Id: string, studio2Id: string, otherStudioId: string;

  beforeAll(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    alice = await createTestUser('plan2-me-subs-alice');
    bob = await createTestUser('plan2-me-subs-bob');

    const s1 = await insertTestStudio({ ownerUserId: bob.id, slug: `${SLUG_PREFIX}s1` });
    const s2 = await insertTestStudio({ ownerUserId: bob.id, slug: `${SLUG_PREFIX}s2` });
    const sOther = await insertTestStudio({ ownerUserId: bob.id, slug: `${SLUG_PREFIX}other` });
    studio1Id = s1.id;
    studio2Id = s2.id;
    otherStudioId = sOther.id;

    await insertTestSubscription({ userId: alice.id, studioId: studio1Id, status: 'active' });
    await insertTestSubscription({ userId: alice.id, studioId: studio2Id, status: 'canceled' });
    await insertTestSubscription({ userId: bob.id, studioId: otherStudioId, status: 'active' });
  });

  afterAll(async () => {
    const userIds = [alice?.id, bob?.id].filter((id): id is string => Boolean(id));
    if (userIds.length > 0) await supabase.from('subscriptions').delete().in('user_id', userIds);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    if (alice?.id) await deleteTestUser(alice.id);
    if (bob?.id) await deleteTestUser(bob.id);
  });

  it('returns 401 without Authorization header', async () => {
    const res = await request(app).get('/me/subscriptions');
    expect(res.status).toBe(401);
  });

  it('returns all owned subs, embedded studio, whitelisted fields', async () => {
    const res = await request(app).get('/me/subscriptions').set('Authorization', `Bearer ${signUserToken(alice)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(2);

    const sub = res.body.subscriptions.find((s: { status: string }) => s.status === 'active');
    expect(sub).toBeDefined();
    expect(sub.studio.id).toBe(studio1Id);
    expect(sub.status).toBe('active');
    expect(Object.keys(sub).sort()).toEqual(
      [
        'cancel_at_period_end',
        'current_period_end',
        'current_period_start',
        'id',
        'status',
        'studio',
      ].sort(),
    );
    expect(sub).not.toHaveProperty('studio_id');
    expect(sub).not.toHaveProperty('stripe_subscription_id');
    expect(sub).not.toHaveProperty('stripe_customer_id');
    expect(sub).not.toHaveProperty('user_id');
    expect(typeof sub.studio).toBe('object');
    expect(Array.isArray(sub.studio)).toBe(false);
    expect(Object.keys(sub.studio).sort()).toEqual(
      ['created_at', 'description', 'id', 'name', 'price_monthly', 'slug'].sort(),
    );
  });
});

const PLAN6_PREFIX = 'plan6-me-';
const PLAN6_EVENT_PREFIX = 'evt_p6me_';

describe('GET /me/subscriptions - Plan 6 filters, shape, polling', () => {
  const users: TestUser[] = [];

  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6_%');
    await deleteTestStudiosBySlugPrefix(PLAN6_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(PLAN6_EVENT_PREFIX);
  });

  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6_%');
    await deleteTestStudiosBySlugPrefix(PLAN6_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(PLAN6_EVENT_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('?status=canceled returns only canceled rows; active row excluded', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}s1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}s2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_act_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'canceled', stripeSubId: `sub_test_p6_can_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?status=canceled')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].status).toBe('canceled');
    expect(res.body.subscriptions[0].studio.id).toBe(studio2.id);
  });

  it('?studio_id=<uuid> filters to that studio only', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}f1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}f2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_f1_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'active', stripeSubId: `sub_test_p6_f2_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions?studio_id=${studio1.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].studio.id).toBe(studio1.id);
  });

  it('?status=active&studio_id=<uuid> composes both filters', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}c1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}c2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_c1_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'canceled', stripeSubId: `sub_test_p6_c2_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions?status=active&studio_id=${studio1.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].status).toBe('active');
    expect(res.body.subscriptions[0].studio.id).toBe(studio1.id);
  });

  it('?status= empty string is treated as no filter', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}e1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}e2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_e1_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'canceled', stripeSubId: `sub_test_p6_e2_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?status=')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(2);
  });

  it('?status=invalid returns 400 invalid_query', async () => {
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?status=invalid')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_query');
  });

  it('?studio_id=not-a-uuid returns 400 invalid_query', async () => {
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?studio_id=not-a-uuid')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_query');
  });

  it('response includes Cache-Control: no-store', async () => {
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('other users subscriptions are not visible', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const alice = await createTestUser(`${PLAN6_PREFIX}alice`);
    const bob = await createTestUser(`${PLAN6_PREFIX}bob`);
    users.push(owner, alice, bob);
    const studio = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}vis-${Date.now()}` });
    await insertTestSubscription({ userId: bob.id, studioId: studio.id, status: 'active', stripeSubId: `sub_test_p6_bob_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(alice)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(0);
  });

  it('stable sort: two subs with same current_period_end are ordered by id ASC', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}sort1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}sort2-${Date.now()}` });

    const sharedEnd = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    const subStart = new Date().toISOString();
    const { data: row1 } = await supabase.from('subscriptions').insert({
      user_id: user.id,
      studio_id: studio1.id,
      stripe_subscription_id: `sub_test_p6_sort1_${Date.now()}`,
      stripe_customer_id: 'cus_test_sort1',
      status: 'active',
      current_period_start: subStart,
      current_period_end: sharedEnd,
      cancel_at_period_end: false,
    }).select('id').single();
    const { data: row2 } = await supabase.from('subscriptions').insert({
      user_id: user.id,
      studio_id: studio2.id,
      stripe_subscription_id: `sub_test_p6_sort2_${Date.now()}`,
      stripe_customer_id: 'cus_test_sort2',
      status: 'active',
      current_period_start: subStart,
      current_period_end: sharedEnd,
      cancel_at_period_end: false,
    }).select('id').single();

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(2);
    const ids = res.body.subscriptions.map((s: { id: string }) => s.id);
    expect(ids).toEqual([row1!.id, row2!.id].sort());
  });
});

const POLL_SLUG_PREFIX = 'plan6-poll-';
const POLL_EVENT_PREFIX = 'evt_p6poll_';

describe('GET /me/subscriptions - polling-contract integration', () => {
  const users: TestUser[] = [];

  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6poll_%');
    await deleteTestStudiosBySlugPrefix(POLL_SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(POLL_EVENT_PREFIX);
  });

  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6poll_%');
    await deleteTestStudiosBySlugPrefix(POLL_SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(POLL_EVENT_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('empty before webhook, populated after checkout.session.completed replay', async () => {
    const user = await createTestUser(`${POLL_SLUG_PREFIX}u`);
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${POLL_SLUG_PREFIX}s-${Date.now()}`,
    });
    const subId = `sub_test_p6poll_${Date.now()}`;
    const custId = `cus_test_p6poll_${Date.now()}`;
    const periodStart = Math.floor(Date.now() / 1000);
    const periodEnd = periodStart + 30 * 86400;

    const stripe = makeStripeMock();
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subId,
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [{ current_period_start: periodStart, current_period_end: periodEnd }],
      },
    });

    const app = createApp({ stripe });
    const before = await request(app)
      .get(`/me/subscriptions?studio_id=${studio.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(before.status).toBe(200);
    expect(before.body.subscriptions).toHaveLength(0);

    const event = checkoutSessionCompleted({
      userId: user.id,
      studioId: studio.id,
      subId,
      custId,
      eventId: `${POLL_EVENT_PREFIX}${Date.now()}`,
    });
    const webhookRes = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=0,v1=dummy')
      .send(JSON.stringify(event));
    expect(webhookRes.status).toBe(200);

    const after = await request(app)
      .get(`/me/subscriptions?studio_id=${studio.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(after.status).toBe(200);
    expect(after.body.subscriptions).toHaveLength(1);
    const sub = after.body.subscriptions[0];
    expect(sub.status).toBe('active');
    expect(sub.studio.id).toBe(studio.id);
    expect(sub.cancel_at_period_end).toBe(false);
    expect(sub.current_period_end).toBeTruthy();
  });
});
