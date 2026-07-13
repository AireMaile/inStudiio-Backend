import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supabase } from '../../src/supabase.js';
import { createTestUser, deleteTestUser, type TestUser } from '../helpers/testUsers.js';
import {
  deleteAllWebhookEventsByPrefix,
  deleteTestStudiosBySlugPrefix,
  deleteTestVideosByStudioPrefix,
  insertTestStudio,
  insertTestVideo,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'atomic-mux-rpc-';
const EVENT_PREFIX = 'evt_atomic_mux_rpc_';

describe('process_mux_webhook_event RPC', () => {
  const users: TestUser[] = [];

  beforeEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllWebhookEventsByPrefix(EVENT_PREFIX);
  });

  afterEach(async () => {
    await deleteTestVideosByStudioPrefix(SLUG_PREFIX);
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    await deleteAllWebhookEventsByPrefix(EVENT_PREFIX);
    for (const user of users) await deleteTestUser(user.id);
    users.length = 0;
  });

  async function makeVideo(status: 'waiting' | 'preparing' | 'ready' = 'waiting') {
    const owner = await createTestUser('atomic-mux-rpc-owner');
    users.push(owner);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return insertTestVideo({ studioId: studio.id, status });
  }

  async function ledgerCount(eventId: string): Promise<number> {
    const { count, error } = await supabase
      .from('mux_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if (error) throw error;
    return count ?? 0;
  }

  it('atomically inserts the ledger row and updates the video', async () => {
    const video = await makeVideo();
    const eventId = `${EVENT_PREFIX}processed_${Date.now()}`;

    const { data, error } = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.upload.asset_created',
      p_video_id: video.id,
      p_status: 'preparing',
      p_mux_asset_id: 'asset_atomic_first',
    });

    expect(error).toBeNull();
    expect(data).toBe('processed');
    expect(await ledgerCount(eventId)).toBe(1);

    const { data: row } = await supabase
      .from('videos')
      .select('status, mux_asset_id')
      .eq('id', video.id)
      .single();
    expect(row).toMatchObject({ status: 'preparing', mux_asset_id: 'asset_atomic_first' });
  });

  it('returns duplicate and does not apply a second mutation', async () => {
    const video = await makeVideo();
    const eventId = `${EVENT_PREFIX}duplicate_${Date.now()}`;
    const first = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.upload.asset_created',
      p_video_id: video.id,
      p_status: 'preparing',
      p_mux_asset_id: 'asset_first',
    });
    expect(first.error).toBeNull();
    expect(first.data).toBe('processed');

    const second = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.upload.asset_created',
      p_video_id: video.id,
      p_status: 'errored',
      p_error_message: 'must not be applied',
    });
    expect(second.error).toBeNull();
    expect(second.data).toBe('duplicate');
    expect(await ledgerCount(eventId)).toBe(1);

    const { data: row } = await supabase
      .from('videos')
      .select('status, mux_asset_id, error_message')
      .eq('id', video.id)
      .single();
    expect(row).toMatchObject({
      status: 'preparing',
      mux_asset_id: 'asset_first',
      error_message: null,
    });
  });

  it('rolls back the ledger insert when the video mutation violates a CHECK', async () => {
    const video = await makeVideo('preparing');
    const eventId = `${EVENT_PREFIX}rollback_${Date.now()}`;

    const { error } = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.asset.ready',
      p_video_id: video.id,
      p_status: 'ready',
      p_set_media: true,
      // Deliberately omit playback id while setting a policy. The pair CHECK
      // must abort the whole RPC transaction, including the ledger insert.
      p_mux_playback_policy: 'signed',
      p_duration_seconds: 10,
    });

    expect(error?.code).toBe('23514');
    expect(await ledgerCount(eventId)).toBe(0);

    const { data: row } = await supabase
      .from('videos')
      .select('status')
      .eq('id', video.id)
      .single();
    expect(row?.status).toBe('preparing');
  });

  it('p_set_media explicitly clears playback id, policy, and duration together', async () => {
    const video = await makeVideo('ready');
    const eventId = `${EVENT_PREFIX}clear_${Date.now()}`;

    const { data, error } = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.asset.ready',
      p_video_id: video.id,
      p_status: 'ready',
      p_set_media: true,
    });

    expect(error).toBeNull();
    expect(data).toBe('processed');
    const { data: row } = await supabase
      .from('videos')
      .select('mux_playback_id, mux_playback_policy, duration_seconds')
      .eq('id', video.id)
      .single();
    expect(row).toEqual({
      mux_playback_id: null,
      mux_playback_policy: null,
      duration_seconds: null,
    });
  });

  it('returns no_video and commits the ledger for a missing valid UUID', async () => {
    const eventId = `${EVENT_PREFIX}missing_${Date.now()}`;
    const { data, error } = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.asset.errored',
      p_video_id: crypto.randomUUID(),
      p_status: 'errored',
      p_error_message: 'missing video',
    });

    expect(error).toBeNull();
    expect(data).toBe('no_video');
    expect(await ledgerCount(eventId)).toBe(1);
  });

  it('returns recorded and commits the ledger for a ledger-only event', async () => {
    const eventId = `${EVENT_PREFIX}recorded_${Date.now()}`;
    const { data, error } = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.asset.unknown',
    });

    expect(error).toBeNull();
    expect(data).toBe('recorded');
    expect(await ledgerCount(eventId)).toBe(1);
  });

  it('does not touch the video when an id is supplied without a mutation', async () => {
    const video = await makeVideo('preparing');
    const eventId = `${EVENT_PREFIX}no_mutation_${Date.now()}`;
    const { data: before } = await supabase
      .from('videos')
      .select('*')
      .eq('id', video.id)
      .single();

    const result = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: eventId,
      p_event_type: 'video.upload.asset_created',
      p_video_id: video.id,
    });

    expect(result.error).toBeNull();
    expect(result.data).toBe('recorded');
    expect(await ledgerCount(eventId)).toBe(1);
    const { data: after } = await supabase
      .from('videos')
      .select('*')
      .eq('id', video.id)
      .single();
    expect(after).toEqual(before);
  });
});
