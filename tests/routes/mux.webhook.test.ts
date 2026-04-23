import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { signMuxPayload } from '../helpers/muxSignature.js';
import { env } from '../../src/env.js';

function postWebhook(app: any, body: any, opts?: { ts?: number; sig?: string; secret?: string }) {
  const raw = JSON.stringify(body);
  const ts = opts?.ts ?? Math.floor(Date.now() / 1000);
  const sig = opts?.sig ?? signMuxPayload(raw, ts, opts?.secret ?? env.MUX_WEBHOOK_SECRET);
  return request(app)
    .post('/webhooks/mux')
    .set('Content-Type', 'application/json')
    .set('Mux-Signature', sig)
    .send(raw);
}

describe('POST /webhooks/mux — signature verification', () => {
  it('returns 200 on a valid signature for an unknown event type', async () => {
    const app = createApp();
    const body = {
      type: 'video.asset.something_unknown',
      id: 'evt_' + Math.random().toString(36).slice(2, 8),
      data: { passthrough: 'irrelevant' },
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);
  });

  it('returns 400 on a bad signature', async () => {
    const app = createApp();
    const body = { type: 'video.asset.ready', id: 'evt_x', data: {} };
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/webhooks/mux')
      .set('Content-Type', 'application/json')
      .set('Mux-Signature', `t=${ts},v1=deadbeef`)
      .send(raw);
    expect(res.status).toBe(400);
  });

  it('returns 400 on an expired timestamp (>300s old)', async () => {
    const app = createApp();
    const body = { type: 'video.asset.ready', id: 'evt_y', data: {} };
    const res = await postWebhook(app, body, { ts: Math.floor(Date.now() / 1000) - 400 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when Mux-Signature header is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/webhooks/mux')
      .set('Content-Type', 'application/json')
      .send({ type: 'x', id: 'y', data: {} });
    expect(res.status).toBe(400);
  });
});
