import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AccountBalances } from './actual/client.ts';
import { buildApp } from './app.ts';
import type { Config } from './config.ts';

const BALANCES: AccountBalances = {
  accounts: [{ id: 'a1', name: 'Checking', balance: 1000, balanceDecimal: 10, offBudget: false, closed: false }],
  onBudgetTotal: 1000,
  total: 1000,
};

const baseConfig: Config = {
  serverUrl: 'https://budget.example.com',
  password: 'hunter2',
  syncId: 'sync-id',
  dataDir: '/tmp/mcp-actual-test',
  port: 3000,
  authToken: null,
};

function app(config: Partial<Config> = {}) {
  return buildApp({
    client: { getAccountBalances: async () => BALANCES },
    config: { ...baseConfig, ...config },
  });
}

/** A minimal `tools/list` JSON-RPC request over streamable HTTP. */
const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

describe('buildApp', () => {
  it('serves an unauthenticated status probe', async () => {
    const res = await request(app()).get('/api/status').expect(200);
    expect(res.body).toMatchObject({ name: 'mcp-actual', serverUrl: baseConfig.serverUrl });
  });

  it('serves /mcp when no token is configured', async () => {
    const res = await request(app()).post('/mcp').set(MCP_HEADERS).send(TOOLS_LIST).expect(200);
    expect(res.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_accounts']);
  });

  it('rejects /mcp without the configured bearer token', async () => {
    await request(app({ authToken: 'secret' }))
      .post('/mcp')
      .set(MCP_HEADERS)
      .send(TOOLS_LIST)
      .expect(401);
  });

  it('accepts /mcp with the configured bearer token', async () => {
    await request(app({ authToken: 'secret' }))
      .post('/mcp')
      .set({ ...MCP_HEADERS, Authorization: 'Bearer secret' })
      .send(TOOLS_LIST)
      .expect(200);
  });

  it('serves /mcp with SECURE_LOCAL_NET set even when a token is configured', async () => {
    process.env.SECURE_LOCAL_NET = 'true';
    try {
      await request(app({ authToken: 'secret' }))
        .post('/mcp')
        .set(MCP_HEADERS)
        .send(TOOLS_LIST)
        .expect(200);
    } finally {
      delete process.env.SECURE_LOCAL_NET;
    }
  });
});
