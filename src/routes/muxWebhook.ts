import { Router, type RequestHandler } from 'express';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { MuxClient } from '../mux.js';

export interface MuxWebhookDeps {
  mux: Pick<MuxClient, 'webhooks'>;
}

export function createMuxWebhookRouter(deps: MuxWebhookDeps): Router {
  const router = Router();

  const handler: RequestHandler = async (req, res) => {
    // `express.raw` produces a Buffer; the Mux SDK's unwrap() requires the
    // exact raw JSON string used when signing.
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    let event: { type: string; id: string; data: any };
    try {
      event = (await deps.mux.webhooks.unwrap(
        rawBody,
        req.headers as Record<string, string | string[]>,
        env.MUX_WEBHOOK_SECRET,
      )) as any;
    } catch (err) {
      logger.warn({ err }, 'mux webhook signature rejected');
      res
        .status(400)
        .json({ error: { code: 'invalid_signature', message: 'invalid webhook signature' } });
      return;
    }

    // Event handling (idempotency ledger, status updates) is wired in the next task.
    // For now, acknowledge any signed event.
    logger.info({ eventId: event.id, type: event.type }, 'mux webhook accepted (no-op handler)');
    res.status(200).json({ received: true });
  };

  router.post('/', handler);
  return router;
}
