#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ActualClient, createRepos } from './actual/index.ts';
import { loadConfig } from './config.ts';
import { errorChainMessage } from './errors.ts';
import { createActualServer } from './mcp/server.ts';

/**
 * stdio MCP entry point for local clients (Claude Code, Claude Desktop, …).
 * Configuration comes from the same env vars as the HTTP server; the budget is
 * opened lazily on the first tool call so a slow or unreachable Actual server
 * never stalls the client's startup handshake.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ActualClient(config);

  const server = createActualServer({ repos: createRepos(client), enableWrites: config.enableWrites });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is the MCP transport channel and must stay clean.
  console.error(
    `mcp-actual stdio ready (Actual server: ${config.serverUrl}, data dir: ${config.dataDir}, ` +
      `writes ${config.enableWrites ? 'enabled' : 'disabled'})`,
  );

  const shutdown = () => {
    client
      .close()
      .catch((err: unknown) => console.error(`Shutdown error: ${errorChainMessage(err)}`))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(`Fatal stdio startup error: ${errorChainMessage(err)}`);
  process.exit(1);
});
