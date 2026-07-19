import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountBalanceSource } from '../actual/client.ts';
import { errorChainMessage } from '../errors.ts';
import { SERVER_VERSION } from '../version.ts';

export interface ActualServerDeps {
  client: AccountBalanceSource;
}

/**
 * Build an MCP server exposing the Actual budget. A fresh `McpServer` is cheap
 * — the expensive state (the open budget) lives in the shared
 * {@link ActualClient} — so the stateless HTTP route builds one per request and
 * stdio builds one per process.
 */
export function createActualServer(deps: ActualServerDeps): McpServer {
  const server = new McpServer({ name: 'mcp-actual', version: SERVER_VERSION });

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts and balances',
      description:
        'List every account in the Actual Budget file with its current balance. Returns each account’s id, ' +
        'name, balance (in cents and as a decimal amount), whether it is off-budget (a tracking account), and ' +
        'whether it is closed — plus `onBudgetTotal` (open on-budget accounts) and `total` (all open accounts). ' +
        'The budget is synced with the server before reading, so balances are current.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const balances = await deps.client.getAccountBalances();
        return { content: [{ type: 'text' as const, text: JSON.stringify(balances, null, 2) }] };
      } catch (err) {
        // Surface Actual/network failures as a readable tool error the agent can
        // act on, not a transport-level exception.
        return { content: [{ type: 'text' as const, text: errorChainMessage(err) }], isError: true };
      }
    },
  );

  return server;
}
