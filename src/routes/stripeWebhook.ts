import { Router, type RequestHandler } from 'express';
import { type Stripe } from 'stripe';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { supabase } from '../supabase.js';
import type { StripeDeps } from '../types/stripeDeps.js';
import { mapStripeStatus } from '../lib/stripeStatus.js';

export interface StripeWebhookDeps {
  stripe: Pick<StripeDeps, 'webhooks' | 'subscriptions'>;
}

// Read-policy (Plan 5 §billing-contract):
//   checkout.session.completed → user_id/studio_id from Session metadata first,
//     fall back to retrieved Subscription metadata (defensive: empty Session
//     metadata observed in capture when only subscription_data.metadata was set
//     pre-Plan-5; dual write fixes this going forward).
//   invoice.* → subscription id at parent.subscription_details.subscription
//     (Stripe API 2026-03-25.dahlia moved it off the top-level field).
//   customer.subscription.* → period at items.data[0].current_period_* (same
//     migration; top-level current_period_* is null on this API version).

// Helpers below take the SDK-typed object so payload-shape drift breaks
// here at compile time rather than at runtime — except where the SDK types
// haven't caught up to API 2026-03-25.dahlia's nested fields, in which
// case we cast `as any` at the dereference site only (contained blast
// radius). When the SDK types update, drop the casts.

function readSessionMetadata(s: Stripe.Checkout.Session): { userId: string | null; studioId: string | null } {
  const m = s.metadata ?? {};
  return {
    userId: typeof m.user_id === 'string' ? m.user_id : null,
    studioId: typeof m.studio_id === 'string' ? m.studio_id : null,
  };
}

function readSubscriptionMetadata(sub: Stripe.Subscription): { userId: string | null; studioId: string | null } {
  const m = sub.metadata ?? {};
  return {
    userId: typeof m.user_id === 'string' ? m.user_id : null,
    studioId: typeof m.studio_id === 'string' ? m.studio_id : null,
  };
}

function readSubPeriod(sub: Stripe.Subscription): { start: number | null; end: number | null } {
  // SDK still types current_period_* at top-level for backward compat;
  // API 2026-03-25.dahlia put them at items.data[0]. Cast contained here.
  const item = (sub as any).items?.data?.[0];
  const start = typeof item?.current_period_start === 'number' ? item.current_period_start : null;
  const end = typeof item?.current_period_end === 'number' ? item.current_period_end : null;
  return { start, end };
}

function readInvoiceSubId(inv: Stripe.Invoice): string | null {
  // SDK types Invoice.subscription as string|null|Subscription, but on this
  // API version that field is always null and the id moved to
  // parent.subscription_details.subscription. Cast contained here.
  const v = (inv as any).parent?.subscription_details?.subscription;
  return typeof v === 'string' ? v : null;
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
          const session = event.data.object as Stripe.Checkout.Session;
          const subId = typeof session.subscription === 'string' ? session.subscription : null;
          const custId = typeof session.customer === 'string' ? session.customer : null;
          if (!subId || !custId) {
            logger.warn({ eventId: event.id }, 'checkout.session.completed missing sub/customer; noop');
            res.status(200).json({ noop: true });
            return;
          }
          // Read-policy: prefer Session metadata, fall back to Subscription metadata.
          let { userId, studioId } = readSessionMetadata(session);
          const sub = await deps.stripe.subscriptions.retrieve(subId);
          if (!userId || !studioId) {
            const fromSub = readSubscriptionMetadata(sub);
            userId = userId ?? fromSub.userId;
            studioId = studioId ?? fromSub.studioId;
          }
          if (!userId || !studioId) {
            logger.warn({ eventId: event.id, subId }, 'checkout.session.completed missing metadata on session AND subscription; noop');
            res.status(200).json({ noop: true });
            return;
          }
          const { start, end } = readSubPeriod(sub);
          if (start === null || end === null) {
            // Per Plan 5 round-2 correction: missing period is a contract failure,
            // not a noop. Throwing rolls back the ledger and lets Stripe retry.
            throw new Error(`subscription ${subId} missing items.data[0].current_period_*`);
          }
          const { error: upsertErr } = await supabase
            .from('subscriptions')
            .upsert(
              {
                user_id: userId,
                studio_id: studioId,
                stripe_subscription_id: subId,
                stripe_customer_id: custId,
                status: mapStripeStatus(sub.status),
                current_period_start: new Date(start * 1000).toISOString(),
                current_period_end: new Date(end * 1000).toISOString(),
                cancel_at_period_end: !!sub.cancel_at_period_end,
              },
              { onConflict: 'user_id,studio_id' },
            );
          if (upsertErr) throw upsertErr;
          res.status(200).json({ ok: true });
          return;
        }
        case 'invoice.payment_succeeded': {
          const inv = event.data.object as Stripe.Invoice;
          if (inv.billing_reason !== 'subscription_cycle') {
            logger.info(
              { eventId: event.id, billingReason: inv.billing_reason },
              'invoice.payment_succeeded: not subscription_cycle, noop',
            );
            res.status(200).json({ noop: true });
            return;
          }
          const subId = readInvoiceSubId(inv);
          const period = inv.lines?.data?.[0]?.period;
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
            logger.warn(
              { eventId: event.id, subId },
              'invoice.payment_succeeded: no matching sub row (race or orphan)',
            );
            res.status(200).json({ noop: true });
            return;
          }
          res.status(200).json({ ok: true });
          return;
        }
        case 'invoice.payment_failed': {
          const inv = event.data.object as Stripe.Invoice;
          const subId = readInvoiceSubId(inv);
          if (!subId) {
            logger.warn({ eventId: event.id }, 'invoice.payment_failed missing subscription id; noop');
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
            logger.warn(
              { eventId: event.id, subId },
              'invoice.payment_failed: no matching sub row (race or orphan)',
            );
            res.status(200).json({ noop: true });
            return;
          }
          res.status(200).json({ ok: true });
          return;
        }
        case 'customer.subscription.updated': {
          const sub = event.data.object as Stripe.Subscription;
          const subId = typeof sub.id === 'string' ? sub.id : null;
          if (!subId) {
            res.status(200).json({ noop: true });
            return;
          }
          const { start, end } = readSubPeriod(sub);
          const update = {
            status: mapStripeStatus(sub.status),
            cancel_at_period_end: !!sub.cancel_at_period_end,
            ...(start !== null ? { current_period_start: new Date(start * 1000).toISOString() } : {}),
            ...(end !== null ? { current_period_end: new Date(end * 1000).toISOString() } : {}),
          };
          const { data: updated, error: updateErr } = await supabase
            .from('subscriptions')
            .update(update)
            .eq('stripe_subscription_id', subId)
            .select('id');
          if (updateErr) throw updateErr;
          if (!updated || updated.length === 0) {
            logger.warn(
              { eventId: event.id, subId },
              'customer.subscription.updated: no matching sub row (race or orphan)',
            );
            res.status(200).json({ noop: true });
            return;
          }
          res.status(200).json({ ok: true });
          return;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          const subId = typeof sub.id === 'string' ? sub.id : null;
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
            logger.warn(
              { eventId: event.id, subId },
              'customer.subscription.deleted: no matching sub row (race or orphan)',
            );
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
      // Roll back the ledger so Stripe's retry reprocesses instead of
      // short-circuiting on the unique-constraint duplicate path. If THIS
      // delete itself fails (transient DB error), the row stays and the
      // next retry will be silently swallowed by the duplicate short-circuit
      // — i.e. permanent data loss. Log loudly so on-call can spot poisoned
      // ledger rows; no auto-recovery here is intentional.
      try {
        await supabase.from('stripe_webhook_events').delete().eq('event_id', event.id);
        logger.error({ err, eventId: event.id, type: event.type }, 'stripe webhook handler failed; ledger rolled back');
      } catch (rollbackErr) {
        logger.error(
          { err, rollbackErr, eventId: event.id, type: event.type },
          'stripe webhook handler failed AND ledger rollback failed; ledger row poisoned, future retries will short-circuit',
        );
      }
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
    }
  };

  router.post('/', handler);
  return router;
}
