import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, signUserToken } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestSubscription,
  deleteTestStudiosBySlugPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan2-me-subs-';

describe('GET /me/subscriptions', () => {
  const app = createApp();
  let aliceId: string, aliceEmail: string;
  let bobId: string;
  let studio1Id: string, studio2Id: string, otherStudioId: string;

  beforeAll(async () => {
    const alice = await createTestUser('plan2-me-subs-alice');
    aliceId = alice.id;
    aliceEmail = alice.email;
    const bob = await createTestUser('plan2-me-subs-bob');
    bobId = bob.id;

    const s1 = await insertTestStudio({ ownerUserId: bobId, slug: `${SLUG_PREFIX}s1` });
    const s2 = await insertTestStudio({ ownerUserId: bobId, slug: `${SLUG_PREFIX}s2` });
    const sOther = await insertTestStudio({ ownerUserId: bobId, slug: `${SLUG_PREFIX}other` });
    studio1Id = s1.id;
    studio2Id = s2.id;
    otherStudioId = sOther.id;

    await insertTestSubscription({ userId: aliceId, studioId: studio1Id, status: 'active' });
    await insertTestSubscription({ userId: aliceId, studioId: studio2Id, status: 'canceled' });
    await insertTestSubscription({ userId: bobId, studioId: otherStudioId, status: 'active' });
  });

  afterAll(async () => {
    // Explicit sub cleanup first in case cascade isn't set up.
    await supabase.from('subscriptions').delete().in('user_id', [aliceId, bobId]);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteTestUser(aliceId);
    await deleteTestUser(bobId);
  });

  it('returns 401 without Authorization header', async () => {
    const res = await request(app).get('/me/subscriptions');
    expect(res.status).toBe(401);
  });

  it('returns only caller-owned active subs, whitelisted fields', async () => {
    const token = signUserToken({ id: aliceId, email: aliceEmail });
    const res = await request(app).get('/me/subscriptions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    const sub = res.body.subscriptions[0];
    expect(sub.studio_id).toBe(studio1Id);
    expect(sub.status).toBe('active');
    expect(Object.keys(sub).sort()).toEqual(
      [
        'cancel_at_period_end',
        'current_period_end',
        'current_period_start',
        'id',
        'status',
        'studio_id',
      ].sort(),
    );
    expect(sub).not.toHaveProperty('stripe_subscription_id');
    expect(sub).not.toHaveProperty('stripe_customer_id');
    expect(sub).not.toHaveProperty('user_id');
  });
});
