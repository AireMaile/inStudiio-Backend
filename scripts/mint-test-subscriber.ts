#!/usr/bin/env tsx
/**
 * Plan 5 §3 Step 1 helper. Creates a Supabase test user, looks up (or
 * onboards) a studio with a real Stripe price, signs a JWT, and prints
 * a ready-to-paste curl that hits POST /subscriptions to mint a real
 * Checkout Session URL.
 *
 * Run with: pnpm tsx scripts/mint-test-subscriber.ts [--studio-slug=foo]
 *
 * Test users are NOT cleaned up automatically — they are real Supabase auth
 * rows in your local DB. Delete them later via the Supabase dashboard or
 * supabase.auth.admin.deleteUser() if you care.
 */
import { parseArgs } from 'node:util';
import jwt from 'jsonwebtoken';
import { supabase } from '../src/supabase.js';
import { env } from '../src/env.js';

async function main(): Promise<void> {
  // Production guard: this script uses the service-role Supabase client and
  // signs JWTs; if SUPABASE_URL ever points at prod (mix-up or otherwise)
  // it would mint a real subscriber there. Refuse early.
  if (env.NODE_ENV === 'production' || /prod/i.test(env.SUPABASE_URL)) {
    console.error('refusing to run mint-test-subscriber: production env detected');
    console.error(`  NODE_ENV=${env.NODE_ENV}  SUPABASE_URL=${env.SUPABASE_URL}`);
    process.exit(1);
  }

  const { values } = parseArgs({
    options: {
      'studio-slug': { type: 'string' },
      'email-prefix': { type: 'string' },
    },
    strict: true,
  });

  const emailPrefix = values['email-prefix'] ?? 'plan5-capture';
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;

  // 1. Create test user via Supabase admin API
  console.log(`Creating test user: ${email}`);
  const { data: userData, error: userErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userErr || !userData.user) {
    throw userErr ?? new Error('createUser returned no user');
  }
  const user = { id: userData.user.id, email: userData.user.email! };
  console.log(`  ✓ user id: ${user.id}`);

  // 2. Find a studio with stripe_price_id set
  let studioQuery = supabase
    .from('studios')
    .select('id, slug, name, stripe_price_id')
    .not('stripe_price_id', 'is', null)
    .limit(1);

  if (values['studio-slug']) {
    studioQuery = supabase
      .from('studios')
      .select('id, slug, name, stripe_price_id')
      .eq('slug', values['studio-slug'])
      .not('stripe_price_id', 'is', null)
      .limit(1);
  }

  const { data: studios, error: studioErr } = await studioQuery;
  if (studioErr) throw studioErr;
  if (!studios || studios.length === 0) {
    if (values['studio-slug']) {
      throw new Error(
        `No studio with slug=${values['studio-slug']} that has stripe_price_id set. ` +
          `Onboard one first: pnpm tsx scripts/onboard-studio.ts --owner-email=... --name=... --slug=${values['studio-slug']} --price=9.99`,
      );
    }
    throw new Error(
      'No studios with stripe_price_id found in DB. Onboard one first: ' +
        `pnpm tsx scripts/onboard-studio.ts --owner-email=owner@test.local --name='Capture Studio' --slug=plan5-capture-studio --price=9.99`,
    );
  }
  const studio = studios[0];
  console.log(`  ✓ studio: ${studio.slug} (${studio.id})  price=${studio.stripe_price_id}`);

  // 3. Sign a JWT good for 1 hour
  const token = jwt.sign(
    { sub: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' },
    env.SUPABASE_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  console.log(`  ✓ JWT minted (1h expiry)`);

  // 4. Print the ready-to-paste curl
  const port = env.PORT ?? 3000;
  console.log('\n' + '='.repeat(72));
  console.log('Ready. Paste this into a separate terminal to mint a Checkout Session:');
  console.log('='.repeat(72) + '\n');

  console.log(`curl -sS -X POST http://localhost:${port}/subscriptions \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"studioId":"${studio.id}"}' | jq\n`);

  console.log('Then open the returned checkoutUrl in a browser, pay with test card');
  console.log('4242 4242 4242 4242 (any future expiry, any CVC, any zip).\n');

  console.log('Subscription Stripe id (for follow-up commands) will be in the resulting');
  console.log('subscriptions row after the webhook fires. Find it via:\n');
  console.log(`  psql "$SUPABASE_DB_URL" -c "select stripe_subscription_id from subscriptions where user_id='${user.id}'"\n`);

  console.log('Then for cancel-flow capture:');
  console.log('  stripe subscriptions update <sub_id> --cancel-at-period-end=true');
  console.log('Then for renewal/failure captures:');
  console.log('  stripe trigger invoice.payment_succeeded');
  console.log('  stripe trigger invoice.payment_failed');
  console.log('Then for deletion capture:');
  console.log('  stripe subscriptions cancel <sub_id>');
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
