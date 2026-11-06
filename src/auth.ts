import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Config } from './config.ts';

export interface AuthConfig {
  enabled: boolean;
  token: string | null;
}

const TRUTHY_ENV = new Set(['1', 'true', 'yes', 'on']);

/**
 * `SECURE_LOCAL_NET=true` disables bearer auth entirely for both /api and /mcp
 * — an escape hatch for running on a trusted local network without minting or
 * passing tokens.
 */
export function authDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SECURE_LOCAL_NET;
  return value !== undefined && TRUTHY_ENV.has(value.trim().toLowerCase());
}

/**
 * Whether bearer auth is actually on: a token is configured and SECURE_LOCAL_NET has not turned it off.
 *
 * @param config - Where the token comes from.
 * @param [env] - The environment SECURE_LOCAL_NET is read from, on every call.
 * @returns true when `/mcp` asks for the token.
 */
export function isAuthEffective(config: Pick<Config, 'authToken'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return config.authToken !== null && authDisabledByEnv(env) === false;
}

/** Constant-time comparison that does not leak token length (compares sha256 digests). */
export function tokensEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Bearer-token middleware for /api and /mcp. Skipped entirely when auth is
 * disabled; otherwise rejects with a 401 JSON envelope.
 */
export function createAuthMiddleware(getAuth: () => AuthConfig): RequestHandler {
  return (req, res, next) => {
    const { enabled, token } = getAuth();
    if (!enabled) {
      next();
      return;
    }
    if (!token) {
      res.status(401).json({ error: 'Auth is enabled but no token is configured' });
      return;
    }
    const header = req.headers.authorization;
    const provided = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!provided || !tokensEqual(provided, token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
