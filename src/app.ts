import express from 'express';
import type { ActualRepos } from './actual/index.ts';
import { authDisabledByEnv, createAuthMiddleware } from './auth.ts';
import type { Config } from './config.ts';
import { errorMessage, HttpError } from './errors.ts';
import { createMcpRouter } from './mcp/routes.ts';
import { SERVER_VERSION } from './version.ts';

export interface AppDeps {
  repos: ActualRepos;
  config: Config;
}

/** Build the Express app (separate from listen() so tests can drive it with supertest). */
export function buildApp(deps: AppDeps): express.Express {
  const { repos, config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const auth = createAuthMiddleware(() => ({
    enabled: config.authToken !== null && !authDisabledByEnv(),
    token: config.authToken,
  }));

  // Unauthenticated liveness probe — reports nothing about the budget itself.
  app.get('/api/status', (_req, res) => {
    res.json({ name: 'mcp-actual', version: SERVER_VERSION, serverUrl: config.serverUrl });
  });

  app.use('/mcp', auth, createMcpRouter({ repos, enableWrites: config.enableWrites }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(((err, _req, res, _next) => {
    // body-parser rejections (malformed JSON, oversized body) carry their own
    // `status`; without honouring it every one became a 500 with a stack trace,
    // reachable pre-auth by anyone who can POST a broken body.
    const status = err instanceof HttpError ? err.status : statusOf(err);
    if (status >= 500) {
      console.error(err);
    }
    res.status(status).json({ error: errorMessage(err) });
  }) satisfies express.ErrorRequestHandler);

  return app;
}

/** A framework error's own HTTP status, when it declares one; 500 otherwise. */
function statusOf(err: unknown): number {
  const status =
    (err as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}
