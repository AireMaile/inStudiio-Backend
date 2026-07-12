import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signPlaybackToken,
  signVideoTokens,
  playbackTokenTtlSeconds,
  DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS,
  PLAYBACK_TOKEN_DURATION_BUFFER_SECONDS,
  THUMBNAIL_TOKEN_TTL_SECONDS,
} from '../../src/lib/muxTokens.js';
import {
  TEST_MUX_SIGNING_KEY_ID,
  testMuxPublicKeyPem,
  testMuxPrivateKeyBase64,
} from '../helpers/muxSigningKey.js';

function verify(token: string, audience: 'v' | 't') {
  return jwt.verify(token, testMuxPublicKeyPem, {
    algorithms: ['RS256'],
    audience,
  }) as jwt.JwtPayload;
}

describe('signPlaybackToken', () => {
  const base = {
    playbackId: 'pb_abc123',
    keyId: TEST_MUX_SIGNING_KEY_ID,
    privateKeyBase64: testMuxPrivateKeyBase64,
    expiresInSeconds: 3600,
  };

  it('signs an RS256 JWT whose subject is the playback id', () => {
    const token = signPlaybackToken({ ...base, audience: 'v' });
    const payload = verify(token, 'v');
    expect(payload.sub).toBe('pb_abc123');
  });

  it('puts the Mux signing key id in the JWT kid header', () => {
    const token = signPlaybackToken({ ...base, audience: 'v' });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.kid).toBe(TEST_MUX_SIGNING_KEY_ID);
    expect(decoded?.header.alg).toBe('RS256');
  });

  it('uses aud "v" for video and "t" for thumbnail', () => {
    const video = signPlaybackToken({ ...base, audience: 'v' });
    const thumb = signPlaybackToken({ ...base, audience: 't' });
    expect(verify(video, 'v').aud).toBe('v');
    expect(verify(thumb, 't').aud).toBe('t');
    // A video token must NOT validate as a thumbnail token.
    expect(() => verify(video, 't')).toThrow();
  });

  it('expires expiresInSeconds from now', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signPlaybackToken({ ...base, audience: 'v', expiresInSeconds: 600 });
    const payload = verify(token, 'v');
    expect(payload.exp).toBeGreaterThanOrEqual(before + 595);
    expect(payload.exp).toBeLessThanOrEqual(before + 605);
  });
});

describe('signVideoTokens', () => {
  it('signs a playback + thumbnail token pair from env config', () => {
    const { playbackToken, thumbnailToken } = signVideoTokens('pb_env_test');
    expect(verify(playbackToken, 'v').sub).toBe('pb_env_test');
    expect(verify(thumbnailToken, 't').sub).toBe('pb_env_test');
  });

  it('embeds the thumbnail width as a claim (Mux ignores unsigned query params on signed URLs)', () => {
    const { playbackToken, thumbnailToken } = signVideoTokens('pb_claims_test');
    expect(verify(thumbnailToken, 't').width).toBe('1200');
    // The video token must stay claim-free apart from the standard ones.
    expect(verify(playbackToken, 'v').width).toBeUndefined();
  });

  it('uses short default playback and thumbnail TTLs', () => {
    const before = Math.floor(Date.now() / 1000);
    const { playbackToken, thumbnailToken } = signVideoTokens('pb_ttl_test');
    const playback = verify(playbackToken, 'v');
    const thumbnail = verify(thumbnailToken, 't');
    expect(playback.exp).toBeGreaterThanOrEqual(before + DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS - 5);
    expect(playback.exp).toBeLessThanOrEqual(before + DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS + 5);
    expect(thumbnail.exp).toBeGreaterThanOrEqual(before + THUMBNAIL_TOKEN_TTL_SECONDS - 5);
    expect(thumbnail.exp).toBeLessThanOrEqual(before + THUMBNAIL_TOKEN_TTL_SECONDS + 5);
  });

  it('keeps the playback token valid for long videos plus a buffer', () => {
    const duration = 2 * 60 * 60;
    expect(playbackTokenTtlSeconds(duration)).toBe(
      duration + PLAYBACK_TOKEN_DURATION_BUFFER_SECONDS,
    );
  });
});
