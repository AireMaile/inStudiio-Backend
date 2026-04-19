import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { studiosRouter } from './routes/studios.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp(): Express {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use('/health', healthRouter);
  app.use('/studios', studiosRouter);
  app.use(errorHandler);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server listening');
  });
}
