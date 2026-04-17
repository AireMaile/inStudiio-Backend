import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

beforeAll(() => {
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
  process.env.SUPABASE_JWT_SECRET = 'x';
  process.env.NODE_ENV = 'test';
});

async function makeApp(handler: express.RequestHandler) {
  const { errorHandler, ApiError } = await import('../../src/middleware/errorHandler.js');
  const app = express();
  app.get('/throw', handler);
  app.use(errorHandler);
  return { app, ApiError };
}

describe('errorHandler middleware', () => {
  it('returns 500 internal for uncaught errors', async () => {
    const { app } = await makeApp((_req, _res, next) => next(new Error('boom')));
    const res = await request(app).get('/throw');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'internal', message: 'Internal server error' });
  });

  it('returns the ApiError status + code + message verbatim', async () => {
    const { app, ApiError } = await makeApp((_req, _res, next) =>
      next(new ApiError(404, 'not_found', 'Widget not found')),
    );
    const res = await request(app).get('/throw');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'not_found', message: 'Widget not found' });
  });
});
