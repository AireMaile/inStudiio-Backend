import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use('/health', healthRouter);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server listening');
  });
}
