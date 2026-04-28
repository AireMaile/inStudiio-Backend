import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { signStripePayload } from '../helpers/stripeSignature.js';
import { makeStripeMock } from '../helpers/stripeMock.js';
import { env } from '../../src/env.js';
import {
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
  deleteAllStripeWebhookEventsByPrefix,
  insertTestStudio,
} from '../helpers/testData.js';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  checkoutSessionCompleted,
  invoicePaymentSucceeded,
  invoicePaymentFailed,
  customerSubscriptionUpdated,
  customerSubscriptionDeleted,
} from '../fixtures/stripeEvents.js';

const SLUG_PREFIX = 'plan4-sub-wh-';
const EVENT_PREFIX = 'evt_p4wh_';

describe('POST /webhooks/stripe — signature verification', () => {
  beforeEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(EVENT_PREFIX);
  });
  afterEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(EVENT_PREFIX);
  });

  it('returns 200 on valid signature for an unhandled event type', async () => {
    const stripe = makeStripeMock({ verifySignatures: true, secret: env.STRIPE_WEBHOOK_SECRET });
    const app = createApp({ stripe });
    const body = { id: `${EVENT_PREFIX}noop_${Date.now()}`, type: 'ping.unknown', data: { object: {} } };
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripePayload(raw, ts, env.STRIPE_WEBHOOK_SECRET);
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sig)
      .send(raw);
    expect(res.status).toBe(200);
  });

  it('returns 400 on bad signature', async () => {
    const stripe = makeStripeMock({ verifySignatures: true, secret: env.STRIPE_WEBHOOK_SECRET });
    const app = createApp({ stripe });
    const body = { id: `${EVENT_PREFIX}bad_${Date.now()}`, type: 'ping.unknown', data: { object: {} } };
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${ts},v1=deadbeef`)
      .send(raw);
    expect(res.status).toBe(400);
  });

  it('returns 400 when Stripe-Signature header is missing', async () => {
    const stripe = makeStripeMock({ verifySignatures: true, secret: env.STRIPE_WEBHOOK_SECRET });
    const app = createApp({ stripe });
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send({ type: 'x', id: 'y', data: { object: {} } });
    expect(res.status).toBe(400);
  });
});

describe('POST /webhooks/stripe — event handling', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(EVENT_PREFIX);
    // Ensure we leave no stale subs from prior runs:
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p4wh_%');
  });
  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p4wh_%');
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(EVENT_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  async function postEvent(app: any, event: any) {
    const raw = JSON.stringify(event);
    return request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=0,v1=dummy')
      .send(raw);
  }

  it('checkout.session.completed upserts a new subscription row', async () => {
    const user = await createTestUser('plan4-sub-wh-u');
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${SLUG_PREFIX}cs-${Date.now()}`,
    });

    const stripe = makeStripeMock();
    const subId = `sub_test_p4wh_${Date.now()}`;
    const custId = `cus_test_p4wh_${Date.now()}`;
    const periodStart = Math.floor(Date.now() / 1000);
    const periodEnd = periodStart + 30 * 86400;
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subId,
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [{ current_period_start: periodStart, current_period_end: periodEnd }],
      },
    });

    const event = checkoutSessionCompleted({
      userId: user.id,
      studioId: studio.id,
      subId,
      custId,
    });

    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('subscriptions')
      .select('status, stripe_subscription_id, stripe_customer_id, cancel_at_period_end')
      .eq('user_id', user.id)
      .eq('studio_id', studio.id)
      .single();
    expect(data?.status).toBe('active');
    expect(data?.stripe_subscription_id).toBe(subId);
    expect(data?.stripe_customer_id).toBe(custId);
    expect(data?.cancel_at_period_end).toBe(false);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith(subId);
  });

  it('checkout.session.completed with missing metadata on session AND subscription is a 200 noop', async () => {
    const stripe = makeStripeMock();
    // Default mock subscription has no metadata; with session metadata also
    // null, the fallback should fail and the handler should noop.
    const event = {
      id: `${EVENT_PREFIX}cs_nometa_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_x',
          subscription: 'sub_test_p4wh_x',
          customer: 'cus_test_p4wh_x',
          metadata: null,
        },
      },
    };
    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ noop: true });
  });

  it('invoice.payment_succeeded with billing_reason=subscription_cycle updates period', async () => {
    const user = await createTestUser('plan4-sub-wh-u');
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${SLUG_PREFIX}inv-ok-${Date.now()}`,
    });
    const subId = `sub_test_p4wh_${Date.now()}`;
    const prevStart = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const prevEnd = new Date().toISOString();
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      studio_id: studio.id,
      stripe_subscription_id: subId,
      stripe_customer_id: `cus_test_p4wh_${Date.now()}`,
      status: 'active',
      current_period_start: prevStart,
      current_period_end: prevEnd,
      cancel_at_period_end: false,
    });

    const newStart = Math.floor(Date.now() / 1000);
    const newEnd = newStart + 30 * 86400;
    const stripe = makeStripeMock();
    const event = invoicePaymentSucceeded({
      subId,
      billingReason: 'subscription_cycle',
      periodStart: newStart,
      periodEnd: newEnd,
    });

    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('stripe_subscription_id', subId)
      .single();
    expect(data?.status).toBe('active');
    expect(new Date(data!.current_period_end).getTime()).toBe(newEnd * 1000);
  });

  it('invoice.payment_succeeded with billing_reason=subscription_create is a noop', async () => {
    const stripe = makeStripeMock();
    const event = invoicePaymentSucceeded({
      subId: `sub_test_p4wh_doesnt_matter_${Date.now()}`,
      billingReason: 'subscription_create',
    });
    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);
  });

  it('invoice.payment_failed sets status=past_due', async () => {
    const user = await createTestUser('plan4-sub-wh-u');
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${SLUG_PREFIX}inv-fail-${Date.now()}`,
    });
    const subId = `sub_test_p4wh_${Date.now()}`;
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      studio_id: studio.id,
      stripe_subscription_id: subId,
      stripe_customer_id: `cus_test_p4wh_${Date.now()}`,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      cancel_at_period_end: false,
    });

    const stripe = makeStripeMock();
    const event = invoicePaymentFailed({ subId });
    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('stripe_subscription_id', subId)
      .single();
    expect(data?.status).toBe('past_due');
  });

  it('customer.subscription.updated syncs cancel_at_period_end + status + period', async () => {
    const user = await createTestUser('plan4-sub-wh-u');
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${SLUG_PREFIX}sub-upd-${Date.now()}`,
    });
    const subId = `sub_test_p4wh_${Date.now()}`;
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      studio_id: studio.id,
      stripe_subscription_id: subId,
      stripe_customer_id: `cus_test_p4wh_${Date.now()}`,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      cancel_at_period_end: false,
    });

    const stripe = makeStripeMock();
    const event = customerSubscriptionUpdated({
      subId,
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('subscriptions')
      .select('status, cancel_at_period_end')
      .eq('stripe_subscription_id', subId)
      .single();
    expect(data?.status).toBe('active');
    expect(data?.cancel_at_period_end).toBe(true);
  });

  it('customer.subscription.deleted sets status=canceled', async () => {
    const user = await createTestUser('plan4-sub-wh-u');
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${SLUG_PREFIX}sub-del-${Date.now()}`,
    });
    const subId = `sub_test_p4wh_${Date.now()}`;
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      studio_id: studio.id,
      stripe_subscription_id: subId,
      stripe_customer_id: `cus_test_p4wh_${Date.now()}`,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      cancel_at_period_end: true,
    });

    const stripe = makeStripeMock();
    const event = customerSubscriptionDeleted({ subId });
    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('subscriptions')
      .select('status, cancel_at_period_end')
      .eq('stripe_subscription_id', subId)
      .single();
    expect(data?.status).toBe('canceled');
    expect(data?.cancel_at_period_end).toBe(false);
  });
});
