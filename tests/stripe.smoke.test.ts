import { describe, it, expect } from 'vitest';
import { stripe } from '../src/stripe.js';

describe('stripe client', () => {
  it('exports a Stripe instance', () => {
    expect(stripe).toBeDefined();
    expect(typeof stripe.products.create).toBe('function');
    expect(typeof stripe.prices.create).toBe('function');
  });
});
