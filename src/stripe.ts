import Stripe from 'stripe';
import { env } from './env.js';

/**
 * Plan 5 P0.1: pin the API version explicitly. The captured webhook payloads
 * in tests/fixtures/captured/*.json carry api_version='2026-03-25.dahlia',
 * and the handlers in src/routes/stripeWebhook.ts read field paths that are
 * specific to that version (subscription period at items[0], invoice
 * subscription at parent.subscription_details). Pinning the SDK matches the
 * inbound event shapes and prevents drift if the Stripe SDK bumps its
 * default API version in a future release.
 */
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-03-25.dahlia',
});
