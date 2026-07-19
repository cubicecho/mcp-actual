import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import type { AccountBalanceSource } from '../actual/client.ts';
import { errorMessage } from '../errors.ts';
import { createActualServer } from './server.ts';

export interface McpRouterDeps {
  client: AccountBalanceSource;
}

/**
 * Streamable-HTTP MCP endpoint at `/mcp`. Stateless: a fresh `Server` +
 * transport per request, torn down when the response closes. Nothing here is
 * session-scoped — the budget state lives in the shared {@link ActualClient} —
 * so there is no reason to keep sessions around.
 */
export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();

  router.all('/', async (req, res) => {
    const server = createActualServer({ client: deps.client });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch((err: unknown) => console.warn(`MCP transport close failed: ${errorMessage(err)}`));
      server.close().catch((err: unknown) => console.warn(`MCP server close failed: ${errorMessage(err)}`));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}
