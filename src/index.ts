import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { studiosRouter } from './routes/studios.js';
import { meRouter } from './routes/me.js';
import { createVideosRouter } from './routes/videos.js';
import { createMuxWebhookRouter } from './routes/muxWebhook.js';
import { createStripeWebhookRouter } from './routes/stripeWebhook.js';
import { createSubscriptionsRouter } from './routes/subscriptions.js';
import { createSubscribePagesRouter } from './routes/subscribePages.js';
import { errorHandler } from './middleware/errorHandler.js';
import { mux as defaultMux, type MuxClient } from './mux.js';
import { stripe as defaultStripe } from './stripe.js';
import type Stripe from 'stripe';

export interface AppDeps {
  mux?: Pick<MuxClient, 'video' | 'webhooks'>;
  stripe?: Pick<Stripe, 'checkout' | 'subscriptions' | 'customers' | 'webhooks'>;
}

export function createApp(deps: AppDeps = {}): Express {
  const mux = deps.mux ?? defaultMux;
  const stripe = deps.stripe ?? defaultStripe;
  const app = express();
  app.use(pinoHttp({ logger }));

  // IMPORTANT: the Mux webhook route must receive the RAW body (Buffer) so that
  // HMAC signature verification works. Mount it with express.raw() BEFORE the
  // global express.json() parser.
  app.use(
    '/webhooks/mux',
    express.raw({ type: 'application/json' }),
    createMuxWebhookRouter({ mux }),
  );

  app.use(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    createStripeWebhookRouter({ stripe }),
  );

  app.use(express.json());
  app.use('/health', healthRouter);
  app.use('/studios', studiosRouter);
  app.use('/me', meRouter);
  app.use('/subscriptions', createSubscriptionsRouter({ stripe }));
  app.use('/subscribe', createSubscribePagesRouter());
  app.use('/', createVideosRouter({ mux }));
  app.use(errorHandler);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server listening');
  });
}
