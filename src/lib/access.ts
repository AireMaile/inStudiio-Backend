import type { DB } from '../supabase.js';

export interface AccessDeps {
  supabase: DB;
}

/**
 * Returns true iff the given user has a row in `subscriptions` for the given
 * studio with status='active'. Does NOT check ownership — owner access is
 * handled separately in routes.
 */
export async function hasActiveSubscription(
  deps: AccessDeps,
  userId: string,
  studioId: string,
): Promise<boolean> {
  const { data, error } = await deps.supabase
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('studio_id', studioId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}
