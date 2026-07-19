import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import type { ActualRepos } from '../actual/index.ts';
import { errorMessage } from '../errors.ts';
import { createActualServer } from './server.ts';

export interface McpRouterDeps {
  repos: ActualRepos;
  enableWrites: boolean;
}

/**
 * Streamable-HTTP MCP endpoint at `/mcp`. Stateless: a fresh `Server` +
 * transport per request, torn down when the response closes. Nothing here is
 * session-scoped — the budget state lives behind the shared repos' client — so
 * there is no reason to keep sessions around.
 */
export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();

  router.all('/', async (req, res) => {
    const server = createActualServer({ repos: deps.repos, enableWrites: deps.enableWrites });
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
