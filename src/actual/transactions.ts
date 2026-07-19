import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import { money } from './money.ts';
import type { Transaction, TransactionPage } from './types.ts';

/**
 * Filters for {@link TransactionsRepo.search}. Every field is optional; with
 * none set the query returns the most recent transactions across all accounts.
 * Amounts are integer cents, dates are `YYYY-MM-DD`.
 */
export interface TransactionSearch {
  dateFrom?: string;
  dateTo?: string;
  accountId?: string;
  payeeId?: string;
  categoryId?: string;
  /** Case-insensitive substring match against the notes field. */
  notesContains?: string;
  /** Case-insensitive substring match against the payee's name. */
  payeeNameContains?: string;
  amountMin?: number;
  amountMax?: number;
  cleared?: boolean;
  reconciled?: boolean;
  /** True to return only transactions with no category — the usual cleanup target. */
  uncategorized?: boolean;
  limit: number;
}

export interface TransactionsRepo {
  search(filters: TransactionSearch): Promise<TransactionPage>;
  listForAccount(accountId: string, startDate: string, endDate: string): Promise<Transaction[]>;
  update(id: string, fields: TransactionUpdate): Promise<Transaction | null>;
}

/** The fields a tool may change on a transaction — deliberately narrow. */
export interface TransactionUpdate {
  categoryId?: string | null;
  payeeId?: string | null;
  notes?: string | null;
  cleared?: boolean;
  date?: string;
  amount?: number;
}

/** The columns we ask AQL for; dotted paths traverse the referenced table. */
const SELECT_FIELDS = [
  'id',
  'date',
  'amount',
  'notes',
  'cleared',
  'reconciled',
  'is_parent',
  'is_child',
  'imported_payee',
  'transfer_id',
  'account',
  'account.name',
  'payee',
  'payee.name',
  'payee.transfer_acct',
  'category',
  'category.name',
];

/** A row as AQL returns it: dotted selects arrive as nested objects. */
interface TransactionRow {
  id: string;
  date: string;
  amount: number;
  notes?: string | null;
  cleared?: boolean;
  reconciled?: boolean;
  is_parent?: boolean;
  is_child?: boolean;
  imported_payee?: string | null;
  transfer_id?: string | null;
  account?: string | { id?: string; name?: string } | null;
  payee?: string | { id?: string; name?: string; transfer_acct?: string | null } | null;
  category?: string | { id?: string; name?: string } | null;
}

/** AQL returns a reference either as a bare id or as an expanded object, depending on the select. */
function refId(ref: TransactionRow['account']): string | undefined {
  if (typeof ref === 'string') {
    return ref;
  }
  return ref?.id ?? undefined;
}

function refName(ref: TransactionRow['account']): string | undefined {
  return typeof ref === 'object' && ref !== null ? (ref.name ?? undefined) : undefined;
}

/** Drop nulls so optional fields are simply absent in the JSON an agent reads. */
function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function toTransaction(row: TransactionRow): Transaction {
  const payee = typeof row.payee === 'object' && row.payee !== null ? row.payee : undefined;
  return {
    id: row.id,
    date: row.date,
    ...money(row.amount),
    accountId: refId(row.account) ?? '',
    accountName: refName(row.account),
    payeeId: refId(row.payee),
    payeeName: refName(row.payee),
    categoryId: refId(row.category),
    categoryName: refName(row.category),
    notes: optional(row.notes),
    cleared: Boolean(row.cleared),
    reconciled: Boolean(row.reconciled),
    importedPayee: optional(row.imported_payee),
    transferAccountId: optional(payee?.transfer_acct),
    isParent: Boolean(row.is_parent),
    isChild: Boolean(row.is_child),
  };
}

/**
 * Translate a {@link TransactionSearch} into an AQL filter expression. Kept
 * pure and exported so it can be unit-tested without an Actual server — the
 * mapping from user filters to query shape is where the bugs live.
 */
export function buildSearchFilter(filters: TransactionSearch): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  if (filters.dateFrom) {
    conditions.push({ date: { $gte: filters.dateFrom } });
  }
  if (filters.dateTo) {
    conditions.push({ date: { $lte: filters.dateTo } });
  }
  if (filters.accountId) {
    conditions.push({ account: filters.accountId });
  }
  if (filters.payeeId) {
    conditions.push({ payee: filters.payeeId });
  }
  if (filters.categoryId) {
    conditions.push({ category: filters.categoryId });
  }
  if (filters.uncategorized) {
    conditions.push({ category: null });
  }
  if (filters.notesContains) {
    conditions.push({ notes: { $like: `%${filters.notesContains}%` } });
  }
  if (filters.payeeNameContains) {
    conditions.push({ 'payee.name': { $like: `%${filters.payeeNameContains}%` } });
  }
  if (filters.amountMin !== undefined) {
    conditions.push({ amount: { $gte: filters.amountMin } });
  }
  if (filters.amountMax !== undefined) {
    conditions.push({ amount: { $lte: filters.amountMax } });
  }
  if (filters.cleared !== undefined) {
    conditions.push({ cleared: filters.cleared });
  }
  if (filters.reconciled !== undefined) {
    conditions.push({ reconciled: filters.reconciled });
  }
  return conditions.length > 0 ? { $and: conditions } : {};
}

export function createTransactionsRepo(client: ActualClient): TransactionsRepo {
  return {
    /**
     * Cross-account transaction search. `getTransactions` cannot answer
     * "where else does this payee appear?" — it requires one account and a
     * date range — so this goes through AQL instead.
     */
    search: (filters) =>
      client.run(async () => {
        // Fetch one extra row: if it comes back, more matched than we returned.
        const probe = filters.limit + 1;
        const query = api
          .q('transactions')
          .filter(buildSearchFilter(filters))
          .select(SELECT_FIELDS)
          .orderBy([{ date: 'desc' }, { amount: 'desc' }])
          .limit(probe);
        const { data } = (await api.aqlQuery(query)) as { data: TransactionRow[] };
        const truncated = data.length > filters.limit;
        const rows = truncated ? data.slice(0, filters.limit) : data;
        return { transactions: rows.map(toTransaction), count: rows.length, truncated };
      }),

    listForAccount: (accountId, startDate, endDate) =>
      client.run(async () => {
        const rows = await api.getTransactions(accountId, startDate, endDate);
        // getTransactions returns entities, not AQL rows: ids only, no joined names.
        return rows.map((row) =>
          toTransaction({
            id: row.id,
            date: row.date,
            amount: row.amount,
            notes: row.notes,
            cleared: row.cleared,
            reconciled: row.reconciled,
            is_parent: row.is_parent,
            is_child: row.is_child,
            imported_payee: row.imported_payee,
            account: row.account,
            payee: row.payee,
            category: row.category,
          }),
        );
      }),

    /**
     * Apply a narrow set of field changes, then read the transaction back so
     * the caller sees what Actual actually stored — rules can rewrite a value
     * on write, and reporting the requested value would be a lie.
     */
    update: (id, fields) =>
      client.run(async () => {
        const patch: Record<string, unknown> = {};
        if (fields.categoryId !== undefined) {
          patch.category = fields.categoryId;
        }
        if (fields.payeeId !== undefined) {
          patch.payee = fields.payeeId;
        }
        if (fields.notes !== undefined) {
          patch.notes = fields.notes;
        }
        if (fields.cleared !== undefined) {
          patch.cleared = fields.cleared;
        }
        if (fields.date !== undefined) {
          patch.date = fields.date;
        }
        if (fields.amount !== undefined) {
          patch.amount = fields.amount;
        }
        await api.updateTransaction(id, patch);
        const { data } = (await api.aqlQuery(api.q('transactions').filter({ id }).select(SELECT_FIELDS).limit(1))) as {
          data: TransactionRow[];
        };
        const row = data[0];
        return row ? toTransaction(row) : null;
      }),
  };
}
