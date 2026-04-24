import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type Stripe from 'stripe';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const CreateBody = z.object({ studioId: z.string().uuid() });
const BLOCKING_STATUSES = new Set(['active', 'past_due', 'incomplete']);

export interface SubscriptionsDeps {
  stripe: Pick<Stripe, 'checkout' | 'customers' | 'subscriptions'>;
}

export function createSubscriptionsRouter(_deps: SubscriptionsDeps): Router {
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

      // Tasks 16 + 17 replace this placeholder.
      throw new ApiError(500, 'internal', 'checkout session creation not yet implemented');
    } catch (err) {
      next(err);
    }
  };

  router.post('/', requireAuth, createSubscription);
  return router;
}
