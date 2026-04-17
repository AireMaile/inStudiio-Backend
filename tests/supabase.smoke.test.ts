import { describe, it, expect } from 'vitest';

describe('supabase service-role client', () => {
  it('connects and reads from public.studios', async () => {
    const { supabase } = await import('../src/supabase.js');
    const { data, error } = await supabase.from('studios').select('id').limit(1);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});
