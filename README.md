# MCP Actual

An MCP server for [Actual Budget](https://github.com/actualbudget/actual). It
connects to your Actual **sync server**, opens one budget file, and exposes it
to MCP clients over streamable HTTP (`/mcp`) or stdio.

## Tools

Read-only tools are always served. Tools marked ✏️ modify the budget and are
served only when `ACTUAL_ENABLE_WRITES` is on (the default) — when it is off
they are not advertised at all.

**Accounts & context**

| Tool | | Description |
| --- | --- | --- |
| `list_accounts` | | Every account with its current balance, plus on-budget and overall totals. |
| `list_categories` | | Categories with their groups. Most budgeting and rule work starts here. |
| `resolve_name_to_id` | | Exact-name lookup for accounts, categories, payees, and schedules. |
| `list_schedules` | | Scheduled (recurring) transactions and their next due dates. |
| `list_tags` | | Tags available to rules that match note tags. |
| `get_note` | | Read the note attached to any entity. |
| `sync_budget` | | Pull the latest changes from the Actual server. |
| `update_note` | ✏️ | Replace an entity's note. |
| `run_bank_sync` | ✏️ | Fetch new transactions from linked banks. |

**Transactions**

| Tool | | Description |
| --- | --- | --- |
| `search_transactions` | | Cross-account search by date, account, payee, category, notes, amount, and cleared state. |
| `get_transactions` | | Every transaction in one account between two dates, uncapped. |
| `update_transaction` | ✏️ | Change a transaction's category, payee, notes, cleared flag, date, or amount. |

**Payees**

| Tool | | Description |
| --- | --- | --- |
| `list_payees` | | Payees with transaction counts and last-used dates. |
| `find_duplicate_payees` | | Cluster near-identical payee names into merge candidates. Suggests only. |
| `create_payee` | ✏️ | Create a payee. |
| `update_payee` | ✏️ | Rename a payee. |
| `merge_payees` | ✏️ | Merge payees into a target. **Cannot be undone.** |

**Rules**

| Tool | | Description |
| --- | --- | --- |
| `describe_rule_schema` | | The exact rule format: fields, legal operators, and examples. Call before authoring a rule. |
| `list_rules` | | All rules, or only those for one payee. |
| `create_rule` | ✏️ | Create a rule from conditions and actions. |
| `update_rule` | ✏️ | Replace a rule wholesale. |
| `preview_rule_effects` | | What the rules would change on real transactions, saving nothing. Reports the whole rule set, not one rule. |
| `apply_rule_actions` | ✏️ | Apply actions to an explicit list of transaction ids (max 500) and save. |

**Budgets**

| Tool | | Description |
| --- | --- | --- |
| `list_budget_months` | | Every month the budget file covers. |
| `get_budget_month` | | One month's totals and per-category budgeted/spent/balance. |
| `set_budget_amount` | ✏️ | Set a category's budgeted amount for a month. |
| `set_budget_carryover` | ✏️ | Roll a category's balance into the next month, or stop. |
| `hold_for_next_month` | ✏️ | Hold surplus back for next month. |
| `reset_budget_hold` | ✏️ | Release a held amount. |
| `list_category_groups` | | Groups with their ids and category counts — the only way to see an empty group. |
| `create_category` | ✏️ | Create a category in a group. |
| `update_category` | ✏️ | Rename, move, or hide a category. |
| `create_category_group` | ✏️ | Create an empty group to file categories under. |
| `update_category_group` | ✏️ | Rename a group, or hide/unhide it and everything in it. |

There are no delete tools — see [TODO_IDEAS.md](TODO_IDEAS.md). All amounts are
integer cents (`amount`), with a decimal sibling (`amountDecimal`) for display;
tools accept integers only.

Example `list_accounts` result:

```json
{
  "accounts": [
    {
      "id": "729cb...",
      "name": "Checking",
      "amount": 123456,
      "amountDecimal": 1234.56,
      "offBudget": false,
      "closed": false
    }
  ],
  "onBudgetTotal": 123456,
  "total": 123456
}
```

Totals cover open (non-closed) accounts; `onBudgetTotal` excludes off-budget
tracking accounts. The budget is synced with the server before every read.

## Prompts

The server exposes MCP prompts, so a client can pull a vetted workflow instead
of you writing one. Start with `explore_budget`.

| Prompt | Arguments | |
| --- | --- | --- |
| `explore_budget` | `question` | What the budget holds and which tool answers what. The orientation prompt. |
| `categorize_transactions` | `period` | Triage uncategorized spending by payee, propose a category for each, apply what you approve. |
| `cleanup_payees` | `focus` | Group duplicate merchant names ("AMZN Mktp US*2H4" vs "Amazon"), review, merge on confirmation. |
| `backfill_rule` | `goal`, `scope` | Apply a rule to transactions that already exist: author it, preview what changes, confirm, then apply. |

Every argument is optional — the prompt asks rather than guessing — and the
prompts are available whether or not writes are enabled. With
`ACTUAL_ENABLE_WRITES` off they render a read-only variant that stops after the
analysis instead of vanishing, so the agent is told writing is unavailable
rather than left to improvise.

Prefer these over driving the sharp tools yourself: `apply_rule_actions` applies
actions unconditionally and `merge_payees` cannot be undone, and the prompts are
what enforce previewing and confirming first.

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
| `ACTUAL_ENABLE_WRITES` | | `true` | `false` serves only read-only tools; write tools are not advertised at all |
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
- **Writes are on by default.** An agent connected to this server can change
  categories, rename and merge payees, create rules, and move budgeted money.
  Combined with no bearer token, anyone who can reach the port can do the same —
  the server warns loudly at startup when it detects that combination. Set
  `ACTUAL_ENABLE_WRITES=false` for a read-only deployment.
- `merge_payees` **cannot be undone**. There are no delete tools at all.
- `DATA_DIR` contains a plaintext SQLite copy of the budget. Treat it as
  sensitive; do not commit it (`data/` is gitignored).

## Development

```bash
npm run dev     # watch mode, .ts run directly by Node
npm run check   # biome + tsc
npm test        # vitest
```

See [AGENTS.md](AGENTS.md) for architecture and conventions.
