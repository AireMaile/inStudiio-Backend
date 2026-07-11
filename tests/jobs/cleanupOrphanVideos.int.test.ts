import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { supabase } from '../../src/supabase.js';
import { cleanupOrphanVideos } from '../../src/jobs/cleanupOrphanVideos.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import { insertTestStudio, deleteTestStudiosBySlugPrefix } from '../helpers/testData.js';

const SLUG_PREFIX = 'plan5-janitor-';

async function insertVideo(opts: {
  studioId: string;
  status: 'waiting' | 'preparing' | 'ready' | 'errored';
  ageHours: number;
  title?: string;
}): Promise<{ id: string }> {
  const createdAt = new Date(Date.now() - opts.ageHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('videos')
    .insert({
      studio_id: opts.studioId,
      title: opts.title ?? 'janitor test video',
      status: opts.status,
      created_at: createdAt,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('insert returned no row');
  return { id: data.id };
}

describe('cleanupOrphanVideos', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
  });
  afterEach(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('flips a stale waiting row to errored with the orphan reason; second run is a no-op (idempotent)', async () => {
    const owner = await createTestUser('plan5-janitor-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}stale-${Date.now()}`,
    });
    const stale = await insertVideo({ studioId: studio.id, status: 'waiting', ageHours: 25 });

    // First sweep: stale row gets flipped.
    const first = await cleanupOrphanVideos();
    expect(first.updated).toBeGreaterThanOrEqual(1);

    const { data: rowAfterFirst } = await supabase
      .from('videos')
      .select('status, error_message')
      .eq('id', stale.id)
      .single();
    expect(rowAfterFirst?.status).toBe('errored');
    expect(rowAfterFirst?.error_message).toBe('orphaned by janitor: stale waiting row >24h');

    // Second sweep: status is no longer 'waiting', so the filter excludes it.
    const second = await cleanupOrphanVideos();
    expect(second.updated).toBe(0);

    const { data: rowAfterSecond } = await supabase
      .from('videos')
      .select('status, error_message')
      .eq('id', stale.id)
      .single();
    expect(rowAfterSecond?.status).toBe('errored');
    expect(rowAfterSecond?.error_message).toBe('orphaned by janitor: stale waiting row >24h');
  });

  it('does NOT touch fresh waiting rows or non-waiting rows of any age', async () => {
    const owner = await createTestUser('plan5-janitor-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}selective-${Date.now()}`,
    });

    const fresh = await insertVideo({ studioId: studio.id, status: 'waiting', ageHours: 1 });
    const oldReady = await insertVideo({ studioId: studio.id, status: 'ready', ageHours: 100 });
    const oldErrored = await insertVideo({ studioId: studio.id, status: 'errored', ageHours: 100 });

    await cleanupOrphanVideos();

    const { data: freshRow } = await supabase.from('videos').select('status').eq('id', fresh.id).single();
    expect(freshRow?.status).toBe('waiting');

    const { data: readyRow } = await supabase.from('videos').select('status').eq('id', oldReady.id).single();
    expect(readyRow?.status).toBe('ready');

    const { data: erroredRow } = await supabase.from('videos').select('status, error_message').eq('id', oldErrored.id).single();
    expect(erroredRow?.status).toBe('errored');
    // Pre-existing errored rows must NOT be re-stamped with the orphan reason.
    expect(erroredRow?.error_message).not.toBe('orphaned by janitor: stale waiting row >24h');
  });

  it('honors a custom staleHours threshold', async () => {
    const owner = await createTestUser('plan5-janitor-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}threshold-${Date.now()}`,
    });
    // 5h-old row: not stale at default 24h, but stale at 1h threshold.
    const v = await insertVideo({ studioId: studio.id, status: 'waiting', ageHours: 5 });

    const noopAtDefault = await cleanupOrphanVideos();
    expect(noopAtDefault.updated).toBe(0);
    const { data: stillWaiting } = await supabase.from('videos').select('status').eq('id', v.id).single();
    expect(stillWaiting?.status).toBe('waiting');

    const sweepAtOneHour = await cleanupOrphanVideos({ staleHours: 1 });
    expect(sweepAtOneHour.updated).toBeGreaterThanOrEqual(1);
    const { data: nowErrored } = await supabase
      .from('videos')
      .select('status, error_message')
      .eq('id', v.id)
      .single();
    expect(nowErrored?.status).toBe('errored');
    expect(nowErrored?.error_message).toBe('orphaned by janitor: stale waiting row >1h');
  });
});
