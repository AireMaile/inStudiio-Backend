import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Envelope shape written by the (now-removed) capture middleware. Each
 * curated capture file at tests/fixtures/captured/<event-type>.json wraps
 * the raw bytes Stripe delivered, plus all headers (notably Stripe-Signature)
 * and a capturedAt timestamp.
 */
interface CaptureEnvelope {
  capturedAt: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Loads a captured Stripe webhook payload from tests/fixtures/captured/
 * and returns it as a typed Stripe.Event. Plan 5 §3 Step 1: this is the
 * single supported way for tests to consume captured reality. Builders
 * in tests/fixtures/stripeEvents.ts use this loader as their source of
 * truth; never hand-author a Stripe event shape.
 */
export function loadCapture(eventType: string): {
  event: Stripe.Event;
  rawBody: string;
  signatureHeader: string | undefined;
  envelope: CaptureEnvelope;
} {
  const file = path.join(__dirname, 'captured', `${eventType}.json`);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as CaptureEnvelope;
  const sigHeader = envelope.headers['stripe-signature'];
  return {
    event: JSON.parse(envelope.body) as Stripe.Event,
    rawBody: envelope.body,
    signatureHeader: typeof sigHeader === 'string' ? sigHeader : undefined,
    envelope,
  };
}
