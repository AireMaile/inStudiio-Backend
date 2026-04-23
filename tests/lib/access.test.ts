import { describe, it, expect, afterEach } from 'vitest';
import { supabase } from '../../src/supabase.js';
import { hasActiveSubscription } from '../../src/lib/access.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestSubscription,
  deleteTestStudiosBySlugPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan3-access-';

describe('hasActiveSubscription', () => {
  const users: TestUser[] = [];

  afterEach(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('returns false when no subscription exists', async () => {
    const owner = await createTestUser('plan3-access-owner');
    const viewer = await createTestUser('plan3-access-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}none-${Date.now()}`,
    });

    await expect(
      hasActiveSubscription({ supabase }, viewer.id, studio.id),
    ).resolves.toBe(false);
  });

  it('returns true for an active subscription', async () => {
    const owner = await createTestUser('plan3-access-owner');
    const viewer = await createTestUser('plan3-access-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}active-${Date.now()}`,
    });
    await insertTestSubscription({ userId: viewer.id, studioId: studio.id, status: 'active' });

    await expect(
      hasActiveSubscription({ supabase }, viewer.id, studio.id),
    ).resolves.toBe(true);
  });

  it('returns false for canceled or past_due subscriptions', async () => {
    const owner = await createTestUser('plan3-access-owner');
    const viewer = await createTestUser('plan3-access-viewer');
    users.push(owner, viewer);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}inactive-${Date.now()}`,
    });
    await insertTestSubscription({ userId: viewer.id, studioId: studio.id, status: 'canceled' });

    await expect(
      hasActiveSubscription({ supabase }, viewer.id, studio.id),
    ).resolves.toBe(false);
  });
});
