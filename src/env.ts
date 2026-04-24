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
    APP_ORIGIN: z.string().url().optional(),
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine(
    (v) => v.NODE_ENV !== 'production' || !!v.APP_ORIGIN,
    { message: 'APP_ORIGIN is required when NODE_ENV=production', path: ['APP_ORIGIN'] },
  );

export type Env = z.infer<typeof Schema>;

export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return Schema.parse(raw);
}

export const env: Env = parseEnv(process.env);
