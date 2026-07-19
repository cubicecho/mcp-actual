import { readFileSync } from 'node:fs';

/**
 * Version reported in MCP server info and GET /api/status.
 *
 * Read from package.json at load time so it tracks the released version —
 * semantic-release bumps that file (via `@semantic-release/npm`) at release
 * time, and the Dockerfile copies it into the runtime image. The path is one
 * level up from this module in both dev (`src/version.ts`) and prod
 * (`dist/version.js`), so it resolves to the app root in both.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readVersion();
