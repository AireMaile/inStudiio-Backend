import { describe, it, expect } from 'vitest';
import { supabase } from '../src/supabase.js';

describe('supabase service-role client', () => {
  it('connects and reads from public.studios', async () => {
    const { data, error } = await supabase.from('studios').select('id').limit(1);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});
