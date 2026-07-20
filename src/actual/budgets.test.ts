import { describe, expect, it } from 'vitest';
import { mapCategories } from './budgets.ts';

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
