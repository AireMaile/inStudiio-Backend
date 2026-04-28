import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { env } from '../env.js';
import type { StripeDeps } from '../types/stripeDeps.js';

const CreateBody = z.object({ studioId: z.string().uuid() });
const BLOCKING_STATUSES = new Set(['active', 'past_due', 'incomplete']);

export interface SubscriptionsDeps {
  stripe: Pick<StripeDeps, 'checkout' | 'customers' | 'subscriptions'>;
}

export function createSubscriptionsRouter(deps: SubscriptionsDeps): Router {
  const router = Router();

  const createSubscription: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body');
      }
      const { studioId } = parsed.data;

      const { data: studio, error: studioErr } = await supabase
        .from('studios')
        .select('id, stripe_price_id')
        .eq('id', studioId)
        .maybeSingle();
      if (studioErr) throw studioErr;
      if (!studio || !studio.stripe_price_id) {
        throw new ApiError(404, 'studio_not_found', 'studio not found');
      }

      const { data: existing, error: existingErr } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', req.user.id)
        .eq('studio_id', studio.id)
        .maybeSingle();
      if (existingErr) throw existingErr;
      if (existing && BLOCKING_STATUSES.has(existing.status)) {
        throw new ApiError(409, 'already_subscribed', 'You already have an active subscription to this studio.');
      }

      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('email, stripe_customer_id')
        .eq('id', req.user.id)
        .single();
      if (profileErr || !profile) throw profileErr ?? new Error('profile not found');

      let customerId = profile.stripe_customer_id;
      if (!customerId) {
        try {
          const customer = await deps.stripe.customers.create({
            email: profile.email,
            metadata: { user_id: req.user.id },
          });
          customerId = customer.id;
        } catch (stripeErr) {
          req.log?.error({ err: stripeErr }, 'stripe customers.create failed');
          throw new ApiError(502, 'stripe_error', 'Payment provider is temporarily unavailable. Please try again.');
        }
        const { error: updProfileErr } = await supabase
          .from('profiles')
          .update({ stripe_customer_id: customerId })
          .eq('id', req.user.id);
        if (updProfileErr) throw updProfileErr;
      }

      const baseUrl = env.APP_ORIGIN ?? `http://localhost:${env.PORT}`;
      // Write metadata to BOTH the Session (for checkout.session.completed
      // direct read) AND subscription_data (for downstream subscription.*
      // events that only carry subscription metadata). See Plan 5
      // billing-contract: dual write, named read-policy.
      const checkoutMetadata = { user_id: req.user.id, studio_id: studio.id };
      let session: { url: string | null };
      try {
        session = await deps.stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          line_items: [{ price: studio.stripe_price_id, quantity: 1 }],
          metadata: checkoutMetadata,
          subscription_data: { metadata: checkoutMetadata },
          success_url: `${baseUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl}/subscribe/cancel`,
        });
      } catch (stripeErr) {
        req.log?.error({ err: stripeErr }, 'stripe checkout.sessions.create failed');
        throw new ApiError(502, 'stripe_error', 'Payment provider is temporarily unavailable. Please try again.');
      }
      if (!session.url) {
        throw new ApiError(502, 'stripe_error', 'Stripe did not return a checkout URL');
      }
      res.status(200).json({ checkoutUrl: session.url });
      return;
    } catch (err) {
      next(err);
    }
  };

  const cancelSubscription: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
      const id = String(req.params.id ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');
      }

      const { data: sub, error: subErr } = await supabase
        .from('subscriptions')
        .select('id, user_id, status, stripe_subscription_id')
        .eq('id', id)
        .maybeSingle();
      if (subErr) throw subErr;
      if (!sub || sub.user_id !== req.user.id) {
        throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');
      }
      if (sub.status === 'canceled') {
        throw new ApiError(409, 'not_cancelable', 'Subscription is already canceled.');
      }

      try {
        await deps.stripe.subscriptions.update(sub.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
      } catch (stripeErr) {
        req.log?.error({ err: stripeErr, subId: sub.id }, 'stripe subscriptions.update failed');
        throw new ApiError(502, 'stripe_error', 'Payment provider is temporarily unavailable. Please try again.');
      }

      // Optimistic narrow write: only cancel_at_period_end. The webhook
      // (customer.subscription.updated) remains authoritative for status,
      // period, and everything else. If this write fails after Stripe
      // accepted, log loudly — the webhook will reconcile within seconds.
      const { error: localUpdErr } = await supabase
        .from('subscriptions')
        .update({ cancel_at_period_end: true })
        .eq('id', sub.id);
      if (localUpdErr) {
        req.log?.warn(
          { err: localUpdErr, subId: sub.id },
          'cancel optimistic local write failed; webhook will reconcile',
        );
      }

      res.status(200).json({ canceled: true, cancelAtPeriodEnd: true });
    } catch (err) {
      next(err);
    }
  };

  router.post('/', requireAuth, createSubscription);
  router.delete('/:id', requireAuth, cancelSubscription);
  return router;
}
