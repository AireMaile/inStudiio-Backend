import { supabase } from '../../src/supabase.js';

// SQL LIKE treats `_` as a single-character wildcard and `%` as multi-char,
// so prefix-based cleanup helpers MUST escape those characters or risk
// aliasing between test files. Postgres uses `\` as the default escape char.
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '\\\\').replace(/[_%]/g, (ch) => `\\${ch}`);
}

export interface TestStudio {
  id: string;
  slug: string;
}

export async function insertTestStudio(opts: {
  ownerUserId: string;
  slug: string;
  name?: string;
  priceMonthly?: number;
}): Promise<TestStudio> {
  const { data, error } = await supabase
    .from('studios')
    .insert({
      owner_user_id: opts.ownerUserId,
      slug: opts.slug,
      name: opts.name ?? `Test Studio ${opts.slug}`,
      description: 'Test description',
      price_monthly: opts.priceMonthly ?? 9.99,
      stripe_product_id: `prod_test_${opts.slug}`,
      stripe_price_id: `price_test_${opts.slug}`,
    })
    .select('id, slug')
    .single();
  if (error || !data) throw error ?? new Error('insert returned no row');
  return { id: data.id, slug: data.slug };
}

export async function deleteTestStudiosBySlugPrefix(prefix: string): Promise<void> {
  const { error } = await supabase
    .from('studios')
    .delete()
    .like('slug', `${escapeLikePrefix(prefix)}%`);
  if (error) throw error;
}

export async function insertTestSubscription(opts: {
  userId: string;
  studioId: string;
  status?: 'active' | 'canceled' | 'past_due';
  stripeSubId?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('subscriptions')
    .insert({
      user_id: opts.userId,
      studio_id: opts.studioId,
      status: opts.status ?? 'active',
      stripe_customer_id: `cus_test_${Math.random().toString(36).slice(2, 10)}`,
      stripe_subscription_id: opts.stripeSubId ?? `sub_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      cancel_at_period_end: false,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('insert returned no row');
  return { id: data.id };
}

export interface TestVideo {
  id: string;
  studio_id: string;
  status: 'waiting' | 'preparing' | 'ready' | 'errored';
}

export async function insertTestVideo(opts: {
  studioId: string;
  title?: string;
  description?: string | null;
  status?: 'waiting' | 'preparing' | 'ready' | 'errored';
  muxUploadId?: string | null;
  muxAssetId?: string | null;
  muxPlaybackId?: string | null;
  durationSeconds?: number | null;
  errorMessage?: string | null;
}): Promise<TestVideo> {
  const { data, error } = await supabase
    .from('videos')
    .insert({
      studio_id: opts.studioId,
      title: opts.title ?? `Test video ${Math.random().toString(36).slice(2, 8)}`,
      description: opts.description ?? null,
      status: opts.status ?? 'ready',
      mux_upload_id: opts.muxUploadId ?? null,
      mux_asset_id: opts.muxAssetId ?? null,
      mux_playback_id:
        opts.muxPlaybackId ??
        (opts.status === 'ready' ? 'pb_test_' + Math.random().toString(36).slice(2, 10) : null),
      duration_seconds: opts.durationSeconds ?? null,
      error_message: opts.errorMessage ?? null,
    })
    .select('id, studio_id, status')
    .single();
  if (error || !data) throw error ?? new Error('insert returned no row');
  return { id: data.id, studio_id: data.studio_id, status: data.status as TestVideo['status'] };
}

export async function deleteTestVideosByStudioPrefix(prefix: string): Promise<void> {
  const { data: studios } = await supabase
    .from('studios')
    .select('id')
    .like('slug', `${escapeLikePrefix(prefix)}%`);
  const ids = (studios ?? []).map((s) => s.id);
  if (ids.length === 0) return;
  const { error } = await supabase.from('videos').delete().in('studio_id', ids);
  if (error) throw error;
}

export async function deleteAllWebhookEventsByPrefix(prefix: string): Promise<void> {
  const { error } = await supabase
    .from('mux_webhook_events')
    .delete()
    .like('event_id', `${escapeLikePrefix(prefix)}%`);
  if (error) throw error;
}
