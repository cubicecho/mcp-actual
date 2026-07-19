import type { ZodRawShape } from 'zod';

/**
 * One MCP tool: its schema, whether it mutates the budget, and its handler.
 *
 * `write` is the single gate from SPECS.md — when `ACTUAL_ENABLE_WRITES` is
 * off, write tools are not registered at all, so they never appear in
 * `tools/list`. An agent should never see a tool it cannot call.
 */
export interface ToolDefinition<Args extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape; the SDK converts it to JSON Schema and validates calls against it. */
  inputSchema: Args;
  /** True for anything that changes the budget. Governs registration, and the annotations below. */
  write?: boolean;
  /**
   * Set when calling the tool twice with the same arguments leaves the same
   * state (e.g. setting a budget amount). Omit for tools where a second call
   * compounds — merges, holds. Ignored for read tools, which are always
   * idempotent.
   */
  idempotent?: boolean;
  /** Returns the value to serialize as the tool result. Throwing yields a tool error, not a transport error. */
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Build a tool definition, preserving the literal type of its input schema. */
export function defineTool<Args extends ZodRawShape>(definition: ToolDefinition<Args>): ToolDefinition<Args> {
  return definition;
}
