# TODO_IDEAS.md — potential future ideas

Ideas considered and deliberately **not** built yet. Each entry records why it
was deferred, so revisiting it starts from the reasoning rather than from
scratch. Nothing here is committed work — treat it as a menu, not a backlog.

## Rule dry-run (`preview_rule`)

Show which recent transactions a rule *would* match, and what it would change,
before saving it.

**Why deferred:** Actual exposes no dry-run endpoint. Implementing it means
reimplementing Actual's condition matching (a dozen field types, each with its
own operators, plus `isapprox` fuzziness and schedule-aware date recurrences)
and that reimplementation would inevitably drift from the real engine. A
preview that quietly disagrees with what the rule actually does is worse than
no preview, because it is trusted.

**Revisit if:** upstream adds a dry-run/simulate endpoint, or we find that the
matching logic is exposed somewhere reusable in `@actual-app/core` rather than
locked inside the server's rule engine.

## Raw AQL query tool

Expose Actual's query builder (`aqlQuery` / `q()`) directly as a tool, letting
an agent run arbitrary queries against the budget.

**Why deferred:** maximum power, but an unvalidatable surface — we could not
meaningfully bound what a query does, and the blast radius is the user's entire
financial history. The curated `search_transactions` tool covers the real use
cases (payee cleanup, categorization review) with an input schema we can
actually reason about.

**Revisit if:** concrete read-only use cases keep appearing that
`search_transactions` cannot express. Prefer widening that tool's filters over
opening a raw query hole.

## Delete tools

`delete_rule`, `delete_payee`, `delete_category`, `delete_account`,
`delete_transaction`, `delete_schedule`, `delete_tag`.

**Why deferred:** deliberately out of scope for the first write-enabled pass.
Every one of them has a safer sibling already covered (close an account rather
than delete it; merge payees rather than delete them; a rule can be updated).
When they land they are governed by the same `ACTUAL_ENABLE_WRITES` gate as
every other mutation — not a separate tier.

## Other ideas

- **Reordering categories and groups** (`category-move`, `categories-sort`) —
  not exposed by `@actual-app/api`'s public surface, only by internal handlers.
  Sort order is presentation, and an agent reshuffling someone's budget layout
  is a poor trade for reaching past the supported API.
- **Income category groups** — `create_category_group` cannot make one:
  `api/category-group-create` forwards only `name` and `hidden` and drops
  `is_income`. Every budget ships with the income group it needs, so this waits
  on upstream rather than on a workaround here.
- **Transaction creation / import** (`addTransactions`, `importTransactions`) —
  useful for cash entry and CSV import, but a much larger validation surface
  (split transactions, transfer semantics, dedupe by `imported_id`).
- **Multi-budget support** — the server opens exactly one budget, fixed by
  `ACTUAL_SYNC_ID`. `getBudgets` / `loadBudget` could let one server expose
  several, at the cost of the budget no longer being a process-wide constant.
- **Reports / aggregates** — spending by category over time, month-over-month
  deltas. Agents can compute these from `search_transactions`, but a purpose-built
  tool would be far cheaper in tokens.
- **MCP resources for reference data** — expose accounts, categories, and payees
  as resources (not just tools) so clients can attach them as context without a
  tool call, the way [mcp-skills-manager](../mcp-skills-manager) does.
- **Rule templates** — a small library of common rules (categorize by payee,
  flag large transactions) that `create_rule` can instantiate, avoiding
  hand-authored condition JSON for the common cases.
