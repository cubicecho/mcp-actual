import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import { money } from './money.ts';
import { buildSearchFilter, type TransactionSearch } from './transactions.ts';
import type { Rule, RuleFieldChange, RulePreview, RulePreviewEntry } from './types.ts';

export interface RulesRepo {
  list(options?: { payeeId?: string }): Promise<Rule[]>;
  create(rule: RuleInput): Promise<Rule>;
  update(id: string, rule: RuleInput): Promise<Rule>;
  previewEffects(filters: TransactionSearch, options?: { allowPayeeCreation?: boolean }): Promise<RulePreview>;
  applyActions(transactionIds: string[], actions: unknown[]): Promise<RuleApplyResult>;
}

/**
 * What {@link RulesRepo.applyActions} actually changed, confirmed by reading
 * the transactions back rather than by trusting the handler's return value.
 * `batchUpdateTransactions` reports `updated` as the *transfer* bookkeeping it
 * performed, which is empty for an ordinary categorization — reporting that
 * verbatim would make every successful apply look like a no-op.
 */
export interface RuleApplyResult {
  /** Ids that existed and were handed to Actual. */
  applied: string[];
  /** Ids that were asked for but did not exist — reported rather than silently dropped. */
  missing: string[];
  /** Ids no longer present afterwards, i.e. a `delete-transaction` action landed. */
  deleted: string[];
  /** Rule errors Actual attached to the transactions it processed. */
  errors: string[];
}

/**
 * A rule as a tool supplies it. Conditions and actions stay `unknown[]` here —
 * they are validated by the zod schema at the tool boundary (see
 * `src/mcp/tools/rules.ts`), which mirrors Actual's discriminated union far
 * more precisely than a hand-written interface could.
 */
export interface RuleInput {
  stage: 'pre' | 'post' | null;
  conditionsOp: 'and' | 'or';
  conditions: unknown[];
  actions: unknown[];
}

type RawRule = Awaited<ReturnType<typeof api.getRules>>[number];

/**
 * The columns the rule engine reads and writes. These are bare (undotted)
 * selects on purpose: `rules-run` wants a transaction shaped like the database
 * row, not the join-expanded shape `search_transactions` returns.
 */
const RULE_FIELDS = [
  'id',
  'date',
  'amount',
  'notes',
  'cleared',
  'reconciled',
  'imported_payee',
  'account',
  'payee',
  'category',
  // Split bookkeeping. AQL defaults to `splits: 'inline'`, whose executor
  // appends `AND is_parent = 0`, so parents never come back from these queries
  // and only the legs are addressable. These are selected anyway because
  // `batchUpdateTransactions` nulls a parent's category only when it can see
  // `is_parent`, and that guard must work if a parent ever does reach it.
  'is_parent',
  'is_child',
  'parent_id',
  // Running balances are computed from date + sort_order; without it, any
  // balance-based condition or formula evaluates against the wrong ordering.
  'sort_order',
];

/** The fields a preview reports on. Anything a rule changes outside this set is still applied, just not shown. */
const DIFFED_FIELDS = ['payee', 'category', 'notes', 'cleared', 'amount', 'date'] as const;

/** A raw transaction row as the rule engine consumes it. */
type RawTransaction = Record<string, unknown> & { id: string; date: string; amount: number };

/**
 * Fields the preview reports as names rather than opaque ids. A diff reading
 * `category: "a1b2…" → "c3d4…"` is useless to an agent deciding whether to
 * apply it.
 */
const NAMED_FIELDS: Record<string, 'payees' | 'categories'> = { payee: 'payees', category: 'categories' };

/**
 * Compare a transaction before and after the rule engine ran, reporting only
 * the fields that actually changed. Pure and exported so the diff logic is
 * testable without an Actual server — `resolve` maps an id to a display name.
 */
export function diffTransaction(
  before: RawTransaction,
  after: Record<string, unknown>,
  resolve: (kind: 'payees' | 'categories', id: unknown) => unknown,
): Record<string, RuleFieldChange> {
  const changes: Record<string, RuleFieldChange> = {};
  for (const field of DIFFED_FIELDS) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from === to) {
      continue;
    }
    const kind = NAMED_FIELDS[field];
    // Id-bearing fields carry both sides: the name is what a human reads, the
    // id is what an `apply_rule_actions` action takes as its value.
    changes[field] = kind
      ? {
          from: resolve(kind, from),
          to: resolve(kind, to),
          fromId: typeof from === 'string' ? from : null,
          toId: typeof to === 'string' ? to : null,
        }
      : { from, to };
  }
  return changes;
}

function toRule(raw: RawRule): Rule {
  return {
    id: raw.id,
    stage: raw.stage ?? null,
    conditionsOp: raw.conditionsOp,
    conditions: raw.conditions,
    actions: raw.actions,
  };
}

export function createRulesRepo(client: ActualClient): RulesRepo {
  /** Id → name for the fields a preview renders by name. Two small reads, done once per preview. */
  const nameMaps = async (): Promise<Record<'payees' | 'categories', Map<string, string>>> => {
    const [payees, categories] = await Promise.all([api.getPayees(), api.getCategories()]);
    return {
      payees: new Map(payees.map((payee) => [payee.id as string, payee.name])),
      categories: new Map(categories.map((category) => [category.id as string, category.name])),
    };
  };

  const fetchRaw = async (filter: Record<string, unknown>, limit: number, offset = 0): Promise<RawTransaction[]> => {
    const base = api
      .q('transactions')
      .filter(filter)
      .select(RULE_FIELDS)
      .orderBy([{ date: 'desc' }])
      .limit(limit);
    const query = offset > 0 ? base.offset(offset) : base;
    const { data } = (await api.aqlQuery(query)) as { data: RawTransaction[] };
    return data;
  };

  return {
    /**
     * All rules, or only those Actual associates with one payee. The payee
     * filter uses `getPayeeRules`, which resolves rules that *reference* the
     * payee rather than string-matching our own way.
     */
    list: (options) =>
      client.read(async () => {
        const raw = options?.payeeId ? await api.getPayeeRules(options.payeeId) : await api.getRules();
        return raw.map(toRule);
      }),

    create: (rule) =>
      client.run(async () => {
        const created = await api.createRule(rule as Parameters<typeof api.createRule>[0]);
        return toRule(created as RawRule);
      }),

    /**
     * Actual's `updateRule` replaces the whole rule, so callers must send the
     * complete conditions/actions set — a partial update would silently drop
     * whatever it omitted.
     */
    update: (id, rule) =>
      client.run(async () => {
        const updated = await api.updateRule({ id, ...rule } as Parameters<typeof api.updateRule>[0]);
        return toRule(updated as RawRule);
      }),

    /**
     * Run the budget's rules over the matching transactions **in memory** and
     * report what would change. Nothing is written.
     *
     * This delegates to Actual's own engine (`rules-run`), which is why it
     * cannot drift from real behaviour — but that engine takes a transaction
     * and runs the whole ranked rule set over it. There is no per-rule matcher
     * on the handler surface, so this reports the net effect of *all* rules,
     * not one rule in isolation. See SPECS.md.
     *
     * One caveat, and it is the library's rather than ours: `runRules` finishes
     * with `finalizeTransactionForRules`, which calls `insertPayee` when a rule
     * sets `payee_name` to a payee that does not exist yet. So a budget
     * containing a payee-rename rule can gain payee rows from a "preview".
     * Nothing else is written, and no transaction is touched. Rules whose
     * actions could do this are reported in `createsPayees` so the caller is
     * never surprised by it.
     */
    previewEffects: (filters, options) =>
      client.read(async () => {
        // Fetch one extra row: if it comes back, more matched than we scanned.
        const rows = await fetchRaw(buildSearchFilter(filters), filters.limit + 1, filters.offset);
        const truncated = rows.length > filters.limit;
        const scanned = truncated ? rows.slice(0, filters.limit) : rows;
        const names = await nameMaps();
        const resolve = (kind: 'payees' | 'categories', id: unknown): unknown =>
          typeof id === 'string' ? (names[kind].get(id) ?? id) : id;

        // `rules-run` runs the whole rule set, and a `set payee_name` action
        // inserts a payee *only when that name does not already exist* — Actual's
        // `finalizeTransactionForRules` resolves an existing name rather than
        // creating. So a rename to a payee that already exists (the common
        // cleanup case) is safe to preview; only a rename to a genuinely new
        // name, or a non-literal template value we cannot check, can write.
        // This still cannot tell whether such a rule matches the scanned rows,
        // so it stays conservative on that axis, but it no longer blocks every
        // budget that merely contains a rename rule.
        const existingPayeeNames = new Set([...names.payees.values()].map((name) => name.toLowerCase()));
        const wouldInsertPayee = (action: { op?: string; field?: string; value?: unknown }): boolean =>
          action?.op === 'set' &&
          action?.field === 'payee_name' &&
          (typeof action.value !== 'string' || !existingPayeeNames.has(action.value.toLowerCase()));
        const createsPayees = (await api.getRules())
          .filter((rule) =>
            (rule.actions as { op?: string; field?: string; value?: unknown }[] | undefined)?.some(wouldInsertPayee),
          )
          .map((rule) => rule.id);
        // Refuse rather than write behind the gate's back. With writes
        // disabled the operator has said this server may not change the budget,
        // and inserting a payee — even one the next import would have created —
        // is still a change they did not authorize.
        if (createsPayees.length > 0 && !options?.allowPayeeCreation) {
          throw new Error(
            `Cannot preview: ${createsPayees.length} rule(s) set \`payee_name\`, and Actual's engine creates an ` +
              'unknown payee as it finalizes — so previewing would write to the budget. Writes are disabled on ' +
              `this server. Rule ids: ${createsPayees.join(', ')}`,
          );
        }

        const entries: RulePreviewEntry[] = [];
        for (const row of scanned) {
          const after = (await client.send('rules-run', {
            transaction: row as never,
          })) as unknown as Record<string, unknown>;
          const changes = diffTransaction(row, after, resolve);
          if (Object.keys(changes).length === 0) {
            continue;
          }
          entries.push({
            transactionId: row.id,
            date: row.date,
            payeeName: typeof row.payee === 'string' ? names.payees.get(row.payee) : undefined,
            ...money(row.amount),
            isParent: Boolean(row.is_parent),
            isChild: Boolean(row.is_child),
            changes,
          });
        }
        return { entries, scanned: scanned.length, truncated, createsPayees };
      }),

    /**
     * Apply actions to an explicit set of transactions, and save. Actual's
     * `rule-apply-actions` applies the actions **unconditionally** — it never
     * evaluates rule conditions — so the caller is responsible for having
     * chosen the transactions, which is why this takes ids rather than a filter.
     */
    applyActions: (transactionIds, actions) =>
      // Read-modify-write: sync first, so the rows handed to Actual are not a
      // stale copy of what another client has since changed.
      client.read(async () => {
        const rows = await fetchRaw({ id: { $oneof: transactionIds } }, transactionIds.length);
        // Defence in depth. AQL interpolates id values into SQL unescaped, so a
        // malformed id can widen `IN (...)` into a match on the whole table —
        // `idSchema` rejects that at the tool boundary, and this makes sure a
        // second caller cannot hand this bulk write more rows than it asked for.
        const requested = new Set(transactionIds);
        const targeted = rows.filter((row) => requested.has(row.id));
        if (targeted.length !== rows.length) {
          throw new Error(
            `Refusing to apply: the lookup matched ${rows.length} transactions for ${transactionIds.length} ids.`,
          );
        }
        const found = new Set(targeted.map((row) => row.id));
        const missing = transactionIds.filter((id) => !found.has(id));
        if (rows.length === 0) {
          return { applied: [], missing, deleted: [], errors: [] };
        }
        const result = await client.send('rule-apply-actions', {
          transactions: targeted as never,
          actions: actions as never,
        });
        // The handler returns null when it could not parse an action — a silent
        // "nothing happened" would read as success.
        if (result === null) {
          throw new Error(
            'Actual rejected the actions — one or more could not be parsed. Check the format with describe_rule_schema.',
          );
        }
        // Deliberately NOT `result.updated`: with `runTransfers` on (the
        // default) that field carries the transfer bookkeeping, which is empty
        // for an ordinary categorization. Confirm by reading the rows back.
        const applied = [...found];
        const after = await fetchRaw({ id: { $oneof: applied } }, applied.length);
        const surviving = new Set(after.map((row) => row.id));
        return {
          applied,
          missing,
          deleted: applied.filter((id) => !surviving.has(id)),
          errors: result.errors ?? [],
        };
      }),
  };
}
