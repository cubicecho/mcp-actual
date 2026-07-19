import path from 'node:path';
import { z } from 'zod';

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
});

export type Config = z.infer<typeof configSchema>;

/** Read a value, treating an empty/whitespace-only env var as unset. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
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
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  ${ENV_KEYS[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`,
    );
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
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
};
