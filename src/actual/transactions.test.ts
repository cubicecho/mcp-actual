import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTransactions = vi.fn();
const aqlQuery = vi.fn();
const getPayees = vi.fn();
const getAccounts = vi.fn();

/**
 * A stand-in for the AQL query builder. Every method chains, and the filter is
 * kept so the `aqlQuery` mock can answer the query it was actually handed.
 */
function queryChain() {
  const state: { filter?: Record<string, unknown> } = {};
  const chain = {
    state,
    filter(value: Record<string, unknown>) {
      state.filter = value;
      return chain;
    },
    select: () => chain,
    options: () => chain,
    limit: () => chain,
    offset: () => chain,
    orderBy: () => chain,
  };
  return chain;
}

vi.mock('@actual-app/api', () => ({
  getTransactions: (...args: unknown[]) => getTransactions(...args),
  aqlQuery: (...args: unknown[]) => aqlQuery(...args),
  getPayees: (...args: unknown[]) => getPayees(...args),
  getAccounts: (...args: unknown[]) => getAccounts(...args),
  q: () => queryChain(),
  // `money()` converts through the library's own helper; the real one is a
  // plain divide, so mirroring it keeps the mapped amounts meaningful here.
  utils: { integerToAmount: (cents: number) => cents / 100 },
}));

import { buildSearchFilter, createTransactionsRepo } from './transactions.ts';

describe('buildSearchFilter', () => {
  it('returns an empty filter when nothing is constrained', () => {
    expect(buildSearchFilter({ limit: 10 })).toEqual({});
  });

  it('translates a date range into inclusive bounds', () => {
    expect(buildSearchFilter({ limit: 10, dateFrom: '2026-01-01', dateTo: '2026-01-31' })).toEqual({
      $and: [{ date: { $gte: '2026-01-01' } }, { date: { $lte: '2026-01-31' } }],
    });
  });

  it('wraps text filters in SQL wildcards', () => {
    expect(buildSearchFilter({ limit: 10, notesContains: 'coffee' })).toEqual({
      $and: [{ notes: { $like: '%coffee%' } }],
    });
  });

  it('matches payee names through the joined table', () => {
    expect(buildSearchFilter({ limit: 10, payeeNameContains: 'AMZN' })).toEqual({
      $and: [{ 'payee.name': { $like: '%AMZN%' } }],
    });
  });

  it('excludes transfers from uncategorized, as Actual itself does', () => {
    // Both legs of an account transfer carry a null category legitimately.
    // Offering them as cleanup targets invites an agent to categorize them,
    // which is what Actual's own `category is null` special case prevents.
    expect(buildSearchFilter({ limit: 10, uncategorized: true })).toEqual({
      $and: [{ category: null }, { 'payee.transfer_acct': null }],
    });
  });

  it('keeps a zero amount bound rather than dropping it as falsy', () => {
    expect(buildSearchFilter({ limit: 10, amountMax: 0 })).toEqual({ $and: [{ amount: { $lte: 0 } }] });
  });

  it('keeps a false boolean bound rather than dropping it as falsy', () => {
    expect(buildSearchFilter({ limit: 10, cleared: false })).toEqual({ $and: [{ cleared: false }] });
  });

  it('combines every filter under a single $and', () => {
    const filter = buildSearchFilter({
      limit: 10,
      accountId: 'acct-1',
      payeeId: 'payee-1',
      categoryId: 'cat-1',
      amountMin: -5000,
      reconciled: true,
    });
    expect(filter).toEqual({
      $and: [
        { account: 'acct-1' },
        { payee: 'payee-1' },
        { category: 'cat-1' },
        { amount: { $gte: -5000 } },
        { reconciled: true },
      ],
    });
  });
});

describe('listForAccount', () => {
  const repo = createTransactionsRepo({
    read: (fn: () => Promise<unknown>) => fn(),
    run: (fn: () => Promise<unknown>) => fn(),
  } as Parameters<typeof createTransactionsRepo>[0]);

  it('flattens split legs, which arrive nested rather than as rows', () => {
    // `api/transactions-get` queries with `splits: 'grouped'`, so the legs live
    // in `subtransactions` — mapping only the top level loses them entirely.
    getTransactions.mockResolvedValue([
      { id: 't-1', date: '2026-07-01', amount: -1000, account: 'a-1' },
      {
        id: 't-2',
        date: '2026-07-02',
        amount: -5000,
        account: 'a-1',
        is_parent: true,
        subtransactions: [
          { id: 't-2a', date: '2026-07-02', amount: -3000, account: 'a-1', is_child: true, category: 'c-1' },
          { id: 't-2b', date: '2026-07-02', amount: -2000, account: 'a-1', is_child: true, category: 'c-2' },
        ],
      },
    ]);
    return repo.listForAccount('a-1', '2026-07-01', '2026-07-31').then((rows) => {
      expect(rows.map((row) => row.id)).toEqual(['t-1', 't-2', 't-2a', 't-2b']);
      expect(rows.find((row) => row.id === 't-2')?.isParent).toBe(true);
      expect(rows.find((row) => row.id === 't-2a')?.categoryId).toBe('c-1');
    });
  });

  it('handles a plain account with no splits', async () => {
    getTransactions.mockResolvedValue([{ id: 't-9', date: '2026-07-01', amount: -100, account: 'a-1' }]);
    expect((await repo.listForAccount('a-1', '2026-07-01', '2026-07-31')).map((row) => row.id)).toEqual(['t-9']);
  });
});

describe('transfers', () => {
  type Row = Record<string, unknown> & { id: string };
  /** The budget the mocked AQL answers from; `send` writes back into it. */
  let rows: Row[];
  const send = vi.fn();
  const repo = createTransactionsRepo({
    read: (fn: () => Promise<unknown>) => fn(),
    run: (fn: () => Promise<unknown>) => fn(),
    send,
  } as unknown as Parameters<typeof createTransactionsRepo>[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    rows = [
      { id: 't-out', date: '2026-07-01', amount: -5000, account: { id: 'a-checking' }, category: { id: 'c-1' } },
      { id: 't-in', date: '2026-07-01', amount: 5000, account: { id: 'a-savings' } },
    ];
    getPayees.mockResolvedValue([
      { id: 'p-merchant', name: 'Amazon' },
      { id: 'p-checking', name: 'Transfer: Checking', transfer_acct: 'a-checking' },
      { id: 'p-savings', name: 'Transfer: Savings', transfer_acct: 'a-savings' },
    ]);
    getAccounts.mockResolvedValue([
      { id: 'a-checking', name: 'Checking', offbudget: false },
      { id: 'a-savings', name: 'Savings', offbudget: false },
    ]);
    aqlQuery.mockImplementation(async (query: { state: { filter?: { id?: { $oneof?: string[] } } } }) => {
      const ids = query.state.filter?.id?.$oneof ?? [];
      return { data: rows.filter((row) => ids.includes(row.id)) };
    });
    // Stand in for `transactions-batch-update`: apply the patch, so what the
    // repo reads back afterwards is what it actually asked Actual to store.
    send.mockImplementation(async (_name: string, args: { updated: Row[] }) => {
      for (const patch of args.updated) {
        const row = rows.find((candidate) => candidate.id === patch.id);
        Object.assign(row as Row, patch);
      }
    });
  });

  describe('linkTransfer', () => {
    it('points each leg at the other account’s transfer payee', async () => {
      const result = await repo.linkTransfer('t-out', 't-in');
      expect(send).toHaveBeenCalledWith('transactions-batch-update', {
        updated: [
          { id: 't-out', payee: 'p-savings', transfer_id: 't-in', category: null },
          { id: 't-in', payee: 'p-checking', transfer_id: 't-out', category: null },
        ],
        // Load-bearing: with transfers on, the engine would rewrite the
        // counterpart's account and amount from this leg.
        runTransfers: false,
      });
      expect(result.transaction.transferId).toBe('t-in');
      expect(result.counterpart?.transferId).toBe('t-out');
    });

    it('keeps the category when the accounts sit on opposite sides of the budget', async () => {
      getAccounts.mockResolvedValue([
        { id: 'a-checking', name: 'Checking', offbudget: false },
        { id: 'a-savings', name: 'Brokerage', offbudget: true },
      ]);
      await repo.linkTransfer('t-out', 't-in');
      const { updated } = send.mock.calls[0]![1] as { updated: Row[] };
      expect(updated.every((patch) => !('category' in patch))).toBe(true);
    });

    it('refuses amounts that do not cancel out', async () => {
      rows[1]!.amount = 4000;
      await expect(repo.linkTransfer('t-out', 't-in')).rejects.toThrow(/amounts must cancel out/);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses two transactions in the same account', async () => {
      rows[1]!.account = { id: 'a-checking' };
      await expect(repo.linkTransfer('t-out', 't-in')).rejects.toThrow(/two different accounts/);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a transaction that is already half of a transfer', async () => {
      rows[0]!.transfer_id = 't-other';
      await expect(repo.linkTransfer('t-out', 't-in')).rejects.toThrow(/already linked to "t-other"/);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a split parent, which Actual’s own transfer engine strips', async () => {
      rows[0]!.is_parent = true;
      await expect(repo.linkTransfer('t-out', 't-in')).rejects.toThrow(/split parent cannot be a transfer leg/);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the same transaction twice', async () => {
      await expect(repo.linkTransfer('t-out', 't-out')).rejects.toThrow(/two different transactions/);
      expect(send).not.toHaveBeenCalled();
    });

    it('names the id that does not exist', async () => {
      await expect(repo.linkTransfer('t-out', 't-nope')).rejects.toThrow(/No transaction found with id "t-nope"/);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('unlinkTransfer', () => {
    beforeEach(() => {
      rows[0]!.transfer_id = 't-in';
      rows[0]!.payee = { id: 'p-savings', transfer_acct: 'a-savings' };
      rows[1]!.transfer_id = 't-out';
      rows[1]!.payee = { id: 'p-checking', transfer_acct: 'a-checking' };
    });

    it('clears the link and the transfer payee on both legs, keeping both rows', async () => {
      const result = await repo.unlinkTransfer('t-in');
      expect(send).toHaveBeenCalledWith('transactions-batch-update', {
        updated: [
          { id: 't-in', payee: null, transfer_id: null },
          { id: 't-out', payee: null, transfer_id: null },
        ],
        runTransfers: false,
      });
      // Both survive: unlinking is not a delete.
      expect(rows.map((row) => row.id)).toEqual(['t-out', 't-in']);
      expect(result.transaction.transferId).toBeUndefined();
      expect(result.counterpart?.transferId).toBeUndefined();
    });

    it('still clears this side when the counterpart is gone', async () => {
      rows = rows.filter((row) => row.id !== 't-out');
      const result = await repo.unlinkTransfer('t-in');
      expect(send).toHaveBeenCalledWith('transactions-batch-update', {
        updated: [{ id: 't-in', payee: null, transfer_id: null }],
        runTransfers: false,
      });
      expect(result.counterpart).toBeUndefined();
    });

    it('refuses a transaction that is not a transfer', async () => {
      rows[1]!.transfer_id = null;
      await expect(repo.unlinkTransfer('t-in')).rejects.toThrow(/is not linked to another transaction/);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
