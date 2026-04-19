import { Router, type Request, type Response, type NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const STUDIO_FIELDS = 'id, name, slug, description, price_monthly, created_at' as const;

export const meRouter = Router();

meRouter.use(requireAuth);

meRouter.get('/studios', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'unauthorized', 'missing user');
    const { data, error } = await supabase
      .from('studios')
      .select(STUDIO_FIELDS)
      .eq('owner_user_id', req.user.id)
      .order('created_at', { ascending: true });
    if (error) throw new ApiError(500, 'internal', error.message);
    res.json({ studios: data ?? [] });
  } catch (err) {
    next(err);
  }
});
