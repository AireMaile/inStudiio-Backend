import { Router, type RequestHandler } from 'express';
import type Stripe from 'stripe';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { supabase } from '../supabase.js';
import type { StripeDeps } from '../types/stripeDeps.js';

export interface StripeWebhookDeps {
  stripe: Pick<StripeDeps, 'webhooks' | 'subscriptions'>;
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
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as any;
          const meta = session?.metadata ?? {};
          const userId = typeof meta.user_id === 'string' ? meta.user_id : null;
          const studioId = typeof meta.studio_id === 'string' ? meta.studio_id : null;
          const subId = typeof session?.subscription === 'string' ? session.subscription : null;
          const custId = typeof session?.customer === 'string' ? session.customer : null;
          if (!userId || !studioId || !subId || !custId) {
            logger.warn({ eventId: event.id }, 'checkout.session.completed missing metadata/ids; noop');
            res.status(200).json({ noop: true });
            return;
          }
          const sub = (await deps.stripe.subscriptions.retrieve(subId)) as any;
          const { error: upsertErr } = await supabase
            .from('subscriptions')
            .upsert(
              {
                user_id: userId,
                studio_id: studioId,
                stripe_subscription_id: subId,
                stripe_customer_id: custId,
                status: sub.status,
                current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
                current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
                cancel_at_period_end: sub.cancel_at_period_end,
              },
              { onConflict: 'user_id,studio_id' },
            );
          if (upsertErr) throw upsertErr;
          res.status(200).json({ ok: true });
          return;
        }
        case 'invoice.payment_succeeded': {
          const inv = event.data.object as any;
          if (inv?.billing_reason !== 'subscription_cycle') {
            logger.info({ eventId: event.id, billingReason: inv?.billing_reason }, 'invoice.payment_succeeded: not subscription_cycle, noop');
            res.status(200).json({ noop: true });
            return;
          }
          const subId = typeof inv?.subscription === 'string' ? inv.subscription : null;
          const period = inv?.lines?.data?.[0]?.period;
          if (!subId || !period?.start || !period?.end) {
            logger.warn({ eventId: event.id }, 'invoice.payment_succeeded missing fields; noop');
            res.status(200).json({ noop: true });
            return;
          }
          const { data: updated, error: updateErr } = await supabase
            .from('subscriptions')
            .update({
              status: 'active',
              current_period_start: new Date(period.start * 1000).toISOString(),
              current_period_end: new Date(period.end * 1000).toISOString(),
            })
            .eq('stripe_subscription_id', subId)
            .select('id');
          if (updateErr) throw updateErr;
          if (!updated || updated.length === 0) {
            logger.info({ eventId: event.id, subId }, 'invoice.payment_succeeded: no matching sub row, noop');
            res.status(200).json({ noop: true });
            return;
          }
          res.status(200).json({ ok: true });
          return;
        }
        case 'invoice.payment_failed': {
          const inv = event.data.object as any;
          const subId = typeof inv?.subscription === 'string' ? inv.subscription : null;
          if (!subId) {
            res.status(200).json({ noop: true });
            return;
          }
          const { data: updated, error: updateErr } = await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', subId)
            .select('id');
          if (updateErr) throw updateErr;
          if (!updated || updated.length === 0) {
            res.status(200).json({ noop: true });
            return;
          }
          res.status(200).json({ ok: true });
          return;
        }
        case 'customer.subscription.updated': {
          const sub = event.data.object as any;
          const subId = typeof sub?.id === 'string' ? sub.id : null;
          if (!subId) {
            res.status(200).json({ noop: true });
            return;
          }
          const { data: updated, error: updateErr } = await supabase
            .from('subscriptions')
            .update({
              status: sub.status,
              cancel_at_period_end: !!sub.cancel_at_period_end,
              current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
              current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            })
            .eq('stripe_subscription_id', subId)
            .select('id');
          if (updateErr) throw updateErr;
          if (!updated || updated.length === 0) {
            res.status(200).json({ noop: true });
            return;
          }
          res.status(200).json({ ok: true });
          return;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object as any;
          const subId = typeof sub?.id === 'string' ? sub.id : null;
          if (!subId) {
            res.status(200).json({ noop: true });
            return;
          }
          const { data: updated, error: updateErr } = await supabase
            .from('subscriptions')
            .update({ status: 'canceled', cancel_at_period_end: false })
            .eq('stripe_subscription_id', subId)
            .select('id');
          if (updateErr) throw updateErr;
          if (!updated || updated.length === 0) {
            res.status(200).json({ noop: true });
            return;
          }
          res.status(200).json({ ok: true });
          return;
        }
        default: {
          logger.info({ eventId: event.id, type: event.type }, 'stripe webhook: unhandled event type');
          res.status(200).json({ noop: true });
          return;
        }
      }
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
