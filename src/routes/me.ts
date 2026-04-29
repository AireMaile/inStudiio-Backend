import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const STUDIO_FIELDS = 'id, name, slug, description, price_monthly, created_at' as const;

const SUBSCRIPTION_FIELDS =
  'id, status, current_period_start, current_period_end, cancel_at_period_end, ' +
  `studio:studios(${STUDIO_FIELDS})`;

const ListQuery = z.object({
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['active', 'past_due', 'canceled', 'incomplete']).optional(),
  ),
  studio_id: z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid().optional()),
});

export const meRouter = Router();

meRouter.use(requireAuth);

meRouter.get('/studios', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
    const { data, error } = await supabase
      .from('studios')
      .select(STUDIO_FIELDS)
      .eq('owner_user_id', req.user.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ studios: data ?? [] });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', parsed.error.issues[0]?.message ?? 'invalid query params');
    }

    let query = supabase
      .from('subscriptions')
      .select(SUBSCRIPTION_FIELDS)
      .eq('user_id', req.user.id);

    if (parsed.data.status) query = query.eq('status', parsed.data.status);
    if (parsed.data.studio_id) query = query.eq('studio_id', parsed.data.studio_id);

    const { data, error } = await query
      .order('current_period_end', { ascending: false })
      .order('id', { ascending: true });
    if (error) throw error;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ subscriptions: data ?? [] });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/subscriptions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');
    }

    const { data, error } = await supabase
      .from('subscriptions')
      .select(SUBSCRIPTION_FIELDS)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ subscription: data });
  } catch (err) {
    next(err);
  }
});
