import 'dotenv/config';
import { z } from 'zod';

const Schema = z
  .object({
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_JWT_SECRET: z.string().min(1),
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    MUX_TOKEN_ID: z.string().min(1),
    MUX_TOKEN_SECRET: z.string().min(1),
    MUX_WEBHOOK_SECRET: z.string().min(1),
    // Signing key pair for signed playback URLs (Settings → Signing Keys in the
    // Mux dashboard). The private key is stored base64-encoded, exactly as Mux
    // hands it out. Required: without it, entitled users can't be issued
    // playback tokens and signed assets are unplayable.
    MUX_SIGNING_KEY_ID: z.string().min(1),
    MUX_SIGNING_PRIVATE_KEY: z.string().min(1),
    // Shared secret for the internal reconciliation worker endpoint. Supabase
    // Cron sends it as an exact Bearer token from Vault.
    CRON_SECRET: z.string().min(16).optional(),
    APP_ORIGIN: z.string().url().optional(),
    // Comma-separated list of allowed CORS origins for cross-origin frontend
    // dev (e.g. "http://localhost:5173,http://localhost:3001"). Empty/unset
    // defaults to "*" in non-production environments. In production, must be
    // an explicit list.
    CORS_ORIGINS: z.string().optional(),
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine(
    (v) => v.NODE_ENV !== 'production' || !!v.APP_ORIGIN,
    { message: 'APP_ORIGIN is required when NODE_ENV=production', path: ['APP_ORIGIN'] },
  )
  .refine(
    (v) => v.NODE_ENV !== 'production' || !!v.CRON_SECRET,
    { message: 'CRON_SECRET is required when NODE_ENV=production', path: ['CRON_SECRET'] },
  );

export type Env = z.infer<typeof Schema>;

export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return Schema.parse(raw);
}

export const env: Env = parseEnv(process.env);
