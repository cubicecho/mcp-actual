/**
 * The entity shapes this server returns over MCP. They are deliberately *not*
 * Actual's own types: the API's entities carry internal bookkeeping (tombstones,
 * sort orders, sync ids) that is noise to an agent, and re-shaping here keeps
 * the tool contract stable if the library's types move.
 *
 * Money is always integer minor units (cents) in `*Amount` fields, with a
 * decimal sibling for readability. Tools return both and accept only integers.
 */

/** An amount rendered both ways: integer cents for math, decimal for display. */
export interface Money {
  /** Minor units (cents) — Actual's native representation. Use this for math. */
  amount: number;
  /** The same value in currency units. Display only; never send it back. */
  amountDecimal: number;
}

export interface AccountBalance extends Money {
  id: string;
  name: string;
  /** Tracking (off-budget) accounts are excluded from the budget's available funds. */
  offBudget: boolean;
  closed: boolean;
}

/** Accounts plus totals, so an agent does not have to sum them itself. */
export interface AccountBalances {
  accounts: AccountBalance[];
  /** Sum of the open, on-budget accounts — Actual's headline "balance". */
  onBudgetTotal: number;
  /** Sum of every open account, on- and off-budget. */
  total: number;
}

export interface Category {
  id: string;
  name: string;
  groupId?: string;
  groupName?: string;
  isIncome: boolean;
  hidden: boolean;
}

export interface CategoryGroup {
  id: string;
  name: string;
  isIncome: boolean;
  hidden: boolean;
  /** Categories the group holds, hidden ones included — 0 marks an empty group. */
  categoryCount: number;
}

export interface Payee {
  id: string;
  name: string;
  /**
   * Set when this payee represents the other side of a transfer rather than a
   * real merchant. Transfer payees must never be merged — it would corrupt the
   * transfers that reference them.
   */
  transferAccountId?: string;
  /** How many transactions reference this payee. Absent when usage was not requested. */
  transactionCount?: number;
  /** ISO date of the most recent transaction for this payee, if any. */
  lastTransactionDate?: string;
}

/** A cluster of payees whose names are similar enough to be worth merging. */
export interface PayeeDuplicateGroup {
  /** The suggested merge target: the most-used payee in the cluster. */
  suggestedTarget: Payee;
  /** The other members, ordered most-used first. */
  candidates: Payee[];
  /** Why these were grouped, e.g. "normalized name matches" — shown to the agent, never acted on automatically. */
  reason: string;
}

export interface Transaction extends Money {
  id: string;
  date: string;
  accountId: string;
  accountName?: string;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  categoryName?: string;
  notes?: string;
  cleared: boolean;
  reconciled: boolean;
  /** The payee string as the bank sent it, before any rule rewrote it. */
  importedPayee?: string;
  transferAccountId?: string;
  isParent: boolean;
  isChild: boolean;
}

/** A page of transactions, with an explicit truncation flag — silent caps read as "that's all of them". */
export interface TransactionPage {
  transactions: Transaction[];
  /** How many were returned. */
  count: number;
  /** True when more matched than the limit allowed; narrow the filters or raise `limit`. */
  truncated: boolean;
}

export interface Rule {
  id: string;
  /** `pre` runs before other rules, `post` after; null is the normal stage. */
  stage: 'pre' | 'post' | null;
  /** Whether every condition must match, or any one of them. */
  conditionsOp: 'and' | 'or';
  conditions: unknown[];
  actions: unknown[];
}

/** One field a rule run would rewrite. */
export interface RuleFieldChange {
  /** Display value — a name for id-bearing fields (payee, category), the raw value otherwise. */
  from: unknown;
  to: unknown;
  /**
   * The underlying ids, present only for id-bearing fields. `toId` is the value
   * an `apply_rule_actions` action needs, so the preview stays actionable
   * without a second name→id lookup.
   */
  fromId?: string | null;
  toId?: string | null;
}

/** A transaction the rule set would touch, and what it would change on it. */
export interface RulePreviewEntry {
  transactionId: string;
  date: string;
  payeeName?: string;
  amount: number;
  amountDecimal: number;
  /**
   * Always false in practice: AQL's default `inline` split mode filters parents
   * out, so a preview only ever sees the legs. Carried so the distinction is
   * explicit rather than assumed.
   */
  isParent: boolean;
  /** True for one leg of a split. The parent is not listed alongside it. */
  isChild: boolean;
  /** Keyed by field name; only fields the rules actually change appear. */
  changes: Record<string, RuleFieldChange>;
}

/**
 * The result of running the rule set over a set of transactions **without
 * saving anything**. `scanned` counts what was evaluated, not what changed —
 * an empty `entries` with a large `scanned` means the rules are a no-op here.
 */
export interface RulePreview {
  entries: RulePreviewEntry[];
  scanned: number;
  /** True when more transactions matched the filter than `limit` allowed. */
  truncated: boolean;
  /**
   * Ids of rules whose `set payee_name` action can make even a preview insert a
   * payee, because Actual's engine creates unknown payees as it finalizes. Empty
   * for the usual case; non-empty means previewing has a side effect.
   */
  createsPayees: string[];
}

export interface BudgetMonthSummary {
  month: string;
  /** Still unbudgeted this month. */
  toBudget: number;
  totalBudgeted: number;
  totalIncome: number;
  totalSpent: number;
  totalBalance: number;
  fromLastMonth: number;
  forNextMonth: number;
  categories: BudgetCategory[];
}

export interface BudgetCategory {
  id: string;
  name: string;
  groupName?: string;
  /** Income categories track money coming in; `received` carries it, not `spent`. */
  isIncome: boolean;
  budgeted: number;
  spent: number;
  balance: number;
  /**
   * Income only. Actual reports income as `received` and leaves `spent` unset,
   * so on the default envelope budget an income category's budgeted/spent/
   * balance are all genuinely 0 — this is the figure that means anything.
   */
  received?: number;
  /** When true, an unspent balance rolls into next month instead of returning to "to budget". */
  carryover: boolean;
}

export interface Schedule {
  id: string;
  name?: string;
  accountId?: string;
  payeeId?: string;
  /** Integer cents. Absent when the schedule matches an amount *range* — see below. */
  amount?: number;
  amountDecimal?: number;
  /** How `amount` is matched: "is", "isapprox", "isbetween", … */
  amountOp?: string;
  /** Range bounds, in cents, present instead of `amount` when `amountOp` is "isbetween". */
  amountMin?: number;
  amountMax?: number;
  nextDate?: string;
  completed: boolean;
  posts_transaction: boolean;
}

export interface Tag {
  id: string;
  tag: string;
  color?: string;
  description?: string;
}
