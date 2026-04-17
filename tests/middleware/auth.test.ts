import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret-abc123';

beforeAll(() => {
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = 'test';
});

async function makeApp() {
  const { requireAuth } = await import('../../src/middleware/auth.js');
  const app = express();
  app.get('/protected', requireAuth, (req, res) => {
    res.json({ userId: (req as any).user.id });
  });
  return app;
}

function signToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
}

describe('requireAuth middleware', () => {
  it('rejects missing Authorization header with 401', async () => {
    const app = await makeApp();
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects malformed Authorization header with 401', async () => {
    const app = await makeApp();
    const res = await request(app).get('/protected').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
  });

  it('rejects invalid JWT with 401', async () => {
    const app = await makeApp();
    const res = await request(app).get('/protected').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects JWT signed with wrong secret', async () => {
    const app = await makeApp();
    const wrong = jwt.sign({ sub: 'u1' }, 'wrong-secret', { algorithm: 'HS256' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${wrong}`);
    expect(res.status).toBe(401);
  });

  it('rejects expired JWT with 401', async () => {
    const app = await makeApp();
    const expired = jwt.sign(
      { sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 },
      JWT_SECRET,
      { algorithm: 'HS256' },
    );
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('accepts valid JWT and attaches req.user', async () => {
    const app = await makeApp();
    const token = signToken({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('11111111-1111-1111-1111-111111111111');
  });
});
