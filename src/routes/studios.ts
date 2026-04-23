import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { ApiError } from '../middleware/errorHandler.js';

export const studiosRouter = Router();

const querySchema = z.object({
  limit: z.coerce.number().int().optional().default(20),
  offset: z.coerce.number().int().optional().default(0),
});

const listStudios: RequestHandler = async (req, res, next) => {
  try {
    // Reject non-numeric or NaN values before coercion succeeds incorrectly
    const rawLimit = req.query.limit as string | undefined;
    const rawOffset = req.query.offset as string | undefined;

    if (rawLimit !== undefined && !/^-?\d+$/.test(rawLimit)) {
      throw new ApiError(400, 'bad_request', 'limit must be an integer');
    }
    if (rawOffset !== undefined && !/^-?\d+$/.test(rawOffset)) {
      throw new ApiError(400, 'bad_request', 'offset must be an integer');
    }

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'invalid query params');
    }

    const { limit: rawLimitNum, offset } = parsed.data;

    if (rawLimitNum < 1) {
      throw new ApiError(400, 'bad_request', 'limit must be >= 1');
    }
    if (offset < 0) {
      throw new ApiError(400, 'bad_request', 'offset must be >= 0');
    }

    const limit = Math.min(rawLimitNum, 100);

    const { data, error, count } = await supabase
      .from('studios')
      .select('id, name, slug, description, price_monthly, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.status(200).json({
      studios: data ?? [],
      pagination: { limit, offset, total: count ?? 0 },
    });
  } catch (err) {
    next(err);
  }
};

studiosRouter.get('/', listStudios);
