// tests/lib/stripeStatus.test.ts
import { describe, it, expect } from 'vitest';
import { mapStripeStatus } from '../../src/lib/stripeStatus.js';

describe('mapStripeStatus', () => {
  it('active → active', () => {
    expect(mapStripeStatus('active')).toBe('active');
  });
  it('trialing → active (trial is full access)', () => {
    expect(mapStripeStatus('trialing')).toBe('active');
  });
  it('past_due → past_due', () => {
    expect(mapStripeStatus('past_due')).toBe('past_due');
  });
  it('unpaid → past_due (retries exhausted)', () => {
    expect(mapStripeStatus('unpaid')).toBe('past_due');
  });
  it('paused → past_due (similar UX)', () => {
    expect(mapStripeStatus('paused')).toBe('past_due');
  });
  it('canceled → canceled', () => {
    expect(mapStripeStatus('canceled')).toBe('canceled');
  });
  it('incomplete → incomplete', () => {
    expect(mapStripeStatus('incomplete')).toBe('incomplete');
  });
  it('incomplete_expired → canceled (auto-cancelled after 23h)', () => {
    expect(mapStripeStatus('incomplete_expired')).toBe('canceled');
  });
  it('throws on unknown status', () => {
    expect(() => mapStripeStatus('unknown_future_status')).toThrow(
      'unknown Stripe subscription status: unknown_future_status',
    );
  });
});
