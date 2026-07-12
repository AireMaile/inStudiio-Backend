import { describe, it, expect } from 'vitest';
import { pickPlayback } from '../../src/lib/playbackIds.js';

describe('pickPlayback', () => {
  it('prefers a signed playback id', () => {
    expect(
      pickPlayback([
        { policy: 'public', id: 'pub_1' },
        { policy: 'signed', id: 'sig_1' },
      ]),
    ).toEqual({ policy: 'signed', id: 'sig_1' });
  });

  it('falls back to a public playback id for legacy assets', () => {
    expect(pickPlayback([{ policy: 'public', id: 'pub_1' }])).toEqual({
      policy: 'public',
      id: 'pub_1',
    });
  });

  it('returns null when there are no playback ids', () => {
    expect(pickPlayback([])).toBeNull();
  });

  it('ignores entries with unknown policies', () => {
    expect(pickPlayback([{ policy: 'drm' as any, id: 'x' }])).toBeNull();
  });
});
