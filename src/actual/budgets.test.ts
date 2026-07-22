import { describe, expect, it, vi } from 'vitest';
import { createBudgetsRepo, mapCategories, mapCategoryGroups, toBudgetCategory } from './budgets.ts';

const updateCategoryGroup = vi.fn(async () => undefined);
const updateCategory = vi.fn(async () => undefined);
const getCategories = vi.fn(async () => [
  { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: false, is_income: false },
]);
const getCategoryGroups = vi.fn(async () => [{ id: 'g-2', name: 'Retired', is_income: false, hidden: false }]);

vi.mock('@actual-app/api', () => ({
  getCategoryGroups: (...args: unknown[]) => getCategoryGroups(...(args as [])),
  updateCategoryGroup: (...args: unknown[]) => updateCategoryGroup(...(args as [])),
  updateCategory: (...args: unknown[]) => updateCategory(...(args as [])),
  getCategories: (...args: unknown[]) => getCategories(...(args as [])),
}));

const GROUPS = [
  { id: 'g-1', name: 'Everyday', hidden: false },
  { id: 'g-2', name: 'Retired', hidden: true },
];

const RAW = [
  { id: 'c-1', name: 'Groceries', group: 'g-1', hidden: false },
  { id: 'c-2', name: 'Secret', group: 'g-1', hidden: true },
  { id: 'c-3', name: 'Old Hobby', group: 'g-2', hidden: false },
] as Parameters<typeof mapCategories>[1];

describe('mapCategories', () => {
  it('returns visible categories with their group name', () => {
    expect(mapCategories(GROUPS, RAW, false)).toEqual([
      { id: 'c-1', name: 'Groceries', groupId: 'g-1', groupName: 'Everyday', isIncome: false, hidden: false },
    ]);
  });

  it('treats a category in a hidden group as hidden', () => {
    const oldHobby = mapCategories(GROUPS, RAW, true).find((category) => category.id === 'c-3');
    expect(oldHobby?.hidden).toBe(true);
  });

  it('includes hidden categories rather than returning only them', () => {
    expect(mapCategories(GROUPS, RAW, true).map((category) => category.id)).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('reads the group id from either group or group_id', () => {
    const raw = [{ id: 'c-4', name: 'Rent', group_id: 'g-1' }] as Parameters<typeof mapCategories>[1];
    expect(mapCategories(GROUPS, raw, false)[0]).toMatchObject({ groupId: 'g-1', groupName: 'Everyday' });
  });
});

describe('mapCategoryGroups', () => {
  const RAW_GROUPS = [
    { id: 'g-1', name: 'Everyday', is_income: false, hidden: false, categories: [{}, {}] },
    { id: 'g-2', name: 'Retired', is_income: false, hidden: true, categories: [{}] },
    { id: 'g-3', name: 'Fresh', is_income: false, hidden: false },
  ];

  it('excludes hidden groups by default', () => {
    expect(mapCategoryGroups(RAW_GROUPS, false).map((group) => group.id)).toEqual(['g-1', 'g-3']);
  });

  it('includes hidden groups on request', () => {
    expect(mapCategoryGroups(RAW_GROUPS, true).map((group) => group.id)).toEqual(['g-1', 'g-2', 'g-3']);
  });

  it('counts the categories in a group, reporting 0 for an empty one', () => {
    const counts = mapCategoryGroups(RAW_GROUPS, true).map((group) => group.categoryCount);
    expect(counts).toEqual([2, 1, 0]);
  });
});

describe('updateCategoryGroup', () => {
  const repo = createBudgetsRepo({ run: (fn) => fn() } as Parameters<typeof createBudgetsRepo>[0]);

  it('resends the current name on a hidden-only change', async () => {
    // Actual's duplicate-name check calls `group.name.toUpperCase()` even when
    // the patch has no name, so omitting it throws a TypeError from the library.
    await repo.updateCategoryGroup('g-2', { hidden: true });
    expect(updateCategoryGroup).toHaveBeenCalledWith('g-2', { name: 'Retired', hidden: true });
  });

  it('fails with a readable message for an unknown id', async () => {
    await expect(repo.updateCategoryGroup('nope', { hidden: true })).rejects.toThrow(
      'No category group with id "nope"',
    );
  });
});

describe('toBudgetCategory', () => {
  it('reads budgeted/spent/balance for an ordinary category', () => {
    const mapped = toBudgetCategory({ id: 'c-1', name: 'Groceries', budgeted: 40000, spent: -12500, balance: 27500 });
    expect(mapped).toMatchObject({ isIncome: false, budgeted: 40000, spent: -12500, balance: 27500 });
    expect(mapped?.received).toBeUndefined();
  });

  it('reads `received` for an income category, which has no spent at all', () => {
    // Actual emits income categories with only `received` on an envelope
    // budget; reading `spent` off one reports a real salary as 0.
    const mapped = toBudgetCategory({ id: 'c-2', name: 'Salary', received: 500000 }, 'Income', true);
    expect(mapped).toMatchObject({ isIncome: true, received: 500000 });
    expect(mapped?.spent).toBe(0);
  });

  it('drops an entry with no id rather than inventing one', () => {
    expect(toBudgetCategory({ name: 'Orphan' })).toBeNull();
  });
});

describe('updateCategory', () => {
  const repo = createBudgetsRepo({
    read: (fn: () => Promise<unknown>) => fn(),
    run: (fn: () => Promise<unknown>) => fn(),
  } as Parameters<typeof createBudgetsRepo>[0]);

  it('resends the current name on a hidden-only change', async () => {
    // `updateCategory` does `category.name.trim()` unconditionally, so a patch
    // without a name throws a TypeError from inside the library — the same trap
    // already worked around for category groups.
    await repo.updateCategory('c-1', { hidden: true });
    expect(updateCategory).toHaveBeenCalledWith('c-1', { name: 'Groceries', hidden: true });
  });

  it('refuses an unknown category rather than writing blind', async () => {
    await expect(repo.updateCategory('nope', { hidden: true })).rejects.toThrow('No category with id "nope"');
  });

  it('refuses a move into a group that does not exist', async () => {
    // `cat_group` has no foreign key, so a bad id would strand the category
    // where no listing can reach it.
    await expect(repo.updateCategory('c-1', { groupId: 'g-nope' })).rejects.toThrow(
      'No category group with id "g-nope"',
    );
  });
});
