import { describe, it, expect, afterEach } from 'vitest';
import { onboardStudio } from '../../src/scripts/onboardStudio.js';
import { supabase } from '../../src/supabase.js';
import { deleteTestStudiosBySlugPrefix } from '../helpers/testData.js';

const SLUG_PREFIX = 'plan2-onboard-';

interface StripeCall {
  method: string;
  args: unknown;
}

function makeFakeStripe(calls: StripeCall[]) {
  return {
    products: {
      create: async (args: any) => {
        calls.push({ method: 'products.create', args });
        return { id: `prod_fake_${args.name}`, name: args.name };
      },
    },
    prices: {
      create: async (args: any) => {
        calls.push({ method: 'prices.create', args });
        return { id: `price_fake_${args.product}`, product: args.product };
      },
    },
  } as any;
}

describe('onboardStudio', () => {
  const testEmails: string[] = [];

  afterEach(async () => {
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const email of testEmails) {
      const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      const user = data?.users.find(u => u.email === email);
      if (user) await supabase.auth.admin.deleteUser(user.id);
    }
    testEmails.length = 0;
  });

  it('creates auth user, Stripe product+price, and studios row (happy path)', async () => {
    const email = `plan2-onboard-${Date.now()}@test.local`;
    testEmails.push(email);
    const slug = `${SLUG_PREFIX}happy-${Date.now()}`;
    const calls: StripeCall[] = [];
    const stripe = makeFakeStripe(calls);

    const result = await onboardStudio({
      ownerEmail: email,
      name: 'Morning Flow',
      slug,
      price: 9.99,
      description: 'Gentle morning yoga.',
      deps: { supabase, stripe },
    });

    expect(result.slug).toBe(slug);
    expect(result.ownerEmail).toBe(email);
    expect(result.stripeProductId).toMatch(/^prod_/);
    expect(result.stripePriceId).toMatch(/^price_/);
    expect(calls).toEqual([
      { method: 'products.create', args: { name: 'Morning Flow' } },
      {
        method: 'prices.create',
        args: {
          product: 'prod_fake_Morning Flow',
          unit_amount: 999,
          currency: 'usd',
          recurring: { interval: 'month' },
        },
      },
    ]);

    const { data: row } = await supabase.from('studios').select('*').eq('slug', slug).single();
    expect(row?.owner_user_id).toBe(result.ownerId);
    expect(row?.stripe_product_id).toBe(result.stripeProductId);
    expect(row?.stripe_price_id).toBe(result.stripePriceId);
  });

  it('reuses existing auth user instead of creating duplicate', async () => {
    const email = `plan2-onboard-reuse-${Date.now()}@test.local`;
    testEmails.push(email);
    const { data: created } = await supabase.auth.admin.createUser({ email, email_confirm: true });
    const preexistingId = created!.user!.id;

    const result = await onboardStudio({
      ownerEmail: email,
      name: 'Reused',
      slug: `${SLUG_PREFIX}reuse-${Date.now()}`,
      price: 5,
      deps: { supabase, stripe: makeFakeStripe([]) },
    });

    expect(result.ownerId).toBe(preexistingId);
  });

  it('rejects invalid slug before any side effects', async () => {
    const calls: StripeCall[] = [];
    await expect(
      onboardStudio({
        ownerEmail: 'irrelevant@test.local',
        name: 'X',
        slug: 'NOT VALID',
        price: 9.99,
        deps: { supabase, stripe: makeFakeStripe(calls) },
      }),
    ).rejects.toThrow(/slug/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects negative price before any side effects', async () => {
    const calls: StripeCall[] = [];
    await expect(
      onboardStudio({
        ownerEmail: 'irrelevant@test.local',
        name: 'X',
        slug: `${SLUG_PREFIX}neg`,
        price: -1,
        deps: { supabase, stripe: makeFakeStripe(calls) },
      }),
    ).rejects.toThrow(/price/i);
    expect(calls).toHaveLength(0);
  });

  it('on duplicate slug, surfaces clear error (does not create duplicate studio)', async () => {
    const email1 = `plan2-onboard-dup-a-${Date.now()}@test.local`;
    const email2 = `plan2-onboard-dup-b-${Date.now()}@test.local`;
    testEmails.push(email1, email2);
    const slug = `${SLUG_PREFIX}dup-${Date.now()}`;

    await onboardStudio({
      ownerEmail: email1,
      name: 'First',
      slug,
      price: 9.99,
      deps: { supabase, stripe: makeFakeStripe([]) },
    });

    await expect(
      onboardStudio({
        ownerEmail: email2,
        name: 'Second',
        slug,
        price: 9.99,
        deps: { supabase, stripe: makeFakeStripe([]) },
      }),
    ).rejects.toThrow(/slug.*exists/i);

    const { data } = await supabase.from('studios').select('id').eq('slug', slug);
    expect(data).toHaveLength(1);
  });
});
