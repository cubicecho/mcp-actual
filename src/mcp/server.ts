import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import type { ActualRepos } from '../actual/index.ts';
import { errorChainMessage } from '../errors.ts';
import { SERVER_VERSION } from '../version.ts';
import { allPrompts } from './prompts.ts';
import type { ToolDefinition } from './tool.ts';
import { accountTools } from './tools/accounts.ts';
import { budgetTools } from './tools/budgets.ts';
import { contextTools } from './tools/context.ts';
import { payeeTools } from './tools/payees.ts';
import { ruleTools } from './tools/rules.ts';
import { transactionTools } from './tools/transactions.ts';

/**
 * Rebuild a prompt's argument schema so a request omitting `arguments`
 * altogether still validates.
 *
 * Every prompt argument is optional, but `registerPrompt` wraps the shape with
 * `objectFromShape` and then parses `request.params.arguments` against it —
 * and `z.object(...)` rejects `undefined` outright. A client invoking a prompt
 * bare, the most natural way to use one, would get "Required" instead of the
 * prompt. `.default({})` fixes the parse but hides `.shape`, which the SDK
 * reads to advertise the arguments in `prompts/list`, so the shape is
 * re-attached. Applied *after* registration because `registerPrompt` re-wraps
 * whatever it is given.
 *
 * The prompt tests cover both halves, so an SDK upgrade that makes this
 * unnecessary — or breaks it — fails loudly rather than silently.
 */
function tolerateMissingArguments(shape: ZodRawShape) {
  return Object.assign(z.object(shape).default({}), { shape });
}

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
          // Declared per tool, not derived from idempotency: MCP defines
          // destructive as "may overwrite or remove" versus "only adds", which
          // is orthogonal. `update_note` is idempotent and destructive;
          // `create_payee` is neither.
          destructiveHint: Boolean(tool.write) && Boolean(tool.destructive),
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

  // Prompts are not write-gated: they cannot change anything, and a read-only
  // server is where an agent most needs the workflow to tell it so. Each renders
  // against the gate instead of being withheld by it.
  const context = { enableWrites: deps.enableWrites };
  for (const prompt of allPrompts()) {
    const registered = server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      (args: Record<string, string | undefined>) => ({
        messages: [
          { role: 'user' as const, content: { type: 'text' as const, text: prompt.build(args ?? {}, context) } },
        ],
      }),
    );
    // The slot is typed as a plain object schema; a ZodDefault carrying `shape`
    // satisfies both readers at runtime but not that declared type.
    registered.argsSchema = tolerateMissingArguments(prompt.argsSchema) as unknown as typeof registered.argsSchema;
  }

  return server;
}
