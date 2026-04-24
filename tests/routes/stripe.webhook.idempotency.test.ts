import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { supabase } from '../../src/supabase.js';
import { makeStripeMock } from '../helpers/stripeMock.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  deleteTestStudiosBySlugPrefix,
  deleteAllStripeWebhookEventsByPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan4-sub-idem-';
const EVENT_PREFIX = 'evt_p4idem_';

describe('POST /webhooks/stripe — idempotency', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(EVENT_PREFIX);
  });
  afterEach(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(EVENT_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('replaying the same event_id 3 times only records one ledger row', async () => {
    const owner = await createTestUser('plan4-sub-idem-owner');
    users.push(owner);
    await insertTestStudio({ ownerUserId: owner.id, slug: `${SLUG_PREFIX}${Date.now()}` });

    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const event = {
      id: `${EVENT_PREFIX}replay_${Date.now()}`,
      type: 'ping.unknown',
      data: { object: {} },
    };
    const raw = JSON.stringify(event);

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=0,v1=dummy')
        .send(raw);
      expect(res.status).toBe(200);
    }

    const { count } = await supabase
      .from('stripe_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('event_id', event.id);
    expect(count).toBe(1);
  });
});
