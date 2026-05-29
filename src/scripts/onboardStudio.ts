import { z } from 'zod';
import type Stripe from 'stripe';
import type { DB } from '../supabase.js';

export interface OnboardDeps {
  supabase: DB;
  stripe: Pick<Stripe, 'products' | 'prices'>;
}

export interface OnboardArgs {
  ownerEmail: string;
  name: string;
  slug: string;
  price: number;
  description?: string;
  deps: OnboardDeps;
}

export interface OnboardResult {
  studioId: string;
  slug: string;
  ownerId: string;
  ownerEmail: string;
  stripeProductId: string;
  stripePriceId: string;
}

const InputSchema = z.object({
  ownerEmail: z.string().email(),
  name: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'slug must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)'),
  price: z.number().nonnegative('price must be >= 0'),
  description: z.string().optional(),
});

export async function onboardStudio(args: OnboardArgs): Promise<OnboardResult> {
  const parsed = InputSchema.safeParse({
    ownerEmail: args.ownerEmail,
    name: args.name,
    slug: args.slug,
    price: args.price,
    description: args.description,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(i => i.message).join('; '));
  }
  const { ownerEmail, name, slug, price, description } = parsed.data;
  const { supabase, stripe } = args.deps;

  // 1. Resolve or create auth user.
  const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listed.error) throw new Error(`auth.admin.listUsers failed: ${listed.error.message}`);
  let ownerId: string;
  const existing = listed.data.users.find(u => u.email === ownerEmail);
  if (existing) {
    ownerId = existing.id;
  } else {
    const created = await supabase.auth.admin.createUser({ email: ownerEmail, email_confirm: true });
    if (created.error || !created.data.user) {
      throw new Error(`auth.admin.createUser failed: ${created.error?.message ?? 'no user returned'}`);
    }
    ownerId = created.data.user.id;
  }

  // 2. Confirm profile row exists (trigger should have populated it).
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', ownerId)
    .single();
  if (profileErr || !profile) {
    throw new Error(`profile row missing for user ${ownerId} — trigger may not have fired`);
  }

  // 3. Stripe product.
  const product = await stripe.products.create({ name });

  // 4. Stripe price.
  const priceObj = await stripe.prices.create({
    product: product.id,
    unit_amount: Math.round(price * 100),
    currency: 'usd',
    recurring: { interval: 'month' },
  });

  // 5. Insert studios row.
  const { data: studio, error: insertErr } = await supabase
    .from('studios')
    .insert({
      owner_user_id: ownerId,
      name,
      slug,
      description: description ?? null,
      price_monthly: price,
      stripe_product_id: product.id,
      stripe_price_id: priceObj.id,
    })
    .select('id')
    .single();

  if (insertErr || !studio) {
    const msg = insertErr?.message ?? 'insert returned no row';
    if (insertErr?.code === '23505' || /duplicate key/i.test(msg)) {
      throw new Error(`studio with slug "${slug}" already exists — did you mean to update it?`);
    }
    throw new Error(`studios insert failed: ${msg}`);
  }

  return {
    studioId: studio.id,
    slug,
    ownerId,
    ownerEmail,
    stripeProductId: product.id,
    stripePriceId: priceObj.id,
  };
}
