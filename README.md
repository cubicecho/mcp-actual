# MCP Actual

An MCP server for [Actual Budget](https://github.com/actualbudget/actual). It
connects to your Actual **sync server**, opens one budget file, and exposes it
to MCP clients over streamable HTTP (`/mcp`) or stdio.

**v0.1.0 (MVP) serves a single tool:**

| Tool | Description |
| --- | --- |
| `list_accounts` | Every account with its current balance, plus on-budget and overall totals. |

Example result:

```json
{
  "accounts": [
    {
      "id": "729cb...",
      "name": "Checking",
      "balance": 123456,
      "balanceDecimal": 1234.56,
      "offBudget": false,
      "closed": false
    }
  ],
  "onBudgetTotal": 123456,
  "total": 123456
}
```

`balance` is in minor units (cents) — Actual's native representation;
`balanceDecimal` is the same number in currency units. Totals cover open
(non-closed) accounts; `onBudgetTotal` excludes off-budget tracking accounts.
The budget is synced with the server before every read.

## What you need before you start

You need three things, and nothing else. There is **no API key and no username**
— an Actual sync server authenticates with a single password, and the budget is
selected by its Sync ID.

1. **A running [Actual sync server](https://actualbudget.org/docs/install/)** and
   its URL, e.g. `https://budget.example.com` or `http://192.168.1.50:5006` —
   the same URL you open the Actual web UI at.
2. **The server password** — what you type on the Actual login screen.
3. **The budget's Sync ID** — open Actual → **Settings → Advanced settings →
   "Sync ID"**. It is a UUID like `a1b2c3d4-….`. This is *not* the budget's
   display name and *not* the `My-Finances-xxxx` folder name.

Plus Node.js ≥ 22.18, or Docker.

## Configuration

All configuration is environment variables — copy `.env.example` to `.env` and
fill in the three required values. `docker compose` reads that same `.env`.

| Variable | Required | Default | What to put in it |
| --- | --- | --- | --- |
| `ACTUAL_SERVER_URL` | ✅ | — | Base URL of the Actual sync server, scheme included, no trailing path |
| `ACTUAL_PASSWORD` | ✅ | — | The sync server's login password |
| `ACTUAL_SYNC_ID` | ✅ | — | Actual → Settings → Advanced settings → "Sync ID" |
| `ACTUAL_ENCRYPTION_PASSWORD` | | — | Only if the budget has end-to-end encryption enabled |
| `MCP_ACTUAL_TOKEN` | | — | Bearer token clients must send to `/mcp`; unset means no auth |
| `SECURE_LOCAL_NET` | | — | `true` disables auth entirely (trusted networks only) |
| `DATA_DIR` | | `./data` (`/data` in Docker) | Where the downloaded budget is cached |
| `PORT` | | `3000` | HTTP port |

Missing or malformed values are reported at startup with every offending
variable named at once.

> **Pointing at an Actual server that also runs in Docker:** use its service
> name (`http://actual_server:5006`) and put both on the same Docker network.
> Inside this container, `localhost` is *this* container, not your host.

## Running

### Local

```bash
npm install
cp .env.example .env   # fill in your server URL, password, and sync id
npm run build
npm start              # HTTP server on :3000, MCP at /mcp
```

### Docker

```bash
cp .env.example .env    # fill in ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID
docker compose up -d
docker compose logs -f  # confirm it opened the budget
```

Compose refuses to start with a message naming any required variable you left
unset. `./data` is mounted at `/data` so the downloaded budget survives restarts.

Without compose, the same three variables must be passed explicitly:

```bash
docker run -d --name mcp-actual -p 3000:3000 \
  -v "$PWD/data:/data" \
  -e ACTUAL_SERVER_URL=https://budget.example.com \
  -e ACTUAL_PASSWORD='your-actual-password' \
  -e ACTUAL_SYNC_ID=00000000-0000-0000-0000-000000000000 \
  -e MCP_ACTUAL_TOKEN="$(openssl rand -hex 32)" \
  mcp-actual
```

Published images: `ghcr.io/<owner>/mcp-actual` and Docker Hub
`<dockerhub-user>/mcp-actual`, tagged `latest` and by semver.

## Connecting a client

**Streamable HTTP** — point the client at `http://<host>:3000/mcp`, sending
`Authorization: Bearer $MCP_ACTUAL_TOKEN` if a token is configured.

**stdio** — for local clients such as Claude Code:

```json
{
  "mcpServers": {
    "actual": {
      "command": "node",
      "args": ["/path/to/mcp-actual/dist/stdio.js"],
      "env": {
        "ACTUAL_SERVER_URL": "https://budget.example.com",
        "ACTUAL_PASSWORD": "…",
        "ACTUAL_SYNC_ID": "…",
        "DATA_DIR": "/path/to/mcp-actual/data"
      }
    }
  }
}
```

Or, after `npm link`, use the `mcp-actual-stdio` binary.

`GET /api/status` is an unauthenticated liveness probe (name, version, and the
configured Actual server URL) used by the Docker healthcheck.

## Security notes

- The server holds your Actual password and reads your full financial data.
  Set `MCP_ACTUAL_TOKEN` unless it is unreachable from untrusted networks.
- The MVP is **read-only** — no tool mutates the budget.
- `DATA_DIR` contains a plaintext SQLite copy of the budget. Treat it as
  sensitive; do not commit it (`data/` is gitignored).

## Development

```bash
npm run dev     # watch mode, .ts run directly by Node
npm run check   # biome + tsc
npm test        # vitest
```

See [AGENTS.md](AGENTS.md) for architecture and conventions.
