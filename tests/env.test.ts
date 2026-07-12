import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/env.js';

const VALID_ENV = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_JWT_SECRET: 'fake-jwt-secret',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  MUX_TOKEN_ID: 'fake-mux-id',
  MUX_TOKEN_SECRET: 'fake-mux-secret',
  MUX_WEBHOOK_SECRET: 'fake-mux-webhook-secret',
  MUX_SIGNING_KEY_ID: 'fake-mux-signing-key-id',
  MUX_SIGNING_PRIVATE_KEY: 'ZmFrZS1wcml2YXRlLWtleQ==',
  PORT: '3000',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
};

describe('env loader', () => {
  it('parses a valid env object', () => {
    const result = parseEnv(VALID_ENV);
    expect(result.SUPABASE_URL).toBe('http://localhost:54321');
    expect(result.PORT).toBe(3000);
  });

  it('rejects when MUX_SIGNING_KEY_ID is missing', () => {
    const { MUX_SIGNING_KEY_ID: _omit, ...rest } = VALID_ENV;
    expect(() => parseEnv(rest)).toThrow();
  });

  it('rejects when MUX_SIGNING_PRIVATE_KEY is missing', () => {
    const { MUX_SIGNING_PRIVATE_KEY: _omit, ...rest } = VALID_ENV;
    expect(() => parseEnv(rest)).toThrow();
  });

  it('throws when a required var is missing', () => {
    expect(() => parseEnv({ PORT: '3000' })).toThrow();
  });

  it('rejects when STRIPE_SECRET_KEY is missing', () => {
    expect(() =>
      parseEnv({
        SUPABASE_URL: 'http://localhost:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'srv',
        SUPABASE_JWT_SECRET: 'jwt',
      }),
    ).toThrow();
  });

  it('throws when PORT is not numeric', () => {
    expect(() =>
      parseEnv({
        SUPABASE_URL: 'http://localhost:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'x',
        SUPABASE_JWT_SECRET: 'x',
        PORT: 'abc',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
      }),
    ).toThrow();
  });
});
