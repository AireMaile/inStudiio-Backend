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

const SLUG_PREFIX = 'plan4-sub-cancel-';

describe('DELETE /subscriptions/:id', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p4x_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
  });
  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p4x_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('200 calls Stripe with cancel_at_period_end:true; DB unchanged', async () => {
    const owner = await createTestUser('plan4-sub-cancel-owner');
    const user = await createTestUser('plan4-sub-cancel-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}ok-${Date.now()}`,
    });
    const subRow = await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      status: 'active',
      stripeSubId: `sub_test_p4x_${Date.now()}`,
    });

    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .delete(`/subscriptions/${subRow.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canceled: true, cancelAtPeriodEnd: true });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      expect.stringMatching(/^sub_test_p4x_/),
      { cancel_at_period_end: true },
    );

    const { data } = await supabase
      .from('subscriptions')
      .select('cancel_at_period_end, status')
      .eq('id', subRow.id)
      .single();
    expect(data?.cancel_at_period_end).toBe(false);
    expect(data?.status).toBe('active');
  });

  it('401 when no auth', async () => {
    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app).delete('/subscriptions/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });

  it('404 subscription_not_found when id does not exist', async () => {
    const user = await createTestUser('plan4-sub-cancel-u');
    users.push(user);
    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .delete('/subscriptions/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });

  it('404 when subscription belongs to different user (existence-leak unified)', async () => {
    const owner = await createTestUser('plan4-sub-cancel-owner');
    const other = await createTestUser('plan4-sub-cancel-other');
    const me = await createTestUser('plan4-sub-cancel-u');
    users.push(owner, other, me);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}leak-${Date.now()}`,
    });
    const otherSub = await insertTestSubscription({
      userId: other.id,
      studioId: studio.id,
      stripeSubId: `sub_test_p4x_leak_${Date.now()}`,
    });

    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .delete(`/subscriptions/${otherSub.id}`)
      .set('Authorization', `Bearer ${signUserToken(me)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });

  it('409 not_cancelable when status already canceled', async () => {
    const owner = await createTestUser('plan4-sub-cancel-owner');
    const user = await createTestUser('plan4-sub-cancel-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}409-${Date.now()}`,
    });
    const subRow = await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      status: 'canceled',
      stripeSubId: `sub_test_p4x_done_${Date.now()}`,
    });

    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .delete(`/subscriptions/${subRow.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('not_cancelable');
  });

  it('502 stripe_error when Stripe throws', async () => {
    const owner = await createTestUser('plan4-sub-cancel-owner');
    const user = await createTestUser('plan4-sub-cancel-u');
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}502-${Date.now()}`,
    });
    const subRow = await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      status: 'active',
      stripeSubId: `sub_test_p4x_boom_${Date.now()}`,
    });

    const stripe = makeStripeMock();
    stripe.subscriptions.update.mockRejectedValueOnce(new Error('stripe down'));
    const app = createApp({ stripe });
    const res = await request(app)
      .delete(`/subscriptions/${subRow.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe('stripe_error');
  });
});
