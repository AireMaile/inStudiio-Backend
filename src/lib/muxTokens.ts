// Short-lived signed playback tokens for Mux.
//
// Assets are created with the `signed` playback policy, so stream.mux.com and
// image.mux.com refuse to serve a playback id unless the request carries a JWT
// signed with our Mux signing key. The API attaches these tokens to video
// responses ONLY after the route's entitlement check (owner or active
// subscriber) — this is what closes the anonymous-access hole: a leaked
// playback id or database row is useless without a token, and tokens expire.
//
// Token shape per Mux docs (https://docs.mux.com/guides/secure-video-playback):
// RS256 JWT with `sub` = playback id, `aud` = 'v' (video) or 't' (thumbnail),
// `kid` header = signing key id.
import jwt from 'jsonwebtoken';
import { env } from '../env.js';

export const DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS = 60 * 60;
export const PLAYBACK_TOKEN_DURATION_BUFFER_SECONDS = 10 * 60;
export const THUMBNAIL_TOKEN_TTL_SECONDS = 15 * 60;

export function playbackTokenTtlSeconds(durationSeconds?: number | null): number {
  if (!Number.isFinite(durationSeconds) || (durationSeconds ?? 0) <= 0) {
    return DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS;
  }
  return Math.max(
    DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS,
    Math.ceil(durationSeconds!) + PLAYBACK_TOKEN_DURATION_BUFFER_SECONDS,
  );
}

export interface SignPlaybackTokenOpts {
  playbackId: string;
  keyId: string;
  /** Base64-encoded PEM private key, exactly as the Mux dashboard hands it out. */
  privateKeyBase64: string;
  /** 'v' = video stream, 't' = thumbnail image. */
  audience: 'v' | 't';
  expiresInSeconds: number;
  /**
   * Extra claims, e.g. image params for thumbnail tokens. Mux ignores unsigned
   * query params on signed URLs, so customization MUST travel in the token.
   */
  params?: Record<string, string>;
}

export function signPlaybackToken(opts: SignPlaybackTokenOpts): string {
  const privateKeyPem = Buffer.from(opts.privateKeyBase64, 'base64').toString('utf8');
  return jwt.sign(opts.params ?? {}, privateKeyPem, {
    algorithm: 'RS256',
    keyid: opts.keyId,
    subject: opts.playbackId,
    audience: opts.audience,
    expiresIn: opts.expiresInSeconds,
  });
}

/** Convenience wrapper reading the signing key pair from env. */
export function signVideoTokens(playbackId: string, durationSeconds?: number | null): {
  playbackToken: string;
  thumbnailToken: string;
} {
  const base = {
    playbackId,
    keyId: env.MUX_SIGNING_KEY_ID,
    privateKeyBase64: env.MUX_SIGNING_PRIVATE_KEY,
  };
  return {
    playbackToken: signPlaybackToken({
      ...base,
      audience: 'v',
      expiresInSeconds: playbackTokenTtlSeconds(durationSeconds),
    }),
    // Width is a claim, not a query param: the app renders 1200px-wide cards
    // and Mux ignores unsigned query params on signed image URLs.
    thumbnailToken: signPlaybackToken({
      ...base,
      audience: 't',
      expiresInSeconds: THUMBNAIL_TOKEN_TTL_SECONDS,
      params: { width: '1200' },
    }),
  };
}
