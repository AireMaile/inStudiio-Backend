import type Stripe from 'stripe';

/**
 * Narrow dependency surface for the Stripe SDK methods this app actually
 * consumes. Plan 5 P0.2: replaces the previously over-broad
 * Pick<Stripe, 'checkout' | 'subscriptions' | 'customers' | 'webhooks'>
 * which forced test mocks to implement entire nested resource objects.
 *
 * Anchored to Stripe SDK 22's own resource method types so we don't drift;
 * narrowed to the specific methods used so mocks can be honest.
 *
 * Note: Stripe SDK 22 uses singular resource names (SessionResource,
 * CustomerResource, SubscriptionResource). Webhooks is a property type
 * on the Stripe instance, not a namespace export, so we Pick from
 * Stripe['webhooks'].
 */
export interface StripeDeps {
  checkout: {
    sessions: Pick<Stripe.Checkout.SessionResource, 'create'>;
  };
  customers: Pick<Stripe.CustomerResource, 'create'>;
  subscriptions: Pick<Stripe.SubscriptionResource, 'retrieve' | 'update'>;
  webhooks: Pick<Stripe['webhooks'], 'constructEvent'>;
}
