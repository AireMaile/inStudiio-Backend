import { timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { env } from '../env.js';
import { reconcileMuxVideos } from '../jobs/reconcileMuxVideos.js';
import { logger } from '../logger.js';
import type { MuxClient } from '../mux.js';

export interface InternalJobsDeps {
  mux: Pick<MuxClient, 'video'>;
}

function hasExpectedBearer(value: string | undefined, secret: string | undefined): boolean {
  if (!value || !secret) return false;
  const actual = Buffer.from(value, 'utf8');
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createInternalJobsRouter(deps: InternalJobsDeps): Router {
  const router = Router();

  const runMuxReconciliation: RequestHandler = async (req, res) => {
    if (!hasExpectedBearer(req.header('authorization'), env.CRON_SECRET)) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Unauthorized' } });
      return;
    }

    try {
      const summary = await reconcileMuxVideos({ mux: deps.mux });
      res.status(200).json({ ok: true, summary });
    } catch (err) {
      logger.error({ err }, 'internal Mux reconciliation job failed');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
    }
  };

  router.post('/mux-reconciliation', runMuxReconciliation);
  return router;
}
