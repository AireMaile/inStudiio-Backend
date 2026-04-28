import { describe, it, expect } from 'vitest';
import { loadCapture } from './loadCapture.js';
import {
  checkoutSessionCompleted,
  customerSubscriptionUpdated,
  customerSubscriptionDeleted,
  invoicePaymentSucceeded,
  invoicePaymentFailed,
} from './stripeEvents.js';

/**
 * Plan 5 §6.5 fixture-provenance gate. Each builder must produce a payload
 * whose top-level `data.object` keys match the captured testmode shape.
 * This is the conformance check that prevents future drift between our
 * fixtures and what Stripe actually sends — without it, a builder could
 * silently lose or rename fields and the rest of the test suite would
 * never notice.
 *
 * Runs in CI; does not hit the network.
 */
describe('Stripe fixture builders match captured shapes', () => {
  function expectKeysMatch(builtObj: unknown, capturedObj: unknown, eventType: string): void {
    expect(typeof builtObj).toBe('object');
    expect(typeof capturedObj).toBe('object');
    const builtKeys = Object.keys(builtObj as Record<string, unknown>).sort();
    const capturedKeys = Object.keys(capturedObj as Record<string, unknown>).sort();
    expect(builtKeys, `builder for ${eventType} drifted from captured keys`).toEqual(capturedKeys);
  }

  it('checkoutSessionCompleted preserves the captured top-level keys', () => {
    const { event } = loadCapture('checkout.session.completed');
    const built = checkoutSessionCompleted({ userId: 'u', studioId: 's' });
    expectKeysMatch(built.data.object, event.data.object, 'checkout.session.completed');
  });

  it('customerSubscriptionUpdated preserves captured top-level keys', () => {
    const { event } = loadCapture('customer.subscription.updated');
    const built = customerSubscriptionUpdated({
      subId: 'sub_x',
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    expectKeysMatch(built.data.object, event.data.object, 'customer.subscription.updated');
  });

  it('customerSubscriptionDeleted preserves captured top-level keys', () => {
    const { event } = loadCapture('customer.subscription.deleted');
    const built = customerSubscriptionDeleted({ subId: 'sub_x' });
    expectKeysMatch(built.data.object, event.data.object, 'customer.subscription.deleted');
  });

  it('invoicePaymentSucceeded preserves captured top-level keys', () => {
    const { event } = loadCapture('invoice.payment_succeeded');
    const built = invoicePaymentSucceeded({ subId: 'sub_x', billingReason: 'subscription_cycle' });
    expectKeysMatch(built.data.object, event.data.object, 'invoice.payment_succeeded');
  });

  it('invoicePaymentFailed preserves captured top-level keys', () => {
    const { event } = loadCapture('invoice.payment_failed');
    const built = invoicePaymentFailed({ subId: 'sub_x' });
    expectKeysMatch(built.data.object, event.data.object, 'invoice.payment_failed');
  });
});
