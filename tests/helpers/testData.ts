import { supabase } from '../../src/supabase.js';

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
  const { error } = await supabase.from('studios').delete().like('slug', `${prefix}%`);
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
