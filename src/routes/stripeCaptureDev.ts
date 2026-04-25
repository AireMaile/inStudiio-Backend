import { Router, type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * DEVELOPMENT-ONLY route. Captures raw Stripe webhook deliveries to disk for
 * use as test fixtures. Plan 5 §3 Step 1: the gold standard for "captured
 * reality" is the raw request body Stripe actually delivers, including the
 * `Stripe-Signature` header — NOT a later-fetched event object via
 * `stripe.events.retrieve()` and NOT a CLI-synthesized payload.
 *
 * Usage:
 *   1. Set `STRIPE_CAPTURE_ENABLED=true` in your local .env
 *   2. Boot the server: `pnpm dev`
 *   3. In another terminal: `stripe listen --forward-to localhost:3000/webhooks/stripe-capture`
 *   4. Drive a real testmode Checkout flow (browser, test card 4242 4242 4242 4242)
 *   5. Trigger lifecycle events as needed: `stripe trigger invoice.payment_succeeded` etc.
 *   6. Captured files appear under `tests/fixtures/captured/<event-type>.<ts>.json`
 *   7. Curate down to one canonical capture per event type, drop the timestamp
 *   8. Unset `STRIPE_CAPTURE_ENABLED` and remove this file before opening the
 *      Plan 5 implementation PR — it is scaffolding, not production code.
 *
 * This handler intentionally does NOT verify signatures. Its only job is to
 * persist exactly what comes over the wire. The real `/webhooks/stripe` route
 * handles verification.
 */
export function createStripeCaptureDevRouter(): Router {
  const router = Router();
  const outDir = path.resolve(process.cwd(), 'tests/fixtures/captured');
  fs.mkdirSync(outDir, { recursive: true });

  const handler: RequestHandler = (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    const bodyText = rawBody.toString('utf8');

    let eventType = 'unknown';
    try {
      const parsed = JSON.parse(bodyText);
      if (typeof parsed?.type === 'string') eventType = parsed.type;
    } catch {
      // not JSON — keep eventType=unknown so we still capture for inspection
    }

    const ts = Date.now();
    const safeType = eventType.replace(/[^a-z0-9._-]+/gi, '_');
    const filename = path.join(outDir, `${safeType}.${ts}.json`);

    const record = {
      capturedAt: new Date(ts).toISOString(),
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      body: bodyText,
    };

    fs.writeFileSync(filename, JSON.stringify(record, null, 2));
    logger.info({ eventType, file: path.basename(filename) }, 'stripe-capture: persisted webhook');

    res.status(200).json({ captured: true, eventType, file: path.basename(filename) });
  };

  router.post('/', handler);
  return router;
}
