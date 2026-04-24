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
} from '../helpers/testData.js';

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
