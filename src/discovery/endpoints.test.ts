import { cardConnection, parseAiCatalog, parseServerCard } from '@cubicecho/mcp-discovery';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import type { Config } from '../config.ts';
import { stubRepos } from '../mcp/test-repos.ts';
import { discoveryEndpoints, hostSlug } from './endpoints.ts';

const baseConfig: Config = {
  serverUrl: 'https://budget.example.com',
  password: 'hunter2',
  syncId: 'sync-id',
  dataDir: '/tmp/mcp-actual-test',
  port: 3000,
  authToken: 'secret',
  enableWrites: true,
  timeoutMs: 120_000,
  keepAliveTimeoutMs: 75_000,
  lanAdvertise: false,
};

/**
 * Builds the full app, auth guard included, with no Actual server behind it.
 *
 * @param config - Fields to change from the base config, which has a token.
 * @returns The app, ready for supertest.
 */
function app(config: Partial<Config> = {}) {
  return buildApp({ repos: stubRepos(), config: { ...baseConfig, ...config } });
}

describe('discovery documents', () => {
  afterEach(() => {
    delete process.env.SECURE_LOCAL_NET;
  });

  it('serves the catalog without a token while /mcp still asks for one', async () => {
    const catalog = await request(app()).get('/.well-known/ai-catalog.json');
    expect(catalog.status).toBe(200);
    expect(catalog.headers['content-type']).toContain('application/ai-catalog+json');
    expect((await request(app()).post('/mcp').send({})).status).toBe(401);
  });

  it('lists /mcp, with a card on the address the client used', async () => {
    const catalogResponse = await request(app()).get('/.well-known/ai-catalog.json').set('Host', 'nas.local:3000');
    const catalog = parseAiCatalog(catalogResponse.body, 'test');
    expect(catalog.entries.map((entry) => entry.url)).toEqual(['http://nas.local:3000/mcp/server-card']);

    const cardResponse = await request(app()).get('/mcp/server-card').set('Host', 'nas.local:3000');
    expect(cardResponse.status).toBe(200);
    const card = parseServerCard(cardResponse.body, 'test');
    expect(cardConnection(card)).toEqual({ url: 'http://nas.local:3000/mcp', requiredHeaders: ['Authorization'] });
  });

  it('never puts the token in the card', async () => {
    const cardResponse = await request(app()).get('/mcp/server-card');
    expect(cardResponse.text).not.toContain('secret');
    expect(cardResponse.text).not.toContain(baseConfig.serverUrl);
  });

  it('asks for no token when SECURE_LOCAL_NET has turned auth off', async () => {
    process.env.SECURE_LOCAL_NET = 'true';
    const card = parseServerCard((await request(app()).get('/mcp/server-card')).body, 'test');
    expect(cardConnection(card)?.requiredHeaders).toEqual([]);
  });

  it('asks for no token when none is configured', async () => {
    const card = parseServerCard((await request(app({ authToken: null })).get('/mcp/server-card')).body, 'test');
    expect(cardConnection(card)?.requiredHeaders).toEqual([]);
  });

  it('names the card after the host, so two servers on one network stay apart', () => {
    const [endpoint] = discoveryEndpoints(baseConfig, 'NAS.lan');
    expect(endpoint?.identifier).toBe('urn:air:nas.mcp-actual:mcp:budget');
  });
});

describe('hostSlug', () => {
  it.each([
    ['NAS', 'nas'],
    ['my_box.lan', 'my-box'],
    ['---', 'host'],
  ])('%s → %s', (input, expected) => {
    expect(hostSlug(input)).toBe(expected);
  });
});
