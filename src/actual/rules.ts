import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import { money } from './money.ts';
import { buildSearchFilter, type TransactionSearch } from './transactions.ts';
import type { Rule, RuleFieldChange, RulePreview, RulePreviewEntry } from './types.ts';

export interface RulesRepo {
  list(options?: { payeeId?: string }): Promise<Rule[]>;
  create(rule: RuleInput): Promise<Rule>;
  update(id: string, rule: RuleInput): Promise<Rule>;
  previewEffects(filters: TransactionSearch): Promise<RulePreview>;
  applyActions(transactionIds: string[], actions: unknown[]): Promise<RuleApplyResult>;
}

/** What {@link RulesRepo.applyActions} actually changed. */
export interface RuleApplyResult {
  /** Ids Actual reported as updated. */
  updated: string[];
  /** Ids that were asked for but did not exist — reported rather than silently dropped. */
  missing: string[];
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

  const fetchRaw = async (filter: Record<string, unknown>, limit: number): Promise<RawTransaction[]> => {
    const query = api
      .q('transactions')
      .filter(filter)
      .select(RULE_FIELDS)
      .orderBy([{ date: 'desc' }])
      .limit(limit);
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
      client.run(async () => {
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
     */
    previewEffects: (filters) =>
      client.run(async () => {
        // Fetch one extra row: if it comes back, more matched than we scanned.
        const rows = await fetchRaw(buildSearchFilter(filters), filters.limit + 1);
        const truncated = rows.length > filters.limit;
        const scanned = truncated ? rows.slice(0, filters.limit) : rows;
        const names = await nameMaps();
        const resolve = (kind: 'payees' | 'categories', id: unknown): unknown =>
          typeof id === 'string' ? (names[kind].get(id) ?? id) : id;

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
            changes,
          });
        }
        return { entries, scanned: scanned.length, truncated };
      }),

    /**
     * Apply actions to an explicit set of transactions, and save. Actual's
     * `rule-apply-actions` applies the actions **unconditionally** — it never
     * evaluates rule conditions — so the caller is responsible for having
     * chosen the transactions, which is why this takes ids rather than a filter.
     */
    applyActions: (transactionIds, actions) =>
      client.run(async () => {
        const rows = await fetchRaw({ id: { $oneof: transactionIds } }, transactionIds.length);
        const found = new Set(rows.map((row) => row.id));
        const missing = transactionIds.filter((id) => !found.has(id));
        if (rows.length === 0) {
          return { updated: [], missing, errors: [] };
        }
        const result = await client.send('rule-apply-actions', {
          transactions: rows as never,
          actions: actions as never,
        });
        // The handler returns null when it could not parse an action — a silent
        // "nothing happened" would read as success.
        if (result === null) {
          throw new Error(
            'Actual rejected the actions — one or more could not be parsed. Check the format with describe_rule_schema.',
          );
        }
        return {
          updated: (result.updated as { id?: string }[])
            .map((row) => row?.id)
            .filter((id): id is string => Boolean(id)),
          missing,
          errors: result.errors ?? [],
        };
      }),
  };
}
