import { describe, it, expect } from 'vitest';
import { mux, createMuxClient } from '../src/mux.js';

describe('mux client', () => {
  it('exports a Mux instance with video and webhooks namespaces', () => {
    expect(mux).toBeDefined();
    expect(mux.video).toBeDefined();
    expect(mux.video.uploads).toBeDefined();
    expect(mux.video.assets).toBeDefined();
    expect(mux.webhooks).toBeDefined();
    expect(typeof mux.webhooks.unwrap).toBe('function');
  });

  it('createMuxClient returns a fresh instance', () => {
    const a = createMuxClient();
    const b = createMuxClient();
    expect(a).not.toBe(b);
    expect(a.video).toBeDefined();
  });
});
