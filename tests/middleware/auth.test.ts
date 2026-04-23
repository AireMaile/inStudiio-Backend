import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../src/middleware/auth.js';

const JWT_SECRET = 'test-jwt-secret-abc123';

function makeApp() {
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
    const app = makeApp();
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects malformed Authorization header with 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/protected').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
  });

  it('rejects invalid JWT with 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/protected').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects JWT signed with wrong secret', async () => {
    const app = makeApp();
    const wrong = jwt.sign({ sub: 'u1' }, 'wrong-secret', { algorithm: 'HS256' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${wrong}`);
    expect(res.status).toBe(401);
  });

  it('rejects expired JWT with 401', async () => {
    const app = makeApp();
    const expired = jwt.sign(
      { sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 },
      JWT_SECRET,
      { algorithm: 'HS256' },
    );
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('accepts valid JWT and attaches req.user', async () => {
    const app = makeApp();
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
