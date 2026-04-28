import { vi, type Mock } from 'vitest';
import type { StripeDeps } from '../../src/types/stripeDeps.js';

/**
 * Stripe mock factory whose return type satisfies `StripeDeps` (the narrow
 * production dependency surface defined in src/types/stripeDeps.ts).
 *
 * Plan 5 P0.2: previously the mock did not satisfy the broader
 * `Pick<Stripe, ...>` surface and `pnpm typecheck` failed. With StripeDeps
 * narrowed to method-level Pick, this mock satisfies it via structural
 * typing — the `_stripeDepsConformance` line at the bottom is the
 * compile-time gate that proves it.
 *
 * Tests use the standard vi.Mock API (`mockResolvedValueOnce`,
 * `toHaveBeenCalledWith`, etc.) and pass loose object literals as return
 * values without strict Stripe.Response typing.
 *
 * Defaults:
 *   - checkout.sessions.create returns a session with a fake URL
 *   - customers.create returns a fake customer
 *   - subscriptions.update returns with cancel_at_period_end: true
 *   - subscriptions.retrieve returns a minimal active subscription whose
 *     current_period_* fields live at items.data[0] (Stripe API
 *     2026-03-25.dahlia layout — see Plan 5 P0.1 capture findings)
 *   - webhooks.constructEvent parses the raw body as JSON (bypasses
 *     signature check). Pass { verifySignatures: true } to require real
 *     verification via the Stripe SDK.
 */
export type StripeMock = {
  checkout: { sessions: { create: Mock } };
  customers: { create: Mock };
  subscriptions: { retrieve: Mock; update: Mock };
  webhooks: { constructEvent: Mock };
};

export function makeStripeMock(opts?: { verifySignatures?: boolean; secret?: string }): StripeMock {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        }),
      },
    },
    customers: {
      create: vi.fn().mockResolvedValue({ id: 'cus_test_mock' }),
    },
    subscriptions: {
      update: vi.fn().mockResolvedValue({
        id: 'sub_test_mock',
        cancel_at_period_end: true,
        status: 'active',
      }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'sub_test_mock',
        status: 'active',
        cancel_at_period_end: false,
        // Plan 5 P0.1: period fields at items[0] in Stripe API 2026-03-25.dahlia
        items: {
          data: [{
            current_period_start: nowSec,
            current_period_end: nowSec + 30 * 86400,
          }],
        },
      }),
    },
    webhooks: {
      constructEvent: vi.fn((raw: string | Buffer, sig: string, secret: string) => {
        if (opts?.verifySignatures) {
          // Delegate to the real Stripe verifier so tests exercise middleware wiring.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const Stripe = require('stripe');
          const real = new Stripe(opts.secret ?? 'sk_test_dummy');
          return real.webhooks.constructEvent(raw, sig, secret);
        }
        return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      }),
    },
  };
}

/**
 * Compile-time gate: the StripeMock structure must be assignable to
 * StripeDeps. If StripeDeps grows a method or StripeMock drops one, this
 * line fails to type-check and `pnpm typecheck` fails. This is what makes
 * Plan 5 P0.2 a real check rather than a vibes claim.
 */
const _stripeDepsConformance: StripeDeps = makeStripeMock();
void _stripeDepsConformance;
