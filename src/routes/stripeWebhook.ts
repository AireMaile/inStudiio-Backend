import { Router, type RequestHandler } from 'express';
import type Stripe from 'stripe';
import { env } from '../env.js';
import { logger } from '../logger.js';

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

    // Handlers added in later tasks. For now, ack unknown types.
    logger.info({ eventId: event.id, type: event.type }, 'stripe webhook: unhandled event type');
    res.status(200).json({ noop: true });
  };

  router.post('/', handler);
  return router;
}
