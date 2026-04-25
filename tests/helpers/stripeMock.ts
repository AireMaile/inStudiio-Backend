import { vi } from 'vitest';

/**
 * Returns a Stripe-shaped object with vi.fn() stubs for every method we call.
 * Individual tests override return values via `mock.checkout.sessions.create.mockResolvedValueOnce(...)`.
 * By default:
 *   - checkout.sessions.create returns a session with a fake URL
 *   - customers.create returns a fake customer
 *   - subscriptions.update returns with cancel_at_period_end: true
 *   - subscriptions.retrieve returns a minimal active subscription
 *   - webhooks.constructEvent parses the raw body as JSON (bypasses signature check).
 *     For signature-verification tests, pass { verifySignatures: true } to require real verification.
 */
export function makeStripeMock(opts?: { verifySignatures?: boolean; secret?: string }) {
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
        current_period_start: nowSec,
        current_period_end: nowSec + 30 * 86400,
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

export type StripeMock = ReturnType<typeof makeStripeMock>;
