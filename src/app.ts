import express from 'express';
import type { AccountBalanceSource } from './actual/client.ts';
import { authDisabledByEnv, createAuthMiddleware } from './auth.ts';
import type { Config } from './config.ts';
import { errorMessage, HttpError } from './errors.ts';
import { createMcpRouter } from './mcp/routes.ts';
import { SERVER_VERSION } from './version.ts';

export interface AppDeps {
  client: AccountBalanceSource;
  config: Config;
}

/** Build the Express app (separate from listen() so tests can drive it with supertest). */
export function buildApp(deps: AppDeps): express.Express {
  const { client, config } = deps;
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

  app.use('/mcp', auth, createMcpRouter({ client }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(((err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) {
      console.error(err);
    }
    res.status(status).json({ error: errorMessage(err) });
  }) satisfies express.ErrorRequestHandler);

  return app;
}
