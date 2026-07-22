import path from 'node:path';
import { z } from 'zod';
import { authDisabledByEnv } from './auth.ts';

/**
 * All configuration is environment-driven — there is no on-disk config file.
 * `DATA_DIR` is the only state the server keeps: the Actual API caches the
 * downloaded budget (a SQLite file) there between runs.
 */
const configSchema = z.object({
  /** Base URL of the Actual Budget sync server, e.g. `https://budget.example.com`. */
  serverUrl: z.string().url(),
  /** The sync server's password (the one used to log into the Actual web UI). */
  password: z.string().min(1),
  /**
   * The budget's Sync ID — Actual's Settings → Advanced → "Sync ID". This is
   * *not* the budget's display name or its local `budget-<id>` folder name.
   */
  syncId: z.string().min(1),
  /** End-to-end encryption password, only for budgets with E2E encryption enabled. */
  encryptionPassword: z.string().min(1).optional(),
  /** Where the Actual API caches the downloaded budget. */
  dataDir: z.string().min(1),
  port: z.number().int().positive(),
  /** Bearer token guarding /api and /mcp; null when auth is off. */
  authToken: z.string().min(1).nullable(),
  /**
   * Whether mutating tools are served at all. When false they are omitted from
   * `tools/list` entirely — an agent should never see a tool it cannot call.
   * There is no second "destructive" tier: deletes are ordinary writes.
   */
  enableWrites: z.boolean(),
  /**
   * Ceiling on a single Actual operation. Every call is serialized through one
   * queue, so an unbounded hang does not stall one request — it stalls the
   * whole server, permanently.
   */
  timeoutMs: z.number().int().min(1000),
});

export type Config = z.infer<typeof configSchema>;

/** Read a value, treating an empty/whitespace-only env var as unset. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse a boolean env var, falling back to `fallback` when unset. An
 * unrecognized value returns `undefined` so schema validation rejects it — a
 * typo like `ACTUAL_ENABLE_WRITES=flase` must not silently mean "enabled".
 */
function envBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean | undefined {
  const raw = envValue(env, key)?.toLowerCase();
  if (raw === undefined) {
    return fallback;
  }
  if (TRUTHY.has(raw)) {
    return true;
  }
  if (FALSY.has(raw)) {
    return false;
  }
  return undefined;
}

/**
 * Build the config from the environment. Throws with every missing/invalid
 * variable listed at once — a half-configured server can only fail later at the
 * first tool call, where the error is far harder to read.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    serverUrl: envValue(env, 'ACTUAL_SERVER_URL'),
    password: envValue(env, 'ACTUAL_PASSWORD'),
    syncId: envValue(env, 'ACTUAL_SYNC_ID'),
    encryptionPassword: envValue(env, 'ACTUAL_ENCRYPTION_PASSWORD'),
    dataDir: path.resolve(envValue(env, 'DATA_DIR') ?? './data'),
    port: Number(envValue(env, 'PORT') ?? 3000),
    authToken: envValue(env, 'MCP_ACTUAL_TOKEN') ?? null,
    // Default on: the server is most useful when an agent can act, and the
    // gate exists to be turned *off* deliberately for read-only deployments.
    enableWrites: envBoolean(env, 'ACTUAL_ENABLE_WRITES', true),
    timeoutMs: Number(envValue(env, 'ACTUAL_TIMEOUT_MS') ?? 120_000),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  ${ENV_KEYS[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`,
    );
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  assertAuthConfigured(parsed.data, env);
  return parsed.data;
}

/**
 * Refuse to start unauthenticated unless that was asked for explicitly.
 *
 * Serving a budget with no token exposes someone's entire financial history to
 * anyone who can reach the port, and with writes on (the default) it lets them
 * change it. Leaving `MCP_ACTUAL_TOKEN` unset is indistinguishable from
 * misspelling it, so the previous behaviour — start anyway, print a warning —
 * turned one typo into a silent, open, writable server. Running without a token
 * stays possible; it just has to be stated, via `SECURE_LOCAL_NET=true`.
 */
function assertAuthConfigured(config: Config, env: NodeJS.ProcessEnv): void {
  if (config.authToken || authDisabledByEnv(env)) {
    return;
  }
  const writable = config.enableWrites ? ' — with writes enabled, meaning they could modify your budget' : '';
  throw new Error(
    'Invalid configuration:\n' +
      `  MCP_ACTUAL_TOKEN: not set, so /mcp would be open to anyone who can reach this port${writable}.\n` +
      '  Set MCP_ACTUAL_TOKEN to a secret of your choosing, or set SECURE_LOCAL_NET=true to confirm you ' +
      'intend an unauthenticated server on a trusted network.',
  );
}

/** Config field → the env var that sets it, so validation errors name what the operator actually edits. */
const ENV_KEYS: Record<string, string> = {
  serverUrl: 'ACTUAL_SERVER_URL',
  password: 'ACTUAL_PASSWORD',
  syncId: 'ACTUAL_SYNC_ID',
  encryptionPassword: 'ACTUAL_ENCRYPTION_PASSWORD',
  dataDir: 'DATA_DIR',
  port: 'PORT',
  authToken: 'MCP_ACTUAL_TOKEN',
  enableWrites: 'ACTUAL_ENABLE_WRITES',
  timeoutMs: 'ACTUAL_TIMEOUT_MS',
};
