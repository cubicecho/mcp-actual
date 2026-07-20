# SPECS.md — tool surface

Locked design decisions and the itemized work list for widening mcp-actual
beyond the v0.1.x MVP (`list_accounts`). Ideas explicitly **not** being built
live in [TODO_IDEAS.md](TODO_IDEAS.md).

## Locked decisions

1. **One write gate, on by default.** `ACTUAL_ENABLE_WRITES` (default `true`)
   governs every mutating tool. When off, mutating tools are not advertised in
   `tools/list` at all — an agent should never see a tool it cannot call. There
   is **no** separate destructive tier: deletes, when they land, are governed by
   this same flag.
2. **No delete tools in this pass.** Every delete has a safer sibling already
   covered. See TODO_IDEAS.md.
3. **All tools are always advertised** (subject to 1). No per-group config —
   revisit only if tool-list size becomes a measured problem.
4. **No raw AQL tool.** Deferred with reasons in TODO_IDEAS.md. The rule
   dry-run was deferred alongside it and has since been **partly reversed** —
   see "Rule preview" below for what changed and what stayed rejected.
5. **Amounts are always integer minor units (cents)** on the wire, in both
   directions. Tools additionally *return* a decimal for display, but never
   *accept* one — float money input is a correctness trap.
6. **Reads are curated, not raw.** `search_transactions` is built on `aqlQuery`
   with a validated filter schema; the query builder itself is never exposed.

## Tool surface

`R` = read-only. `W` = requires `ACTUAL_ENABLE_WRITES`.

### Accounts (shipped in 0.1.0)

| Tool | API | |
| --- | --- | --- |
| `list_accounts` | `getAccounts` + `getAccountBalance` | R |

### Rules

| Tool | API | |
| --- | --- | --- |
| `list_rules` | `getRules`, `getPayeeRules` (filter by payee) | R |
| `describe_rule_schema` | *(static)* — legal fields, the operators valid for each, worked examples | R |
| `create_rule` | `createRule` | W |
| `update_rule` | `updateRule` | W |
| `preview_rule_effects` | `send('rules-run')` | R |
| `apply_rule_actions` | `send('rule-apply-actions')` | W |

`describe_rule_schema` exists because `RuleConditionEntity` is a discriminated
union of ~12 field types each with its own legal operators, plus 6 action
shapes. An agent authoring that blind from a prose description will fail; this
tool is the cheapest fix.

#### Rule preview

The original decision was "no dry-run, because Actual exposes no endpoint and
reimplementing condition matching would drift". The first half turned out to be
wrong: `init()` returns a **typed** `send<K extends keyof Handlers>` channel
(`@actual-app/api/@types/index.d.ts`), the deprecated `internal` export points
at it, and `RulesHandlers` types both `rules-run` and `rule-apply-actions`.
`ActualClient.send` exposes that channel; it is for what `@actual-app/api` never
re-exports as a function, not a general-purpose bypass.

The second half of the objection still stands, and shapes both tools:

- **`preview_rule_effects` reports the whole rule set, not one rule.**
  `rules-run` takes a transaction and runs every ranked rule over it. The
  per-rule matcher (`conditionsToAQL`) is internal to the bundle and is *not* a
  registered handler, so single-rule preview would still mean reimplementing
  matching — rejected for the original reason. Reporting the net effect is also
  the more truthful answer, since rules interact by rank.
- **`apply_rule_actions` takes ids, never a filter.** `rule-apply-actions`
  applies actions *unconditionally* to the transactions handed to it — it does
  not evaluate conditions. Taking a filter would let an agent rewrite a set it
  never looked at, so the tool takes an explicit id list capped at 500 and
  reports ids that did not exist rather than dropping them silently.

The handler returns `null` when it cannot parse an action; that is surfaced as a
tool error, because a silent no-op reads as success.

Each previewed change carries **both** the display name and the raw id
(`from`/`to` plus `fromId`/`toId`). Names alone were unusable — actions take ids
as values, so a name-only diff forced an ambiguous `resolve_name_to_id`
round-trip between preview and apply; ids alone were unreadable.

### Payees

| Tool | API | |
| --- | --- | --- |
| `list_payees` | `getPayees` + `aqlQuery` for per-payee transaction count and last-used date | R |
| `find_duplicate_payees` | `aqlQuery` + local similarity clustering | R |
| `merge_payees` | `mergePayees` | W |
| `update_payee` | `updatePayee` — **rename only** | W |
| `create_payee` | `createPayee` | W |

Two constraints found during implementation:

- `APIPayeeEntity` is `Pick<PayeeEntity, 'id' | 'name' | 'transfer_acct'>`, so
  `favorite` and `learn_categories` are not reachable through the public API.
  `update_payee` renames and nothing else.
- AQL has no `$max`, so per-payee usage is not a grouped aggregate. One query
  selects `payee` and `date` for every transaction, newest first, and the counts
  and last-used dates are folded in memory (`tallyUsage`). Two narrow columns
  over a personal budget is cheap, and it yields both numbers from one query.

`list_payees` must return usage counts — the raw API returns bare names, which
is not enough to decide what to merge. `find_duplicate_payees` clusters
near-identical names (`AMZN Mktp US*2H4` vs `Amazon`) so the agent reviews
candidates instead of scanning hundreds of names.

### Transactions

| Tool | API | |
| --- | --- | --- |
| `search_transactions` | `aqlQuery` — filter by date range, account, payee, category, notes, amount range, cleared/reconciled; capped result count | R |
| `get_transactions` | `getTransactions` (single account + date range, as the API defines it) | R |
| `update_transaction` | `updateTransaction` (category, payee, notes, cleared) | W |

`search_transactions` is the workhorse for payee cleanup: `getTransactions`
alone cannot answer a cross-account question, which is exactly the shape of
"where else does this payee appear?".

### Budgets & categories

| Tool | API | |
| --- | --- | --- |
| `list_budget_months` | `getBudgetMonths` | R |
| `get_budget_month` | `getBudgetMonth` | R |
| `list_categories` | `getCategories`, `getCategoryGroups` | R |
| `list_category_groups` | `getCategoryGroups` | R |
| `set_budget_amount` | `setBudgetAmount` | W |
| `set_budget_carryover` | `setBudgetCarryover` | W |
| `hold_for_next_month` | `holdBudgetForNextMonth` | W |
| `reset_budget_hold` | `resetBudgetHold` | W |
| `create_category` | `createCategory` | W |
| `update_category` | `updateCategory` | W |
| `create_category_group` | `createCategoryGroup` | W |
| `update_category_group` | `updateCategoryGroup` | W |

Categories are not optional: budgeting and rules both address categories by id,
so the agent needs to enumerate them.

Groups get their own listing because `list_categories` reaches a group only
through a category that already lives in it — an empty group, including one just
created, is otherwise unaddressable and `create_category` has no id to take.

Two limits come from `@actual-app/api` (26.7.0) rather than from us:
`api/category-group-create` forwards only `name` and `hidden`, so an income
group cannot be created and `create_category_group` does not offer the flag; and
`updateCategoryGroup` reads `group.name.toUpperCase()` in its duplicate-name
check even when the patch omits a name, so the repo resends the current name on
every update to avoid a `TypeError` thrown from inside the library.

### Context & operations

| Tool | API | |
| --- | --- | --- |
| `resolve_name_to_id` | `getIDByName` for accounts/categories/payees/schedules | R |
| `list_schedules` | `getSchedules` | R |
| `list_tags` | `getTags` | R |
| `get_note` | `getNote` | R |
| `sync_budget` | `sync` | R\* |
| `run_bank_sync` | `runBankSync` | W |
| `update_note` | `updateNote` | W |

\* `sync_budget` mutates nothing locally that the user did not already cause —
it pulls the server's state. Treated as a read.

## Prompts

The server exposes MCP **prompts** as well as tools, in `src/mcp/prompts.ts`,
behind the same registry-plus-gate shape as tools.

| Prompt | | |
| --- | --- | --- |
| `backfill_rule` | preview → confirm → apply, for backfilling a rule over existing transactions | W |

A prompt is guidance, not access: it cannot reach the budget, so all it adds is
an ordering over tool calls the agent would otherwise have to infer. That is
worth having precisely where the tools are sharp — `preview_rule_effects`
reports the whole rule set rather than one rule, and `apply_rule_actions` does
not re-check conditions — so `backfill_rule` exists to force preview-then-
confirm before any bulk write.

Two constraints, both observed rather than assumed:

- **Prompts are write-gated like tools.** A workflow ending in a mutating tool
  is withheld when `ACTUAL_ENABLE_WRITES` is off, for the same reason those
  tools are. Since `backfill_rule` is currently the only prompt, a read-only
  server registers none and therefore advertises no prompts capability at all —
  `prompts/list` returns *Method not found*, not an empty list.
- **A declared `argsSchema` makes `arguments` mandatory**, even when every
  argument in it is optional: a request omitting the member outright fails
  validation. Clients must send `arguments: {}`. This is the same sharp edge
  already worked around for no-input tools in `server.ts`.

## Conventions for new tools

- **Every mutating tool is annotated** `readOnlyHint: false` and, where it
  overwrites prior state, `idempotentHint` set honestly. Read tools carry
  `readOnlyHint: true`.
- **Mutating tools return the resulting entity**, so the agent can confirm what
  changed rather than assuming success.
- **Ids over names at the boundary.** Tools take ids; `resolve_name_to_id`
  exists for the name→id hop. Tools that return entities always include both.
- **Every tool goes through `ActualClient`.** No module outside
  `src/actual/` imports `@actual-app/api` — the library is a process-wide
  singleton and all access must stay serialized. See AGENTS.md.
- **Failures are tool errors** (`isError: true`), never transport exceptions.
- **Result caps.** Any tool that can return an unbounded list takes a `limit`
  with a sane default and reports when results were truncated — silent
  truncation reads as "that's all of them".

## Work list

All shipped:

1. ✅ `ACTUAL_ENABLE_WRITES` config flag + tool-registration gating.
2. ✅ Per-domain tool modules under `src/mcp/tools/`, behind a `ToolDefinition`
   registry (`src/mcp/tool.ts`).
3. ✅ Per-domain repositories under `src/actual/`, each serialized through
   `ActualClient.run`.
4. ✅ Shared zod input schemas (dates `YYYY-MM-DD`, months `YYYY-MM`, integer cents).
5. ✅ Tools in dependency order: context → transactions → payees → rules → budgets.
6. ✅ Tests against `stubRepos`, plus write-gate and annotation coverage.
7. ✅ README tool table, `.env.example`, and compose entry for the flag.

**Not verified against a live server.** The tests cover schema validation, the
write gate, and the pure logic (`buildSearchFilter`, `groupDuplicates`,
`tallyUsage`), but no test exercises a real Actual budget — the AQL queries and
the write paths are only as correct as the API types and the library source they
were read from. First run against a real budget should exercise one tool per
domain before trusting the write tools.
