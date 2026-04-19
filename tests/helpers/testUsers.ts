import jwt from 'jsonwebtoken';
import { supabase } from '../../src/supabase.js';
import { env } from '../../src/env.js';

export interface TestUser {
  id: string;
  email: string;
}

/**
 * Creates an auth user via the admin API. Returns { id, email }.
 * The `on_auth_user_created` trigger (migration 0002) syncs a profile row.
 */
export async function createTestUser(emailPrefix: string): Promise<TestUser> {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('createUser returned no user');
  return { id: data.user.id, email: data.user.email! };
}

export async function deleteTestUser(id: string): Promise<void> {
  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) throw error;
}

export function signUserToken(user: TestUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' },
    env.SUPABASE_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}
