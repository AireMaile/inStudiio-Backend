import crypto from 'node:crypto';

/**
 * Produces the value for Stripe's `Stripe-Signature` header:
 *   t=<unix-ts>,v1=<hex hmac-sha256 of `${ts}.${body}` keyed by secret>
 */
export function signStripePayload(body: string, ts: number, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${ts}.${body}`);
  return `t=${ts},v1=${hmac.digest('hex')}`;
}
