import { ActualClient } from './actual/client.ts';
import { buildApp } from './app.ts';
import { authDisabledByEnv } from './auth.ts';
import { loadConfig } from './config.ts';
import { errorChainMessage } from './errors.ts';

/**
 * HTTP entry point: serves the MCP endpoint at `/mcp` (streamable HTTP) and a
 * liveness probe at `/api/status`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ActualClient(config);

  // Open the budget before listening so misconfiguration (bad URL, wrong
  // password, unknown sync id) is visible at startup rather than at the first
  // tool call. A failure is only a warning: the client retries on the next
  // call, so a briefly-unreachable Actual server must not crashloop the
  // container (`restart: unless-stopped`) or take the endpoint down with it.
  await client.init().catch((err: unknown) => {
    console.warn(`Could not open the budget at startup (will retry on first tool call): ${errorChainMessage(err)}`);
  });

  const app = buildApp({ client, config });
  const httpServer = app.listen(config.port, () => {
    console.log(`mcp-actual listening on http://localhost:${config.port} (data dir: ${config.dataDir})`);
    console.log(`Actual server: ${config.serverUrl}, budget sync id: ${config.syncId}`);
    if (authDisabledByEnv()) {
      console.log('Auth: disabled (SECURE_LOCAL_NET) — /mcp is open on this network');
    } else if (config.authToken) {
      console.log('Auth: bearer token from MCP_ACTUAL_TOKEN');
    } else {
      console.log('Auth: disabled (no MCP_ACTUAL_TOKEN set) — /mcp is open on this network');
    }
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Set PORT to a free port and restart.`);
      process.exit(1);
    }
    throw err;
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    httpServer.close();
    client.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(`Fatal startup error: ${errorChainMessage(err)}`);
  process.exit(1);
});
