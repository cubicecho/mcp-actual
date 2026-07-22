import { ActualClient, createRepos } from './actual/index.ts';
import { buildApp } from './app.ts';
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

  const app = buildApp({ repos: createRepos(client), config });
  const httpServer = app.listen(config.port, () => {
    console.log(`mcp-actual listening on http://localhost:${config.port} (data dir: ${config.dataDir})`);
    console.log(`Actual server: ${config.serverUrl}, budget sync id: ${config.syncId}`);
    // Startup would have failed already if neither were set, so "no token"
    // here always means SECURE_LOCAL_NET was set deliberately.
    const authOff = !config.authToken;
    console.log(
      authOff
        ? 'Auth: disabled (SECURE_LOCAL_NET) — /mcp is open on this network'
        : 'Auth: bearer token from MCP_ACTUAL_TOKEN',
    );
    console.log(`Writes: ${config.enableWrites ? 'ENABLED' : 'disabled (read-only tools only)'}`);
    // Writable *and* unauthenticated means anyone who can reach the port can
    // modify the budget. Each half is a reasonable choice on its own, so the
    // combination is what deserves a warning.
    if (config.enableWrites && authOff) {
      console.warn(
        'WARNING: writes are enabled and SECURE_LOCAL_NET has disabled auth — anyone who can reach this port ' +
          'can modify your budget. Unset SECURE_LOCAL_NET and set MCP_ACTUAL_TOKEN, or ACTUAL_ENABLE_WRITES=false ' +
          'for a read-only server.',
      );
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
