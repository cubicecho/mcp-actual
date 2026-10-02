import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTransactions = vi.fn();
const updateTransaction = vi.fn();
const aqlQuery = vi.fn();

vi.mock('@actual-app/api', () => ({
  getTransactions: (...args: unknown[]) => getTransactions(...args),
  updateTransaction: (...args: unknown[]) => updateTransaction(...args),
  aqlQuery: (...args: unknown[]) => aqlQuery(...args),
  q: () => {
    const chain = {
      filter: () => chain,
      select: () => chain,
      orderBy: () => chain,
      options: () => chain,
      limit: () => chain,
      offset: () => chain,
    };
    return chain;
  },
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

  it('flattens split legs, which arrive nested rather than as rows', async () => {
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
    const rows = await repo.listForAccount('a-1', '2026-07-01', '2026-07-31');
    expect(rows.map((row) => row.id)).toEqual(['t-1', 't-2', 't-2a', 't-2b']);
    expect(rows.find((row) => row.id === 't-2')?.isParent).toBe(true);
    expect(rows.find((row) => row.id === 't-2a')?.categoryId).toBe('c-1');
  });

  it('handles a plain account with no splits', async () => {
    getTransactions.mockResolvedValue([{ id: 't-9', date: '2026-07-01', amount: -100, account: 'a-1' }]);
    expect((await repo.listForAccount('a-1', '2026-07-01', '2026-07-31')).map((row) => row.id)).toEqual(['t-9']);
  });
});

describe('update', () => {
  const repo = createTransactionsRepo({
    read: (fn: () => Promise<unknown>) => fn(),
    run: (fn: () => Promise<unknown>) => fn(),
  } as Parameters<typeof createTransactionsRepo>[0]);

  beforeEach(() => vi.clearAllMocks());

  it('waits for a category change to land before returning, despite the stale-read race', async () => {
    // api/transaction-update does not await its write, so the first read-back
    // can still show the OLD category. `category` comes back as a { id, name }
    // object, so the poll must compare by id — comparing object identity would
    // see a "change" immediately and return the stale row.
    const stale = { id: 't-1', date: '2026-07-01', amount: -100, category: { id: 'c-old', name: 'Old' } };
    const fresh = { id: 't-1', date: '2026-07-01', amount: -100, category: { id: 'c-new', name: 'New' } };
    // before, then post-update: stale, stale, then fresh — the poll must keep going.
    aqlQuery
      .mockResolvedValueOnce({ data: [stale] }) // before
      .mockResolvedValueOnce({ data: [stale] }) // first read-back (write not landed)
      .mockResolvedValueOnce({ data: [stale] }) // still not landed
      .mockResolvedValue({ data: [fresh] }); // landed
    const result = await repo.update('t-1', { categoryId: 'c-new' });
    expect(result?.categoryId).toBe('c-new');
    expect(updateTransaction).toHaveBeenCalledWith('t-1', { category: 'c-new' });
  });

  it('returns null for an id that does not exist', async () => {
    aqlQuery.mockResolvedValue({ data: [] });
    expect(await repo.update('nope', { notes: 'x' })).toBeNull();
    expect(updateTransaction).not.toHaveBeenCalled();
  });
});
