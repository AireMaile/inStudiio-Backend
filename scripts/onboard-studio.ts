#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { supabase } from '../src/supabase.js';
import { stripe } from '../src/stripe.js';
import { onboardStudio } from '../src/scripts/onboardStudio.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'owner-email': { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string' },
      price: { type: 'string' },
      description: { type: 'string' },
    },
    strict: true,
  });

  const missing: string[] = [];
  if (!values['owner-email']) missing.push('--owner-email');
  if (!values.name) missing.push('--name');
  if (!values.slug) missing.push('--slug');
  if (missing.length) {
    throw new Error(`Missing required flags: ${missing.join(', ')}`);
  }

  const priceRaw = values.price ?? '9.99';
  const price = Number(priceRaw);
  if (!Number.isFinite(price)) throw new Error(`--price must be a number (got "${priceRaw}")`);

  const result = await onboardStudio({
    ownerEmail: values['owner-email']!,
    name: values.name!,
    slug: values.slug!,
    price,
    description: values.description,
    deps: { supabase, stripe },
  });

  console.log('\nStudio onboarded:');
  console.log(`  studio id:    ${result.studioId}`);
  console.log(`  slug:         ${result.slug}`);
  console.log(`  owner:        ${result.ownerEmail} (${result.ownerId})`);
  console.log(`  stripe prod:  ${result.stripeProductId}`);
  console.log(`  stripe price: ${result.stripePriceId}`);
}

main().catch(err => {
  console.error('\nOnboarding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
