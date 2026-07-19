# AGENTS.md — MCP Actual

MCP Actual is an MCP server in front of [Actual Budget](https://actualbudget.org).
It connects to an Actual **sync server**, downloads one budget file, and exposes
its data to agents over MCP — streamable HTTP at `/mcp` and stdio for local
clients (`mcp-actual-stdio`). Configuration is entirely environment-driven;
`DATA_DIR` holds the only state (the Actual API's cached copy of the budget).

**Read [`SPECS.md`](SPECS.md) first** — it holds the locked design decisions and
the itemized work list for the tool surface. Ideas that were considered and
deliberately *not* built live in [`TODO_IDEAS.md`](TODO_IDEAS.md) ("potential
future ideas"), each with the reasoning that deferred it. When you decide
against building something non-obvious, record it there rather than dropping
it — and when you are about to propose a new tool, check it first, because the
idea may already have been rejected for a reason that still holds.

v0.1.x shipped exactly one tool, `list_accounts`. The surface widens per
SPECS.md; every new tool is a new blast radius over someone's real financial
data, so none of it is speculative — build what is specified.

Single package, no workspaces: everything is under `src/`.

- `src/config.ts` — env → validated `Config` (zod). The one place env vars are read.
- `src/actual/client.ts` — the `@actual-app/api` singleton, wrapped and serialized.
- `src/mcp/server.ts` — the MCP server + tool definitions.
- `src/mcp/routes.ts` — stateless streamable-HTTP transport at `/mcp`.
- `src/app.ts` / `src/index.ts` — Express app and HTTP entry point.
- `src/stdio.ts` — stdio entry point (`mcp-actual-stdio`).

## Commands

All from the project root.

```bash
# Dev
npm run dev              # HTTP server on :3000, watch mode, reads .env
npm run dev:stdio        # stdio transport, reads .env

# Quality — run before every commit; CI fails otherwise
npm run check            # biome check + tsc --noEmit
npm run check:fix        # biome with auto-fix
npm run lint / lint:fix  # biome lint only
npm test                 # vitest run
npm run test:watch       # vitest watch

# Build / deploy
npm run build            # tsc → dist/
npm run start            # node dist/index.js
npm run stdio            # node dist/stdio.js
npm run build:docker     # docker build -t mcp-actual .
docker compose up        # run the container; ./data mounted at /data
```

## Tech Stack

| Choice | Why |
| --- | --- |
| **Biome** | Single formatter+linter; enforces `useImportType`, `noUnusedImports` |
| **Express 5 + @modelcontextprotocol/sdk** | `StreamableHTTPServerTransport` (stateless) for `/mcp`; `StdioServerTransport` for the CLI entry. Use the high-level `McpServer` + `registerTool` — the low-level `Server` class is deprecated |
| **@actual-app/api** | The official Actual client. A **process-wide singleton** backed by SQLite: `init()` opens one budget and every other call reads that global state |
| **Env-only config** | No config file to keep in sync. `loadConfig()` validates the whole environment up front and reports every problem at once |
| **Node ≥22.18 type stripping** | Dev runs `.ts` directly (`node --watch`), no build step; `tsc` with `rewriteRelativeImportExtensions` emits `dist/` for prod — so **use `.ts` extensions in all relative imports** |
| **Single bearer token auth** | `MCP_ACTUAL_TOKEN` guards `/mcp`; `SECURE_LOCAL_NET=true` disables auth entirely (trusted-network escape hatch). `/api/status` is always open — it is a liveness probe and reveals nothing about the budget |
| **One write gate** | `ACTUAL_ENABLE_WRITES` (default `true`) governs every mutating tool. There is no second destructive tier — deletes are ordinary writes. When off, mutating tools are **not advertised** in `tools/list`; never show an agent a tool it cannot call |

## Key Conventions

**All Actual access goes through `ActualClient`.** Never `import * as api from
'@actual-app/api'` anywhere else. The library is a global singleton, so two
overlapping calls race on the same open budget; the client serializes every
operation through a promise chain and owns budget open/close. New tools add a
method there, not a second entry point into the library.

**Money is integer cents.** Actual stores and returns amounts in minor units.
Never do float math on them — sum the integers and convert once for display
with `api.utils.integerToAmount`. Tools *return* a decimal alongside the
integer for readability, but never *accept* one: float money input is a
correctness trap.

**Sync before you read.** Other Actual clients write to the same budget; a tool
that reports stale balances is worse than one that is slightly slower.

**MCP layers depend on narrow interfaces, not `ActualClient`.** `server.ts` and
`routes.ts` take an `AccountBalanceSource`, so tools are testable against a stub
with no Actual server in the loop.

**Validate at boundaries, trust inside:**
```typescript
const config = loadConfig(); // throws with every invalid env var named
```

**Never swallow errors:**
```typescript
try {
  await api.downloadBudget(syncId);
} catch (cause) {
  throw new Error(`Failed to open budget "${syncId}"`, { cause });
}
```
Actual's own errors are terse (`SyncError`, `PostError`) — wrap them with the
context an operator needs, and render the chain with `errorChainMessage`.

**Tool failures are tool errors, not transport errors.** A tool that cannot
reach the Actual server returns `{ isError: true }` with a readable message so
the agent can react; it does not throw through the transport.

**Never log secrets.** `ACTUAL_PASSWORD`, `ACTUAL_ENCRYPTION_PASSWORD`, and
`MCP_ACTUAL_TOKEN` must never reach stdout/stderr — startup logs name the server
URL and sync id only. On stdio, log to **stderr**: stdout is the transport.

## Code Style

- Biome-enforced: single quotes, semicolons, trailing commas, 2-space indent,
  120 line width, `import type` for type-only imports, arrow parens always
- Files `kebab-case.ts`; vars/functions `camelCase`; types/interfaces
  `PascalCase`; true constants `SCREAMING_SNAKE_CASE`
- Prefix unused params with `_`
- `unknown` over `any` (`noExplicitAny` warns)
- Tests are `*.test.ts` next to their source; Vitest `describe`/`it`/`expect`

## Git

- `git pull --no-rebase` (merge, not rebase)
- Do not add `Co-Authored-By` trailers to commit messages
- Run `npm run check` and `npm test` before every commit
- Use **Conventional Commits** (`feat: …`, `fix: …`, `chore: …`, breaking
  changes via `!` or `BREAKING CHANGE:`) — semantic-release derives versions
  and Docker image tags from commit messages on `main`

## CI / Release

- `.github/workflows/ci.yml` — check + test + build on every push/PR to `main`
- `.github/workflows/release.yml` — after CI succeeds on `main`,
  semantic-release cuts a GitHub release and pushes the Docker image to
  `ghcr.io/<repo>` and Docker Hub (`$DOCKERHUB_USERNAME/mcp-actual`), tagged
  `latest` + the semver. Requires repo secrets `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN`.

## Finding code

Prefer an LSP (definitions/references) over grep when navigating the codebase.
