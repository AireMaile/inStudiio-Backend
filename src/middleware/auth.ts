import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
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

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or malformed Authorization header' } });
    return;
  }
  const token = match[1];

  try {
    const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!sub) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid token subject' } });
      return;
    }
    req.user = { id: sub, email: typeof payload.email === 'string' ? payload.email : undefined };
    next();
  } catch {
    res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid or expired token' } });
  }
}
