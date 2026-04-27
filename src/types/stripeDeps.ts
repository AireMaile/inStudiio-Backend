import type Stripe from 'stripe';

/**
 * Narrow dependency surface for the Stripe SDK methods this app actually
 * consumes. Plan 5 P0.2.
 *
 * Strategy: anchor the types via INDEXED ACCESS off the Stripe instance
 * (e.g. `Stripe['customers']`) rather than via individually-named resource
 * classes. The Stripe SDK does not consistently re-export per-resource
 * classes by name (e.g. `SessionResource` is internal to its file), but
 * the instance property shape is always available. Indexed access also
 * matches what we actually inject — `deps.stripe.customers.create(...)`.
 */
export interface StripeDeps {
  checkout: {
    sessions: Pick<Stripe['checkout']['sessions'], 'create'>;
  };
  customers: Pick<Stripe['customers'], 'create'>;
  subscriptions: Pick<Stripe['subscriptions'], 'retrieve' | 'update'>;
  webhooks: Pick<Stripe['webhooks'], 'constructEvent'>;
}
