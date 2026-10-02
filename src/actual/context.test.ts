import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAccounts = vi.fn();
const aqlQuery = vi.fn();
const runBankSync = vi.fn();

vi.mock('@actual-app/api', () => ({
  getAccounts: () => getAccounts(),
  aqlQuery: (...args: unknown[]) => aqlQuery(...args),
  runBankSync: (...args: unknown[]) => runBankSync(...args),
  q: () => ({
    filter: () => ({ select: () => ({}) }),
  }),
  utils: { integerToAmount: (cents: number) => cents / 100 },
}));

const { createContextRepo, toSchedule } = await import('./context.ts');

const repo = createContextRepo({
  read: (fn: () => Promise<unknown>) => fn(),
  run: (fn: () => Promise<unknown>) => fn(),
} as Parameters<typeof createContextRepo>[0]);

describe('toSchedule', () => {
  it('reads the external field names, not the internal underscored ones', () => {
    // `scheduleModel.toExternal` renames _payee/_account/_amount on the way
    // out; reading the underscored names yields undefined for all of them.
    const mapped = toSchedule({
      id: 's-1',
      name: 'Rent',
      account: 'a-1',
      payee: 'p-1',
      amount: -150000,
      next_date: '2026-08-01',
      posts_transaction: true,
    } as Parameters<typeof toSchedule>[0]);
    expect(mapped).toMatchObject({
      accountId: 'a-1',
      payeeId: 'p-1',
      amount: -150000,
      amountDecimal: -1500,
      nextDate: '2026-08-01',
    });
  });

  it('reports an amount range instead of dropping it', () => {
    const mapped = toSchedule({
      id: 's-2',
      amountOp: 'isbetween',
      amount: { num1: -6000, num2: -4000 },
    } as unknown as Parameters<typeof toSchedule>[0]);
    expect(mapped).toMatchObject({ amountOp: 'isbetween', amountMin: -6000, amountMax: -4000 });
    expect(mapped.amount).toBeUndefined();
  });
});

describe('resolveNameToId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the id on a match', async () => {
    aqlQuery.mockResolvedValue({ data: [{ id: 'p-1' }] });
    expect(await repo.resolveNameToId('payees', 'Costco')).toBe('p-1');
  });

  it('returns null for a genuine miss — an empty result, not a thrown error', async () => {
    aqlQuery.mockResolvedValue({ data: [] });
    expect(await repo.resolveNameToId('payees', 'Costco')).toBeNull();
  });

  it('propagates a real failure instead of reporting it as "does not exist"', async () => {
    // A closed budget or query error must not look like a missing payee, on
    // which an agent would go and create a duplicate. The old code keyed this
    // on matching the library's "Not found:" message; this keys on an empty
    // result set, so any thrown error propagates unchanged.
    aqlQuery.mockRejectedValue(new Error('File is not open'));
    await expect(repo.resolveNameToId('payees', 'Costco')).rejects.toThrow(/File is not open/);
  });
});

describe('runBankSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aqlQuery.mockResolvedValue({
      data: [
        { id: 'a-1', name: 'Checking', account_id: 'bank-1' },
        { id: 'a-2', name: 'Cash', account_id: null },
      ],
    });
  });

  it('syncs a linked account and reports which', async () => {
    expect(await repo.runBankSync('a-1')).toEqual({ syncedAccounts: ['Checking'] });
    expect(runBankSync).toHaveBeenCalledWith({ accountId: 'a-1' });
  });

  it('refuses an unlinked account rather than reporting a hollow success', async () => {
    await expect(repo.runBankSync('a-2')).rejects.toThrow(/cannot bank-sync/);
    expect(runBankSync).not.toHaveBeenCalled();
  });

  it('refuses an unknown account', async () => {
    await expect(repo.runBankSync('a-nope')).rejects.toThrow(/cannot bank-sync/);
    expect(runBankSync).not.toHaveBeenCalled();
  });

  it('refuses when nothing is linked at all', async () => {
    aqlQuery.mockResolvedValue({ data: [{ id: 'a-2', name: 'Cash', account_id: null }] });
    await expect(repo.runBankSync()).rejects.toThrow(/nothing to sync/);
  });
});
