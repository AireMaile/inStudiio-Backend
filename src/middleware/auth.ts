import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, type JWTVerifyGetKey } from 'jose';
import { env } from '../env.js';

export interface AuthedUser {
  id: string;
  email?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

export interface RequireAuthOptions {
  // Injectable JWKS resolver (used by tests). Defaults to the project's
  // remote JWKS at ${SUPABASE_URL}/auth/v1/.well-known/jwks.json.
  jwks?: JWTVerifyGetKey;
}

// Supabase projects on the new "JWT signing keys" sign user access tokens with
// an asymmetric key (ES256, advertised at the project's JWKS endpoint). Older
// projects (and our local mint script) use the legacy symmetric HS256 shared
// secret. We support BOTH: HS256 is verified against SUPABASE_JWT_SECRET; any
// other algorithm is verified against the project's published public keys.
//
// `createRemoteJWKSet` caches keys in-process and refetches on key rotation, so
// it's created once per resolver rather than per request.
let remoteJwks: JWTVerifyGetKey | undefined;
function getRemoteJwks(): JWTVerifyGetKey {
  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', env.SUPABASE_URL));
  }
  return remoteJwks;
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: { code: 'unauthorized', message } });
}

export function makeRequireAuth(options: RequireAuthOptions = {}) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match) {
      unauthorized(res, 'Missing or malformed Authorization header');
      return;
    }
    const token = match[1];

    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      unauthorized(res, 'Invalid or expired token');
      return;
    }

    try {
      let sub: string | undefined;
      let email: string | undefined;

      if (alg === 'HS256') {
        const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET, {
          algorithms: ['HS256'],
        }) as jwt.JwtPayload;
        sub = typeof payload.sub === 'string' ? payload.sub : undefined;
        email = typeof payload.email === 'string' ? payload.email : undefined;
      } else {
        const keyset = options.jwks ?? getRemoteJwks();
        const { payload } = await jwtVerify(token, keyset, { algorithms: ['ES256', 'RS256'] });
        sub = typeof payload.sub === 'string' ? payload.sub : undefined;
        email = typeof payload.email === 'string' ? payload.email : undefined;
      }

      if (!sub) {
        unauthorized(res, 'Invalid token subject');
        return;
      }
      req.user = { id: sub, email };
      next();
    } catch {
      unauthorized(res, 'Invalid or expired token');
    }
  };
}

export const requireAuth = makeRequireAuth();
