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

Behaviours of the library that shape these tools, each verified in the bundled
source rather than inferred from its types:

- **Ids are interpolated into SQL unescaped.** AQL's `$oneof` emits
  ``ids.map((id) => `'${String(id)}'`)`` and `val()` escapes quotes only for
  `string`-typed fields, never `id`-typed ones. An id containing a quote breaks
  out of the `IN (...)` list, so `x') OR 1=1 --` turns a targeted lookup into a
  whole-table match that `apply_rule_actions` would then write to. `idSchema`
  constrains every id at the tool boundary, and `applyActions` additionally
  refuses to proceed when the lookup returns rows it did not ask for.
- **Split parents are unreachable.** AQL defaults to `splits: 'inline'`, whose
  executor appends `AND is_parent = 0`. Parents never appear in any query here,
  so a split is addressable only leg by leg, and `isParent` is always false.
- **"Uncategorized" is not just a null category.** Actual's own
  `conditionSpecialCases` expands `category is null` to *and not a transfer, and
  not a split parent*, because both legs of a transfer carry a null category.
  `buildSearchFilter` mirrors that, or cleanup would invite an agent to
  categorize transfers.
- **`batchUpdateTransactions` reports transfer bookkeeping, not writes.** Its
  `updated` field is `transfersUpdated` when `runTransfers` is on (the default),
  which is empty for an ordinary categorization. `applyActions` therefore
  confirms by reading the rows back instead of echoing that field.
- **loot-core's logger defaults to verbose and writes to stdout.** A failed
  login logs the whole request body — including `ACTUAL_PASSWORD` — via
  `logger.log` → `console.log`, and the same logger narrates every sync, which
  on stdio would interleave non-JSON lines into the JSON-RPC stream. `init` is
  therefore called with `verbose: false`; warnings and errors are not gated by
  the flag and go to stderr, so nothing diagnostic is lost.
- **`db.update` inserts when the row is absent.** It is CRDT message-based, and
  `applyMessages` chooses INSERT vs UPDATE purely on whether the row exists. So
  "updating" an unknown id *creates* the entity — and for payees, without the
  `payee_mapping` row that `insertPayee` adds, so it can never be associated
  with a transaction. Every update path checks existence first.
- **`schedules-get` renames its fields.** `scheduleModel.toExternal` maps
  `_payee`/`_account`/`_amount` to `payee`/`account`/`amount`; reading the
  underscored names off the result silently yields undefined for all of them.
  `amount` is `{num1, num2}` rather than a number when `amountOp` is
  `isbetween`.
- **`updateCategory` calls `category.name.trim()` unconditionally**, exactly
  like `updateCategoryGroup`, so a hidden-only or move-only patch throws a
  `TypeError` from inside the library. Both resend the current name.
- **`holdBudgetForNextMonth` adds and clamps.** It returns `buffered + amount`,
  clamped to what is available, yet reports `true` whenever `to-budget > 0` — so
  a partial hold is indistinguishable from a full one, and two calls compound.
  The repo reads the resulting buffer back and reports `heldAmount`.
- **`setCategoryCarryover` is not scoped to one month.** It applies the flag to
  every month from the given one to the end of the budget range. Stated in the
  tool description rather than left invisible.
- **`budget-set-amount` validates nothing.** No month check and no category
  check, so a bad month leaves a junk row behind before failing on read-back,
  and an income category accepts the write and discards it. Both are rejected
  before writing.
- **`bank-sync` only errors for accounts it attempted.** Unknown, closed, and
  unlinked accounts are skipped silently, so the handler returning cleanly did
  not mean anything synced. Eligibility is checked against `account_id` — the
  field the handler itself requires — before claiming success.
- **`api/transaction-update` does not await its own write.** It ends with
  `return handlers['transactions-batch-update'](diff)['updated']` — indexing the
  promise rather than awaiting it — so the write is still in flight when
  `updateTransaction` resolves, and an immediate read-back can return the *old*
  row. `update` therefore polls until a field it changed actually moves, instead
  of trusting the ordering.
- **`getTransactions` returns splits grouped.** `api/transactions-get` queries
  with `splits: 'grouped'`, so a split arrives as one parent carrying its legs
  in `subtransactions`; the legs are not rows. `listForAccount` flattens parent
  and legs, or every leg — and the categories that make a split meaningful —
  would silently vanish from the "exhaustive" per-account read.
- **Income categories report `received`, not `spent`.** `api/budget-month`
  branches on `group.is_income`, and on the default envelope budget an income
  category carries *only* `received`. Reading `spent` off one reports a real
  salary as 0, so `BudgetCategory` carries `isIncome` and `received`.
- **Account balances are as of today.** `api/account-balance` defaults `cutoff`
  to `new Date()` and filters `date <= cutoff`, while Actual's own account
  screen sums without a date bound. Future-dated transactions are therefore
  excluded here. Kept ("current" means today) but stated in the tool
  description, so the two are not silently inconsistent.
- **Previewing can insert payees.** `runRules` ends in
  `finalizeTransactionForRules`, which calls `insertPayee` for a `set payee_name`
  action naming a payee that does not exist. Nothing else is written and no
  transaction is touched, but this means `preview_rule_effects` is not perfectly
  side-effect-free; it reports the rules capable of it in `createsPayees` rather
  than hiding it. The read-only refusal is scoped to rules whose `payee_name`
  target does **not** already resolve to a payee (or is a non-literal template):
  a rename to an existing payee — the common cleanup case — cannot insert, so it
  no longer blocks a read-only preview. The refusal stays conservative on
  matching (it cannot know which rules fire without running them).
- **`resolve_name_to_id` queries AQL directly**, not via `getIDByName`. That
  handler signals "no match" only by throwing an APIError with a human-readable
  message, and keying null-vs-error on that string coupled us to its wording — a
  reworded miss would become a thrown error, a closed budget a false "not found".
  Running the same query (`q(type).filter({ name }).select(['id'])`) makes an
  empty result the unambiguous null and lets any real failure propagate.

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

## Operational decisions

- **Auth fails closed.** The server refuses to start without `MCP_ACTUAL_TOKEN`
  unless `SECURE_LOCAL_NET=true` states that an unauthenticated server is
  intended. An unset variable is indistinguishable from a misspelled one, so
  starting-and-warning turned one typo into an open, writable server over
  someone's finances. Read-only deployments are held to the same rule — the data
  is exposed either way.
- **Every operation has a deadline** (`ACTUAL_TIMEOUT_MS`, default 120s). Calls
  are serialized through one queue, so an unbounded hang stalls the whole server
  rather than one request. The deadline is measured from when the operation
  *begins executing*, not from when it was enqueued — otherwise a burst of
  healthy-but-slow calls would spend a queued call's whole budget on queue wait
  and spuriously time it out, tripping the stalled latch under mere load. On
  timeout the *caller* is rejected but the queue keeps waiting for the real
  operation: `@actual-app/api` takes no `AbortSignal`, so a timed-out call is
  still running against the shared budget and starting the next one would break
  the serialization the client exists to provide. Meanwhile the client is marked
  stalled and later calls fail immediately instead of queueing invisibly,
  recovering by itself if the operation settles.
  `run_bank_sync` passes its own 10-minute deadline: it is legitimately slow,
  and the general timeout exists to catch hangs, not slowness.
- **`@actual-app/api` is pinned exactly**, not caret-ranged. The behaviours
  documented above are internal — handler names, split modes, field renames,
  which fields a model's `toExternal` emits — and a minor release can change any
  of them silently. Re-run this audit when bumping it.
- **A read tool that can write is refused, not tolerated.**
  `preview_rule_effects` is read-only except that Actual's engine inserts a
  payee for a `set payee_name` rule. With `ACTUAL_ENABLE_WRITES=false` the
  operator has said this server may not change the budget, so the preview
  refuses with the offending rule ids rather than writing behind the gate.

## Prompts

The server exposes MCP **prompts** as well as tools, in `src/mcp/prompts.ts`,
behind the same registry-plus-gate shape as tools.

| Prompt | |
| --- | --- |
| `explore_budget` | Orientation: what the budget holds, which tool answers what, and the conventions |
| `categorize_transactions` | Triage uncategorized spending by payee, propose categories, apply on approval |
| `cleanup_payees` | Cluster duplicate merchant names, review, merge on confirmation |
| `backfill_rule` | Preview → confirm → apply, for backfilling a rule over existing transactions |

A prompt is guidance, not access: it cannot reach the budget, so all it adds is
an ordering over tool calls, and the conventions (sync first, ids over names,
integer cents, truncation is not completeness) an agent would otherwise have to
rediscover. That is worth most precisely where the tools are sharp —
`preview_rule_effects` reports the whole rule set rather than one rule,
`apply_rule_actions` does not re-check conditions, and `merge_payees` cannot be
undone.

Three decisions, the last two observed rather than assumed:

- **Prompts are *not* write-gated.** They mutate nothing, and a read-only server
  is exactly where an agent most needs to be told that writing is not an
  option — withholding the workflow would leave it improvising instead. Each
  prompt renders against a `PromptContext`, so its write steps are replaced by
  an explicit "this is read-only, stop after the analysis" rather than
  disappearing. Gating them would also mean a read-only server registers no
  prompts at all and so advertises no prompts capability, making `prompts/list`
  fail with *Method not found* instead of returning a list.
- **A declared `argsSchema` makes `arguments` mandatory**, even when every
  argument in it is optional: a request omitting the member outright fails
  validation, so a client invoking a prompt bare gets an error instead of the
  prompt. `registerPrompt` re-wraps whatever shape it is handed, so
  `tolerateMissingArguments` in `server.ts` patches the registered schema
  afterwards to a `.default({})` that still exposes `.shape` for the listing.
  Tests cover both halves, so an SDK upgrade that changes this fails loudly.
- **Arguments are always optional.** A prompt asks the user for what it needs
  rather than failing, so it stays useful when a client offers no way to fill
  arguments in.

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
