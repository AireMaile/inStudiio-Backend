// src/lib/stripeStatus.ts

const MAP: Record<string, 'active' | 'past_due' | 'canceled' | 'incomplete'> = {
  active: 'active',
  trialing: 'active',           // user has access during trial
  past_due: 'past_due',
  unpaid: 'past_due',           // retries exhausted; FE shows "update payment"
  paused: 'past_due',           // similar UX semantics
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled', // 23h auto-cancel; sub is dead
};

export function mapStripeStatus(s: string): 'active' | 'past_due' | 'canceled' | 'incomplete' {
  const out = MAP[s];
  if (!out) throw new Error(`unknown Stripe subscription status: ${s}`);
  return out;
}
