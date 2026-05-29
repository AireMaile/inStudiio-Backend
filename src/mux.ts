import { Mux } from '@mux/mux-node';
import { env } from './env.js';

export function createMuxClient(): Mux {
  return new Mux({
    tokenId: env.MUX_TOKEN_ID,
    tokenSecret: env.MUX_TOKEN_SECRET,
  });
}

export const mux: Mux = createMuxClient();
export type MuxClient = Mux;
