import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { AccountBalanceSource, AccountBalances } from '../actual/client.ts';
import { createActualServer } from './server.ts';

const BALANCES: AccountBalances = {
  accounts: [
    { id: 'a1', name: 'Checking', balance: 123456, balanceDecimal: 1234.56, offBudget: false, closed: false },
    { id: 'a2', name: 'Brokerage', balance: 500000, balanceDecimal: 5000, offBudget: true, closed: false },
  ],
  onBudgetTotal: 123456,
  total: 623456,
};

/** Connect an MCP client to a server backed by `source`, over a paired in-memory transport. */
async function connect(source: AccountBalanceSource): Promise<Client> {
  const server = createActualServer({ client: source });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createActualServer', () => {
  it('advertises exactly the list_accounts tool', async () => {
    const client = await connect({ getAccountBalances: async () => BALANCES });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_accounts']);
  });

  it('returns the account balances as JSON', async () => {
    const client = await connect({ getAccountBalances: async () => BALANCES });
    const result = await client.callTool({ name: 'list_accounts' });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(BALANCES);
  });

  it('reports an Actual failure as a tool error rather than throwing', async () => {
    const client = await connect({
      getAccountBalances: async () => {
        throw new Error('Failed to open budget "abc"', { cause: new Error('SyncError') });
      },
    });
    const result = await client.callTool({ name: 'list_accounts' });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe('Failed to open budget "abc": SyncError');
  });
});
