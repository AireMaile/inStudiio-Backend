import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/index.js';

describe('GET /health', () => {
  it('returns 200 with ok status', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof res.body.uptime).toBe('number');
  });
});
