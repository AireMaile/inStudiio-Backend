import { Router, type RequestHandler } from 'express';
import type Stripe from 'stripe';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { supabase } from '../supabase.js';

export interface StripeWebhookDeps {
  stripe: Pick<Stripe, 'webhooks' | 'subscriptions'>;
}

export function createStripeWebhookRouter(deps: StripeWebhookDeps): Router {
  const router = Router();

  const handler: RequestHandler = async (req, res) => {
    const sig = req.header('stripe-signature');
    if (!sig) {
      logger.warn('stripe webhook missing Stripe-Signature header');
      res.status(400).json({ error: { code: 'invalid_signature', message: 'missing signature' } });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    let event: Stripe.Event;
    try {
      event = deps.stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logger.warn({ err }, 'stripe webhook signature rejected');
      res.status(400).json({ error: { code: 'invalid_signature', message: 'invalid webhook signature' } });
      return;
    }

    // Idempotency: try to record event_id. Duplicate → short-circuit.
    const { data: ledger, error: ledgerErr } = await supabase
      .from('stripe_webhook_events')
      .insert({ event_id: event.id, event_type: event.type })
      .select('event_id')
      .single();
    if (ledgerErr) {
      if ((ledgerErr as any).code === '23505') {
        logger.info({ eventId: event.id }, 'stripe webhook duplicate, skipping');
        res.status(200).json({ duplicate: true });
        return;
      }
      logger.error({ err: ledgerErr, eventId: event.id }, 'stripe webhook ledger insert failed');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
      return;
    }
    if (!ledger) {
      logger.error({ eventId: event.id }, 'stripe webhook ledger insert returned no row');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
      return;
    }

    try {
      // Event-specific handlers added in later tasks.
      logger.info({ eventId: event.id, type: event.type }, 'stripe webhook: unhandled event type');
      res.status(200).json({ noop: true });
    } catch (err) {
      // Roll back the ledger so Stripe's retry reprocesses instead of short-circuiting.
      await supabase.from('stripe_webhook_events').delete().eq('event_id', event.id);
      logger.error({ err, eventId: event.id, type: event.type }, 'stripe webhook handler failed; ledger rolled back');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
    }
  };

  router.post('/', handler);
  return router;
}
