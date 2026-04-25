import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';

describe('subscribe landing pages', () => {
  it('GET /subscribe/success returns 200 text/html', async () => {
    const app = createApp();
    const res = await request(app).get('/subscribe/success');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/subscribed/i);
  });

  it('GET /subscribe/cancel returns 200 text/html', async () => {
    const app = createApp();
    const res = await request(app).get('/subscribe/cancel');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/canceled|cancelled/i);
  });
});
