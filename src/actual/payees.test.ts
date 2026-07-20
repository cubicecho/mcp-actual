import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPayeesRepo, groupDuplicates, normalizePayeeName, tallyUsage } from './payees.ts';
import type { Payee } from './types.ts';

const getPayees = vi.fn();
const mergePayees = vi.fn();
const updatePayee = vi.fn();
const createPayee = vi.fn();

vi.mock('@actual-app/api', () => ({
  getPayees: () => getPayees(),
  mergePayees: (...args: unknown[]) => mergePayees(...args),
  updatePayee: (...args: unknown[]) => updatePayee(...args),
  createPayee: (...args: unknown[]) => createPayee(...args),
}));

function payee(id: string, name: string, transactionCount = 0, transferAccountId?: string): Payee {
  return { id, name, transactionCount, ...(transferAccountId ? { transferAccountId } : {}) };
}

describe('normalizePayeeName', () => {
  it('collapses case, punctuation, and spacing', () => {
    expect(normalizePayeeName('Trader Joe’s #123')).toBe(normalizePayeeName('trader joes'));
  });

  it('strips the reference numbers card networks append', () => {
    expect(normalizePayeeName('AMZN Mktp US*2H4G1')).toBe(normalizePayeeName('AMZN Mktp US'));
  });

  it('keeps genuinely different merchants apart', () => {
    expect(normalizePayeeName('Shell')).not.toBe(normalizePayeeName('Chevron'));
  });
});

describe('groupDuplicates', () => {
  it('groups payees that normalize to the same key', () => {
    const groups = groupDuplicates([payee('1', 'Trader Joes', 12), payee('2', "Trader Joe's", 3)], 2);
    expect(groups).toHaveLength(1);
    // Most-used wins: merging moves the others onto the target.
    expect(groups[0]!.suggestedTarget.id).toBe('1');
    expect(groups[0]!.candidates.map((c) => c.id)).toEqual(['2']);
  });

  it('never groups transfer payees — merging them would corrupt transfers', () => {
    const groups = groupDuplicates([payee('1', 'Savings', 5, 'acct-1'), payee('2', 'Savings', 2, 'acct-2')], 2);
    expect(groups).toEqual([]);
  });

  it('ignores singleton payees', () => {
    expect(groupDuplicates([payee('1', 'Costco', 4), payee('2', 'Safeway', 9)], 2)).toEqual([]);
  });

  it('honors a larger minimum group size', () => {
    const payees = [payee('1', 'Shell', 4), payee('2', 'shell', 2)];
    expect(groupDuplicates(payees, 3)).toEqual([]);
    expect(groupDuplicates(payees, 2)).toHaveLength(1);
  });

  it('orders the biggest clusters first', () => {
    const groups = groupDuplicates(
      [
        payee('1', 'Shell', 4),
        payee('2', 'shell', 2),
        payee('3', 'Costco', 9),
        payee('4', 'costco', 3),
        payee('5', 'COSTCO', 1),
      ],
      2,
    );
    expect(groups[0]!.suggestedTarget.name).toBe('Costco');
    expect(groups[0]!.candidates).toHaveLength(2);
  });
});

describe('tallyUsage', () => {
  it('counts transactions and keeps the newest date per payee', () => {
    // Rows arrive newest-first, which is what makes the first one the last-used date.
    const usage = tallyUsage([
      { payee: 'p1', date: '2026-07-01' },
      { payee: 'p2', date: '2026-06-15' },
      { payee: 'p1', date: '2026-05-02' },
    ]);
    expect(usage.get('p1')).toEqual({ count: 2, lastDate: '2026-07-01' });
    expect(usage.get('p2')).toEqual({ count: 1, lastDate: '2026-06-15' });
  });

  it('skips rows with no payee', () => {
    expect(tallyUsage([{ payee: null, date: '2026-07-01' }]).size).toBe(0);
  });
});

describe('merge guards', () => {
  const PAYEES = [
    { id: 'p-1', name: 'Amazon' },
    { id: 'p-2', name: 'AMZN Mktp US*2H4' },
    { id: 'p-3', name: 'Transfer: Savings', transfer_acct: 'a-9' },
  ];
  const repo = createPayeesRepo({
    read: (fn: () => Promise<unknown>) => fn(),
    run: (fn: () => Promise<unknown>) => fn(),
  } as Parameters<typeof createPayeesRepo>[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    getPayees.mockResolvedValue(PAYEES);
    mergePayees.mockResolvedValue(undefined);
  });

  it('merges ordinary payees', async () => {
    await repo.merge('p-1', ['p-2']);
    expect(mergePayees).toHaveBeenCalledWith('p-1', ['p-2']);
  });

  it('refuses to merge a transfer payee, which would corrupt its transfers', async () => {
    await expect(repo.merge('p-1', ['p-3'])).rejects.toThrow(/Refusing to merge transfer payee "Transfer: Savings"/);
    expect(mergePayees).not.toHaveBeenCalled();
  });

  it('refuses when the merge target itself is a transfer payee', async () => {
    await expect(repo.merge('p-3', ['p-1'])).rejects.toThrow(/Refusing to merge transfer payee/);
    expect(mergePayees).not.toHaveBeenCalled();
  });

  it('refuses an id that does not exist rather than silently merging the rest', async () => {
    await expect(repo.merge('p-1', ['p-nope'])).rejects.toThrow(/No payee with id "p-nope"/);
    expect(mergePayees).not.toHaveBeenCalled();
  });
});

describe('write guards', () => {
  const repo = createPayeesRepo({
    read: (fn: () => Promise<unknown>) => fn(),
    run: (fn: () => Promise<unknown>) => fn(),
  } as Parameters<typeof createPayeesRepo>[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    getPayees.mockResolvedValue([{ id: 'p-1', name: 'Amazon' }]);
  });

  it('renames an existing payee', async () => {
    await repo.update('p-1', { name: 'Amazon.com' });
    expect(updatePayee).toHaveBeenCalledWith('p-1', { name: 'Amazon.com' });
  });

  it('refuses to rename an unknown id, which would CREATE a broken payee', async () => {
    // Actual's db.update is CRDT message-based and INSERTs when the row is
    // absent — without the payee_mapping row a real payee gets, so the orphan
    // can never be associated with a transaction.
    await expect(repo.update('p-nope', { name: 'Amazon.com' })).rejects.toThrow('No payee with id "p-nope"');
    expect(updatePayee).not.toHaveBeenCalled();
  });

  it('refuses to create a payee whose name already exists', async () => {
    await expect(repo.create('Amazon')).rejects.toThrow(/already exists/);
    expect(createPayee).not.toHaveBeenCalled();
  });
});
