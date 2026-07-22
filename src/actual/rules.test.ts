import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPayees = vi.fn();
const getCategories = vi.fn();
const getRules = vi.fn();
const aqlQuery = vi.fn();

vi.mock('@actual-app/api', () => ({
  getPayees: () => getPayees(),
  getCategories: () => getCategories(),
  getRules: () => getRules(),
  aqlQuery: (...args: unknown[]) => aqlQuery(...args),
  q: () => {
    const chain = {
      filter: () => chain,
      select: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
    };
    return chain;
  },
  utils: { integerToAmount: (cents: number) => cents / 100 },
}));

const { createRulesRepo, diffTransaction } = await import('./rules.ts');

/** Resolve the two id-bearing fields the way the repo does, so tests read like the real output. */
const NAMES = {
  payees: new Map([
    ['p-1', 'AMZN Mktp US*2H4'],
    ['p-2', 'Amazon'],
  ]),
  categories: new Map([['c-1', 'Shopping']]),
};
const resolve = (kind: 'payees' | 'categories', id: unknown): unknown =>
  typeof id === 'string' ? (NAMES[kind].get(id) ?? id) : id;

const BEFORE = {
  id: 't-1',
  date: '2026-07-01',
  amount: -2500,
  notes: null,
  cleared: true,
  payee: 'p-1',
  category: null,
};

describe('diffTransaction', () => {
  it('reports nothing when the rules changed nothing', () => {
    expect(diffTransaction(BEFORE, { ...BEFORE }, resolve)).toEqual({});
  });

  it('resolves payee and category ids to names, keeping the ids alongside', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, payee: 'p-2', category: 'c-1' }, resolve);
    expect(changes).toEqual({
      payee: { from: 'AMZN Mktp US*2H4', to: 'Amazon', fromId: 'p-1', toId: 'p-2' },
      category: { from: null, to: 'Shopping', fromId: null, toId: 'c-1' },
    });
  });

  it('carries toId so a preview can be turned into an apply without a name lookup', () => {
    // apply_rule_actions takes ids as action values; a name-only diff would
    // force an ambiguous resolve_name_to_id round-trip.
    const changes = diffTransaction(BEFORE, { ...BEFORE, category: 'c-1' }, resolve);
    expect(changes.category?.toId).toBe('c-1');
  });

  it('leaves an unresolvable id as the raw id rather than dropping it', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, category: 'c-unknown' }, resolve);
    expect(changes.category).toEqual({ from: null, to: 'c-unknown', fromId: null, toId: 'c-unknown' });
  });

  it('reports plain fields without name resolution', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, notes: 'groceries', cleared: false }, resolve);
    expect(changes).toEqual({
      notes: { from: null, to: 'groceries' },
      cleared: { from: true, to: false },
    });
  });

  it('treats undefined and null as the same absent value, so an omitted field is not a change', () => {
    // `rules-run` returns the transaction it was given; a field the engine never
    // touched can come back undefined where the row had null.
    const changes = diffTransaction(BEFORE, { ...BEFORE, notes: undefined, category: undefined }, resolve);
    expect(changes).toEqual({});
  });

  it('ignores fields outside the diffed set', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, reconciled: true, account: 'a-9' }, resolve);
    expect(changes).toEqual({});
  });
});

describe('previewEffects payee-creation gate', () => {
  const client = {
    read: (fn: () => Promise<unknown>) => fn(),
    run: (fn: () => Promise<unknown>) => fn(),
    // rules-run returns the transaction unchanged, so the preview yields no
    // entries — the gate is what these tests exercise, not the diff.
    send: async (_name: string, args: { transaction: unknown }) => args.transaction,
  };
  const repo = createRulesRepo(client as unknown as Parameters<typeof createRulesRepo>[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    getPayees.mockResolvedValue([{ id: 'p-2', name: 'Amazon' }]);
    getCategories.mockResolvedValue([{ id: 'c-1', name: 'Shopping' }]);
    aqlQuery.mockResolvedValue({ data: [{ id: 't-1', date: '2026-07-01', amount: -2500, payee: 'p-2' }] });
  });

  it('allows a read-only preview when the only rename rule targets an EXISTING payee', async () => {
    // Actual inserts a payee only when the target name does not already resolve,
    // so a rename to a payee that exists is safe to preview even read-only.
    getRules.mockResolvedValue([{ id: 'r-1', actions: [{ op: 'set', field: 'payee_name', value: 'Amazon' }] }]);
    const preview = await repo.previewEffects({ limit: 100 }, { allowPayeeCreation: false });
    expect(preview.createsPayees).toEqual([]);
  });

  it('refuses a read-only preview when a rename rule targets a NEW payee name', async () => {
    getRules.mockResolvedValue([{ id: 'r-2', actions: [{ op: 'set', field: 'payee_name', value: 'BrandNewCo' }] }]);
    await expect(repo.previewEffects({ limit: 100 }, { allowPayeeCreation: false })).rejects.toThrow(/Cannot preview/);
  });

  it('reports a would-create rule but proceeds when writes are allowed', async () => {
    getRules.mockResolvedValue([{ id: 'r-2', actions: [{ op: 'set', field: 'payee_name', value: 'BrandNewCo' }] }]);
    const preview = await repo.previewEffects({ limit: 100 }, { allowPayeeCreation: true });
    expect(preview.createsPayees).toEqual(['r-2']);
  });
});
