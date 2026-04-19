// Seeds env vars BEFORE any test file imports src/env.ts (which eagerly parses).
// Registered via vitest `setupFiles` so it runs once per test worker before any
// test module is evaluated. Values here must satisfy src/env.ts's zod schema.
//
// Load .env first so integration tests get real local Supabase / Stripe test-mode
// credentials (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY).
//
// SUPABASE_JWT_SECRET is force-overridden to a known test value so auth-middleware
// tests can sign tokens that verify against it. This is safe because the service-
// role client bypasses JWT verification entirely — the JWT secret only matters for
// verifying user tokens in middleware, which is exactly what those tests exercise.
import 'dotenv/config';

if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = 'http://localhost:54321';
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret-abc123';
if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
process.env.NODE_ENV = 'test';
