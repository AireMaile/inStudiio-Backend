import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { studiosRouter } from './routes/studios.js';
import { meRouter } from './routes/me.js';
import { createVideosRouter } from './routes/videos.js';
import { errorHandler } from './middleware/errorHandler.js';
import { mux as defaultMux, type MuxClient } from './mux.js';

export interface AppDeps {
  mux?: Pick<MuxClient, 'video' | 'webhooks'>;
}

export function createApp(deps: AppDeps = {}): Express {
  const mux = deps.mux ?? defaultMux;
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use('/health', healthRouter);
  app.use('/studios', studiosRouter);
  app.use('/me', meRouter);
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
