import { describe, expect, it } from 'vitest';
import { buildSearchFilter } from './transactions.ts';

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
