import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

beforeAll(() => {
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
  process.env.NODE_ENV = 'test';
});

describe('GET /health', () => {
  it('returns 200 with ok status', async () => {
    const { createApp } = await import('../src/index.js');
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof res.body.uptime).toBe('number');
  });
});
