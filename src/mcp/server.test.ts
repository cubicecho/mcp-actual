import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { AccountBalances, ActualRepos } from '../actual/index.ts';
import { createActualServer, enabledTools } from './server.ts';
import { stubRepos } from './test-repos.ts';

const BALANCES: AccountBalances = {
  accounts: [
    { id: 'a1', name: 'Checking', amount: 123456, amountDecimal: 1234.56, offBudget: false, closed: false },
    { id: 'a2', name: 'Brokerage', amount: 500000, amountDecimal: 5000, offBudget: true, closed: false },
  ],
  onBudgetTotal: 123456,
  total: 623456,
};

/** Connect an MCP client to a server backed by `repos`, over a paired in-memory transport. */
async function connect(repos: ActualRepos, enableWrites = true): Promise<Client> {
  const server = createActualServer({ repos, enableWrites });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]!.text;
}

describe('createActualServer', () => {
  it('serves the account listing', async () => {
    const client = await connect(stubRepos({ accounts: { listWithBalances: async () => BALANCES } }));
    const result = await client.callTool({ name: 'list_accounts' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual(BALANCES);
  });

  it('reports an Actual failure as a tool error rather than throwing', async () => {
    const client = await connect(
      stubRepos({
        accounts: {
          listWithBalances: async () => {
            throw new Error('Failed to open budget "abc"', { cause: new Error('SyncError') });
          },
        },
      }),
    );
    const result = await client.callTool({ name: 'list_accounts' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Failed to open budget "abc": SyncError');
  });

  it('rejects arguments that fail the input schema', async () => {
    const client = await connect(stubRepos());
    const result = await client.callTool({ name: 'get_budget_month', arguments: { month: '2026-07-19' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/YYYY-MM/);
  });

  describe('the write gate', () => {
    const writeTools = ['update_transaction', 'merge_payees', 'create_rule', 'set_budget_amount', 'update_note'];

    it('advertises write tools when writes are enabled', async () => {
      const { tools } = await (await connect(stubRepos(), true)).listTools();
      const names = tools.map((t) => t.name);
      for (const tool of writeTools) {
        expect(names).toContain(tool);
      }
    });

    it('hides every write tool when writes are disabled', async () => {
      const { tools } = await (await connect(stubRepos(), false)).listTools();
      const names = tools.map((t) => t.name);
      for (const tool of writeTools) {
        expect(names).not.toContain(tool);
      }
      // Reads survive the gate.
      expect(names).toContain('list_accounts');
      expect(names).toContain('search_transactions');
    });

    it('refuses to call a write tool that is not registered', async () => {
      const client = await connect(stubRepos(), false);
      const result = await client.callTool({ name: 'merge_payees', arguments: { targetId: 'a', mergeIds: ['b'] } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/merge_payees/);
    });
  });

  describe('tool annotations', () => {
    it('marks reads read-only and writes not', async () => {
      const { tools } = await (await connect(stubRepos())).listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get('list_accounts')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('merge_payees')?.annotations?.readOnlyHint).toBe(false);
      // A merge cannot be re-applied to the same state, so it is destructive.
      expect(byName.get('merge_payees')?.annotations?.destructiveHint).toBe(true);
      // Setting a budget amount twice lands on the same state.
      expect(byName.get('set_budget_amount')?.annotations?.destructiveHint).toBe(false);
    });
  });

  it('gives every tool a unique name, a description, and a schema', () => {
    const tools = enabledTools(stubRepos(), true);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.title).toBeTruthy();
    }
  });
});
