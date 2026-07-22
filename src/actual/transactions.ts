import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import { money } from './money.ts';
import type { Transaction, TransactionPage, TransferPair } from './types.ts';

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
  /** How many matching rows to skip, for paging past `limit`. Defaults to 0. */
  offset?: number;
}

export interface TransactionsRepo {
  search(filters: TransactionSearch): Promise<TransactionPage>;
  listForAccount(accountId: string, startDate: string, endDate: string): Promise<Transaction[]>;
  update(id: string, fields: TransactionUpdate): Promise<Transaction | null>;
  linkTransfer(transactionId: string, counterpartId: string): Promise<TransferPair>;
  unlinkTransfer(transactionId: string): Promise<TransferPair>;
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

/** A transaction entity as the API's own handlers return it, before narrowing. */
type RawEntity = Record<string, unknown>;

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
    transferId: optional(row.transfer_id),
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
    // Actual treats "category is null" as *and not a transfer, and not a split
    // parent* — see `conditionSpecialCases` in the rule engine. Both legs of
    // every account transfer legitimately carry a null category, so the bare
    // filter would offer them up as cleanup targets and an agent would
    // categorize them, which is exactly what that special case prevents. Split
    // parents are already excluded by the query's `inline` split mode.
    conditions.push({ category: null }, { 'payee.transfer_acct': null });
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

/** One entry of a `transactions-batch-update` patch. Only the fields transfers touch. */
interface TransferPatch {
  id: string;
  payee?: string | null;
  transfer_id?: string | null;
  category?: string | null;
}

export function createTransactionsRepo(client: ActualClient): TransactionsRepo {
  /**
   * Read specific transactions by id. `splits: 'all'` because the default
   * `inline` mode appends `AND is_parent = 0`, which would report a split
   * parent as "no such transaction" instead of as an invalid transfer leg.
   */
  const readByIds = async (ids: string[]): Promise<TransactionRow[]> => {
    const { data } = (await api.aqlQuery(
      api
        .q('transactions')
        .filter({ id: { $oneof: ids } })
        .select(SELECT_FIELDS)
        .options({ splits: 'all' })
        .limit(ids.length),
    )) as { data: TransactionRow[] };
    // Defence in depth, as in `applyActions`: AQL interpolates id values into
    // SQL unescaped, so a malformed id can widen `IN (...)` into a match on the
    // whole table. `idSchema` rejects that at the tool boundary; this makes
    // sure a write never acts on rows it did not ask for.
    const requested = new Set(ids);
    const targeted = data.filter((row) => requested.has(row.id));
    if (targeted.length !== data.length) {
      throw new Error(`Refusing to continue: the lookup matched ${data.length} transactions for ${ids.length} ids.`);
    }
    return targeted;
  };

  /**
   * Apply a transfer patch and return both legs as Actual stored them.
   *
   * `runTransfers: false` is load-bearing. With the default on, the engine's
   * `onUpdate` sees a transfer payee plus a `transfer_id` and calls
   * `updateTransfer`, which overwrites the counterpart's account, amount and
   * notes from this leg — so linking two real imported transactions would
   * rewrite one of them. Both legs are being set explicitly here; the engine
   * has nothing left to derive.
   */
  const applyTransferPatch = async (
    updated: TransferPatch[],
    primaryId: string,
    counterpartId?: string,
  ): Promise<TransferPair> => {
    await client.send('transactions-batch-update', { updated: updated as never, runTransfers: false });
    const ids = counterpartId ? [primaryId, counterpartId] : [primaryId];
    const byId = new Map((await readByIds(ids)).map((row) => [row.id, toTransaction(row)]));
    const transaction = byId.get(primaryId);
    if (!transaction) {
      throw new Error(`Transaction "${primaryId}" disappeared while updating it`);
    }
    return { transaction, counterpart: counterpartId ? byId.get(counterpartId) : undefined };
  };

  return {
    /**
     * Cross-account transaction search. `getTransactions` cannot answer
     * "where else does this payee appear?" — it requires one account and a
     * date range — so this goes through AQL instead.
     */
    search: (filters) =>
      client.read(async () => {
        // Fetch one extra row: if it comes back, more matched than we returned.
        const probe = filters.limit + 1;
        const base = api
          .q('transactions')
          .filter(buildSearchFilter(filters))
          .select(SELECT_FIELDS)
          .orderBy([{ date: 'desc' }, { amount: 'desc' }])
          .limit(probe);
        const query = filters.offset ? base.offset(filters.offset) : base;
        const { data } = (await api.aqlQuery(query)) as { data: TransactionRow[] };
        const truncated = data.length > filters.limit;
        const rows = truncated ? data.slice(0, filters.limit) : data;
        return { transactions: rows.map(toTransaction), count: rows.length, truncated };
      }),

    listForAccount: (accountId, startDate, endDate) =>
      client.read(async () => {
        const rows = await api.getTransactions(accountId, startDate, endDate);
        // `api/transactions-get` queries with `splits: 'grouped'`, so a split
        // arrives as one parent carrying its legs in `subtransactions` — the
        // legs are not rows of their own. Mapping only the top level would drop
        // every leg, and with them the categories that make a split meaningful.
        const flattened: RawEntity[] = [];
        for (const row of rows as RawEntity[]) {
          const { subtransactions, ...parent } = row;
          flattened.push(parent);
          for (const leg of (subtransactions as RawEntity[] | undefined) ?? []) {
            flattened.push(leg);
          }
        }
        // getTransactions returns entities, not AQL rows: ids only, no joined names.
        return flattened.map((row) =>
          toTransaction({
            id: row.id as string,
            date: row.date as string,
            amount: row.amount as number,
            notes: row.notes as string | null | undefined,
            cleared: row.cleared as boolean | undefined,
            reconciled: row.reconciled as boolean | undefined,
            is_parent: row.is_parent as boolean | undefined,
            is_child: row.is_child as boolean | undefined,
            imported_payee: row.imported_payee as string | null | undefined,
            account: row.account as string | undefined,
            payee: row.payee as string | undefined,
            category: row.category as string | undefined,
          }),
        );
      }),

    /**
     * Apply a narrow set of field changes, then read the transaction back so
     * the caller sees what Actual actually stored — rules can rewrite a value
     * on write, and reporting the requested value would be a lie.
     */
    update: (id, fields) =>
      client.read(async () => {
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
        const readRow = async (): Promise<TransactionRow | undefined> => {
          const { data } = (await api.aqlQuery(
            // `splits: 'all'` so a split parent is addressable: the default
            // `inline` mode appends `AND is_parent = 0`, which would report a
            // successful update to a parent as "no such transaction".
            api.q('transactions').filter({ id }).select(SELECT_FIELDS).options({ splits: 'all' }).limit(1),
          )) as { data: TransactionRow[] };
          return data[0];
        };

        const before = await readRow();
        if (!before) {
          return null;
        }
        // Which fields this patch would actually change. Comparing against
        // these is how we know the write landed, below.
        const fieldOf = (row: TransactionRow | undefined, key: string): unknown =>
          (row as RawEntity | undefined)?.[key] ?? null;
        const pending = Object.keys(patch).filter((key) => fieldOf(before, key) !== (patch[key] ?? null));

        await api.updateTransaction(id, patch);

        // `api/transaction-update` does `return handlers['transactions-batch-update'](diff)['updated']`
        // — indexing the promise instead of awaiting it — so the write is still
        // in flight when `updateTransaction` resolves. Reading immediately can
        // observe the old row and report it as "what Actual stored". Poll until
        // a targeted field moves rather than trusting the ordering.
        let row = await readRow();
        for (let attempt = 0; pending.length > 0 && attempt < 20; attempt++) {
          const landed = pending.some((key) => fieldOf(row, key) !== fieldOf(before, key));
          if (landed) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          row = await readRow();
        }
        return row ? toTransaction(row) : null;
      }),

    /**
     * Pair two transactions that already exist as the two legs of one transfer:
     * each leg's payee becomes the *other* account's transfer payee, and each
     * leg's `transfer_id` points at the other.
     *
     * This is deliberately not the same operation as setting a transfer payee
     * with `update`. That path runs Actual's `addTransfer`, which **inserts** a
     * counter-transaction in the destination account — correct when only one
     * side exists, a duplicate when both accounts imported the same movement.
     * Linking is the case the public API has no function for, so it goes
     * through the `transactions-batch-update` handler directly.
     *
     * Validation mirrors loot-core's own `validForTransfer` (different
     * accounts, amounts cancelling, neither already linked) plus a split-parent
     * check: `addTransfer` refuses parents and `onUpdate` strips a transfer
     * from one, so a parent can never be a leg.
     */
    linkTransfer: (transactionId, counterpartId) =>
      // Read-modify-write: sync first, so the rows this validates against are
      // not a stale copy of what another client has since changed.
      client.read(async () => {
        if (transactionId === counterpartId) {
          throw new Error('A transfer needs two different transactions; the same id was given twice.');
        }
        const rows = await readByIds([transactionId, counterpartId]);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const missing = [transactionId, counterpartId].filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new Error(`No transaction found with id ${missing.map((id) => `"${id}"`).join(' or ')}`);
        }
        const from = byId.get(transactionId) as TransactionRow;
        const to = byId.get(counterpartId) as TransactionRow;

        const parents = [from, to].filter((row) => row.is_parent).map((row) => `"${row.id}"`);
        if (parents.length > 0) {
          throw new Error(
            `Cannot link ${parents.join(' and ')}: a split parent cannot be a transfer leg. Link the individual ` +
              'split leg that moves the money instead.',
          );
        }
        const linked = [from, to].filter((row) => row.transfer_id);
        if (linked.length > 0) {
          const detail = linked.map((row) => `"${row.id}" is already linked to "${row.transfer_id}"`).join('; ');
          throw new Error(`Cannot link: ${detail}. Unlink it first if the existing pairing is wrong.`);
        }
        const fromAccount = refId(from.account);
        const toAccount = refId(to.account);
        if (!fromAccount || !toAccount || fromAccount === toAccount) {
          throw new Error('Cannot link: a transfer moves money between two different accounts, and both are in one.');
        }
        if (from.amount + to.amount !== 0) {
          throw new Error(
            `Cannot link: the amounts must cancel out, but ${from.amount} and ${to.amount} sum to ` +
              `${from.amount + to.amount} cents. These are not the two sides of one movement.`,
          );
        }

        // Each leg carries the *other* account's transfer payee — that is the
        // direction `addTransfer` uses, and the payee is what makes Actual (and
        // its reports) treat the row as a transfer at all.
        const payees = await api.getPayees();
        const transferPayee = (accountId: string) => payees.find((payee) => payee.transfer_acct === accountId);
        const fromPayee = transferPayee(toAccount);
        const toPayee = transferPayee(fromAccount);
        if (!fromPayee || !toPayee) {
          const which = !fromPayee ? toAccount : fromAccount;
          throw new Error(`Account "${which}" has no transfer payee, so nothing can be transferred to it.`);
        }

        // Mirror the engine's own `clearCategory`: a transfer between two
        // accounts on the same side of the budget is not spending, and leaving
        // a category on one would double-count it. Between an on-budget and an
        // off-budget account it *is* budget-relevant, and Actual keeps the
        // category there — so this does too.
        const accounts = await api.getAccounts();
        const offBudget = (id: string) => Boolean(accounts.find((account) => account.id === id)?.offbudget);
        const clearCategory = offBudget(fromAccount) === offBudget(toAccount);
        const category = clearCategory ? { category: null } : {};

        return applyTransferPatch(
          [
            { id: from.id, payee: fromPayee.id, transfer_id: to.id, ...category },
            { id: to.id, payee: toPayee.id, transfer_id: from.id, ...category },
          ],
          from.id,
          to.id,
        );
      }),

    /**
     * Break the pairing between two legs, leaving **both transactions in
     * place**. Actual's own removal path (clearing a transfer payee through the
     * UI) runs `removeTransfer`, which *deletes* the counterpart; here the
     * counterpart is usually a real imported row from the other account, and
     * deleting someone's transaction to undo a mislink is not a trade this
     * server makes.
     *
     * The payee is cleared alongside `transfer_id`, not left behind: a
     * transaction that still names a transfer payee but has no counterpart is
     * exactly the state `onUpdate` treats as "needs a leg", so the next edit
     * through Actual would silently insert one in the other account.
     */
    unlinkTransfer: (transactionId) =>
      client.read(async () => {
        const [row] = await readByIds([transactionId]);
        if (!row) {
          throw new Error(`No transaction found with id "${transactionId}"`);
        }
        if (!row.transfer_id) {
          throw new Error(`Transaction "${transactionId}" is not linked to another transaction as a transfer.`);
        }
        // The counterpart can legitimately be gone — deleted from the other
        // account by another client — and this side still needs clearing.
        const counterpartId = row.transfer_id;
        const [counterpart] = await readByIds([counterpartId]);
        const clear = (id: string): TransferPatch => ({ id, payee: null, transfer_id: null });
        return applyTransferPatch(
          counterpart ? [clear(row.id), clear(counterpart.id)] : [clear(row.id)],
          row.id,
          counterpart ? counterpartId : undefined,
        );
      }),
  };
}
