import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
  process.env.SUPABASE_JWT_SECRET = 'x';
});

describe('env loader', () => {
  it('parses a valid env object', async () => {
    const { parseEnv } = await import('../src/env.js');
    const result = parseEnv({
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
      SUPABASE_JWT_SECRET: 'fake-jwt-secret',
      PORT: '3000',
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
    expect(result.SUPABASE_URL).toBe('http://localhost:54321');
    expect(result.PORT).toBe(3000);
  });

  it('throws when a required var is missing', async () => {
    const { parseEnv } = await import('../src/env.js');
    expect(() => parseEnv({ PORT: '3000' })).toThrow();
  });

  it('throws when PORT is not numeric', async () => {
    const { parseEnv } = await import('../src/env.js');
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
