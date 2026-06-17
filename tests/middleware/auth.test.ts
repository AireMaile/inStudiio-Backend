import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as jose from 'jose';
import { requireAuth, makeRequireAuth } from '../../src/middleware/auth.js';

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

// --- ES256 / JWKS helpers (mirrors how production Supabase signs user tokens) ---

interface Es256Fixture {
  privateKey: jose.CryptoKey;
  jwks: ReturnType<typeof jose.createLocalJWKSet>;
  kid: string;
}

async function makeEs256(kid = 'test-es256-kid'): Promise<Es256Fixture> {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'ES256';
  const jwks = jose.createLocalJWKSet({ keys: [jwk] });
  return { privateKey, jwks, kid };
}

async function signEs256(
  fx: Es256Fixture,
  claims: jose.JWTPayload,
  { expiresIn = '1h' }: { expiresIn?: string | number } = {},
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: fx.kid })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(fx.privateKey);
}

function makeAppWithJwks(jwks: jose.JWTVerifyGetKey): express.Express {
  const app = express();
  app.get('/protected', makeRequireAuth({ jwks }), (req, res) => {
    res.json({ userId: (req as any).user.id, email: (req as any).user.email });
  });
  return app;
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

describe('requireAuth middleware — ES256 / JWKS (production Supabase signing keys)', () => {
  it('accepts a valid ES256 token verified against the JWKS and attaches req.user', async () => {
    const fx = await makeEs256();
    const app = makeAppWithJwks(fx.jwks);
    const token = await signEs256(fx, {
      sub: '22222222-2222-2222-2222-222222222222',
      email: 'es256@example.com',
      aud: 'authenticated',
      role: 'authenticated',
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('22222222-2222-2222-2222-222222222222');
    expect(res.body.email).toBe('es256@example.com');
  });

  it('rejects an ES256 token signed by a key NOT in the JWKS with 401', async () => {
    const trusted = await makeEs256('trusted-kid');
    const attacker = await makeEs256('attacker-kid');
    const app = makeAppWithJwks(trusted.jwks); // app trusts only `trusted`
    const token = await signEs256(attacker, {
      sub: '33333333-3333-3333-3333-333333333333',
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects an expired ES256 token with 401', async () => {
    const fx = await makeEs256();
    const app = makeAppWithJwks(fx.jwks);
    const token = await signEs256(
      fx,
      { sub: '44444444-4444-4444-4444-444444444444' },
      { expiresIn: Math.floor(Date.now() / 1000) - 60 },
    );
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('still accepts a legacy HS256 token (shared-secret fallback)', async () => {
    const fx = await makeEs256();
    const app = makeAppWithJwks(fx.jwks);
    const hs = signToken({
      sub: '55555555-5555-5555-5555-555555555555',
      email: 'legacy@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${hs}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('55555555-5555-5555-5555-555555555555');
  });

  it('rejects a token with no subject claim with 401', async () => {
    const fx = await makeEs256();
    const app = makeAppWithJwks(fx.jwks);
    const token = await signEs256(fx, { email: 'nosub@example.com' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
