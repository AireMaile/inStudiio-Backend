import type Stripe from 'stripe';

/**
 * Narrow dependency surface for the Stripe SDK methods this app actually
 * consumes. Plan 5 P0.2: replaces the previously over-broad
 * Pick<Stripe, 'checkout' | 'subscriptions' | 'customers' | 'webhooks'>
 * which forced test mocks to implement entire nested resource objects.
 *
 * Anchored to Stripe's own resource method types so we don't drift; narrowed
 * to the specific methods used so mocks can be honest.
 */
export interface StripeDeps {
  checkout: {
    sessions: Pick<Stripe.Checkout.SessionsResource, 'create'>;
  };
  customers: Pick<Stripe.CustomersResource, 'create'>;
  subscriptions: Pick<Stripe.SubscriptionsResource, 'retrieve' | 'update'>;
  webhooks: Pick<Stripe.Webhooks, 'constructEvent'>;
}
