import { hostname } from 'node:os';
import { type AdvertisedEndpoint, airIdentifier, createServerCard, type KeyValueInput } from '@cubicecho/mcp-discovery';
import { isAuthEffective } from '../auth.ts';
import type { Config } from '../config.ts';
import { SERVER_VERSION } from '../version.ts';

/** The reverse-DNS namespace every card's name starts with; the host's slug is appended to it. */
const CARD_NAMESPACE = 'io.github.cubicecho.mcp-actual';

/** The product part of each catalog entry's `urn:air` id, after the host's slug. */
const AIR_PRODUCT = 'mcp-actual';

/** The project's source, shown on every card. */
const REPOSITORY = { url: 'https://github.com/cubicecho/mcp-actual', source: 'github' } as const;

/** The path of the one MCP endpoint, which serves the configured budget. */
const MCP_PATH = '/mcp';

/** The endpoint's name in its card name and `urn:air` id. */
const ENDPOINT_NAME = 'budget';

/** What the card says the endpoint is for; a card description holds at most 100 characters. */
const DESCRIPTION = 'An Actual Budget: accounts, transactions, payees, rules and budgets, served over MCP.';

/** The slug used when nothing of the hostname survives. */
const FALLBACK_HOST_SLUG = 'host';

/** The header a client must send when bearer auth is on; its value is never in the card. */
const AUTH_HEADER: KeyValueInput = {
  name: 'Authorization',
  description: 'Bearer <token>, the token set in MCP_ACTUAL_TOKEN',
  isRequired: true,
  isSecret: true,
};

/**
 * A hostname cut down to what a card name and a `urn:air` id allow: lowercase letters, digits and hyphens.
 *
 * @param name - The machine's hostname.
 * @returns E.g. `nas` for `NAS`, `my-box` for `my_box.lan`.
 */
export function hostSlug(name: string): string {
  const [first = ''] = name.toLowerCase().split('.');
  const slug = first.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? FALLBACK_HOST_SLUG : slug;
}

/**
 * The MCP endpoints this server makes discoverable: only `/mcp`.
 *
 * @param config - Whether a token is configured, which decides if the card asks for one.
 * @param [host] - The machine's hostname, which keeps card names apart when two servers share a network.
 * @returns The endpoint, with a card builder that names the URL the request came in on.
 */
export function discoveryEndpoints(config: Pick<Config, 'authToken'>, host = hostname()): AdvertisedEndpoint[] {
  const slug = hostSlug(host);
  return [
    {
      path: MCP_PATH,
      identifier: airIdentifier(`${slug}.${AIR_PRODUCT}`, ENDPOINT_NAME),
      card: ({ endpointUrl }) =>
        createServerCard({
          name: `${CARD_NAMESPACE}.${slug}/${ENDPOINT_NAME}`,
          version: SERVER_VERSION,
          title: `MCP Actual on ${host}`,
          description: DESCRIPTION,
          repository: REPOSITORY,
          // Read per request, as the auth guard reads SECURE_LOCAL_NET, so the card never disagrees with it.
          remotes: [
            { type: 'streamable-http', url: endpointUrl, headers: isAuthEffective(config) ? [AUTH_HEADER] : [] },
          ],
        }),
    },
  ];
}
