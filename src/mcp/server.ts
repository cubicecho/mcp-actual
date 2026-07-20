import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ActualRepos } from '../actual/index.ts';
import { errorChainMessage } from '../errors.ts';
import { SERVER_VERSION } from '../version.ts';
import { enabledPrompts } from './prompts.ts';
import type { ToolDefinition } from './tool.ts';
import { accountTools } from './tools/accounts.ts';
import { budgetTools } from './tools/budgets.ts';
import { contextTools } from './tools/context.ts';
import { payeeTools } from './tools/payees.ts';
import { ruleTools } from './tools/rules.ts';
import { transactionTools } from './tools/transactions.ts';

export interface ActualServerDeps {
  repos: ActualRepos;
  /** When false, mutating tools are not registered at all. */
  enableWrites: boolean;
}

/** Every tool this server can serve, before the write gate is applied. */
export function allTools(repos: ActualRepos): ToolDefinition[] {
  return [
    ...accountTools(repos),
    ...contextTools(repos),
    ...transactionTools(repos),
    ...payeeTools(repos),
    ...ruleTools(repos),
    ...budgetTools(repos),
  ] as ToolDefinition[];
}

/** The tools actually served, given the write gate. */
export function enabledTools(repos: ActualRepos, enableWrites: boolean): ToolDefinition[] {
  const tools = allTools(repos);
  return enableWrites ? tools : tools.filter((tool) => !tool.write);
}

/**
 * Build an MCP server exposing the Actual budget. A fresh `McpServer` is cheap
 * — the expensive state (the open budget) lives behind the repos' shared
 * client — so the stateless HTTP route builds one per request and stdio builds
 * one per process.
 */
export function createActualServer(deps: ActualServerDeps): McpServer {
  const server = new McpServer({ name: 'mcp-actual', version: SERVER_VERSION });

  for (const tool of enabledTools(deps.repos, deps.enableWrites)) {
    // An empty raw shape still registers a schema that rejects a call carrying
    // no `arguments` at all, which is exactly how clients invoke no-arg tools —
    // so omit the schema entirely rather than declaring an empty one.
    const hasInputs = Object.keys(tool.inputSchema).length > 0;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        ...(hasInputs ? { inputSchema: tool.inputSchema } : {}),
        annotations: {
          readOnlyHint: !tool.write,
          // Reads never destroy anything; a write is destructive unless it is
          // idempotent (re-applying it lands on the same state).
          destructiveHint: Boolean(tool.write) && !tool.idempotent,
          idempotentHint: !tool.write || Boolean(tool.idempotent),
          // Every tool talks to an external Actual server.
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(args ?? {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          // Surface Actual/network failures as a readable tool error the agent
          // can act on, not a transport-level exception.
          return { content: [{ type: 'text' as const, text: errorChainMessage(err) }], isError: true };
        }
      },
    );
  }

  for (const prompt of enabledPrompts(deps.enableWrites)) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      (args: Record<string, string | undefined>) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.build(args ?? {}) } }],
      }),
    );
  }

  return server;
}
