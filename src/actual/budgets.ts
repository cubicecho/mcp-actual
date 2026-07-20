import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import type { BudgetCategory, BudgetMonthSummary, Category, CategoryGroup } from './types.ts';

export interface BudgetsRepo {
  listMonths(): Promise<string[]>;
  getMonth(month: string): Promise<BudgetMonthSummary>;
  setAmount(month: string, categoryId: string, amount: number): Promise<BudgetCategory | null>;
  setCarryover(month: string, categoryId: string, flag: boolean): Promise<BudgetCategory | null>;
  holdForNextMonth(month: string, amount: number): Promise<boolean>;
  resetHold(month: string): Promise<void>;
  listCategories(options?: { includeHidden?: boolean }): Promise<Category[]>;
  createCategory(input: CategoryInput): Promise<Category | null>;
  updateCategory(id: string, fields: Partial<CategoryInput>): Promise<Category | null>;
  listCategoryGroups(options?: { includeHidden?: boolean }): Promise<CategoryGroup[]>;
  createCategoryGroup(input: CategoryGroupInput): Promise<CategoryGroup | null>;
  updateCategoryGroup(id: string, fields: Partial<CategoryGroupInput>): Promise<CategoryGroup | null>;
}

export interface CategoryInput {
  name: string;
  groupId: string;
  isIncome?: boolean;
  hidden?: boolean;
}

/**
 * `is_income` is deliberately absent: Actual's `api/category-group-create`
 * forwards only `name` and `hidden`, so an income flag passed here would be
 * silently dropped. Every budget already has the one income group it needs.
 */
export interface CategoryGroupInput {
  name: string;
  hidden?: boolean;
}

/**
 * `getBudgetMonth` types its category groups as loose records, so the fields we
 * read are narrowed here rather than trusted wholesale.
 */
interface RawBudgetCategory {
  id?: unknown;
  name?: unknown;
  budgeted?: unknown;
  spent?: unknown;
  balance?: unknown;
  carryover?: unknown;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toBudgetCategory(raw: RawBudgetCategory, groupName?: string): BudgetCategory | null {
  const id = str(raw.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: str(raw.name) ?? '(unnamed)',
    groupName,
    budgeted: num(raw.budgeted),
    spent: num(raw.spent),
    balance: num(raw.balance),
    carryover: Boolean(raw.carryover),
  };
}

/** A category group entry as `getCategories` returns it — groups and categories share the list. */
type RawCategory = Awaited<ReturnType<typeof api.getCategories>>[number] & {
  group?: unknown;
  group_id?: unknown;
  is_income?: unknown;
  hidden?: unknown;
};

/** A group as `getCategoryGroups` returns it — only the fields the mappings read. */
interface RawCategoryGroup {
  id: string;
  name: string;
  is_income?: boolean;
  hidden?: boolean;
  categories?: unknown[];
}

/** Shape the group list, applying the same local hidden rule as {@link mapCategories}. */
export function mapCategoryGroups(groups: RawCategoryGroup[], includeHidden: boolean): CategoryGroup[] {
  return groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      isIncome: Boolean(group.is_income),
      hidden: Boolean(group.hidden),
      categoryCount: group.categories?.length ?? 0,
    }))
    .filter((group) => includeHidden || !group.hidden);
}

/**
 * Join the flat category list to its groups and apply the hidden rule. A
 * category counts as hidden when its own flag is set *or* its group is hidden —
 * that is what the Actual UI shows.
 */
export function mapCategories(groups: RawCategoryGroup[], raw: RawCategory[], includeHidden: boolean): Category[] {
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const hiddenGroups = new Set(groups.filter((group) => group.hidden).map((group) => group.id));
  return raw
    .map((category) => {
      const groupId = str(category.group_id) ?? str(category.group);
      return {
        id: category.id,
        name: category.name,
        groupId,
        groupName: groupId ? groupNames.get(groupId) : undefined,
        isIncome: Boolean(category.is_income),
        hidden: Boolean(category.hidden) || (groupId !== undefined && hiddenGroups.has(groupId)),
      };
    })
    .filter((category) => includeHidden || !category.hidden);
}

export function createBudgetsRepo(client: ActualClient): BudgetsRepo {
  /**
   * Read the *unfiltered* lists and hide locally. Actual's `hidden` option is a
   * filter, not an include-flag: `hidden: true` returns only hidden entries (so
   * a budget with nothing hidden comes back empty) and `hidden: false` drops
   * every category living in a hidden group.
   */
  const readCategories = async (includeHidden: boolean): Promise<Category[]> =>
    mapCategories(
      (await api.getCategoryGroups()) as RawCategoryGroup[],
      (await api.getCategories()) as RawCategory[],
      includeHidden,
    );

  const readCategoryGroups = async (includeHidden: boolean): Promise<CategoryGroup[]> =>
    mapCategoryGroups((await api.getCategoryGroups()) as RawCategoryGroup[], includeHidden);

  /** Read one category's post-change budget state, so a write reports what actually landed. */
  const readBudgetCategory = async (month: string, categoryId: string): Promise<BudgetCategory | null> => {
    const summary = await api.getBudgetMonth(month);
    for (const group of summary.categoryGroups) {
      const groupName = str(group.name);
      for (const category of group.categories ?? []) {
        const mapped = toBudgetCategory(category as RawBudgetCategory, groupName);
        if (mapped?.id === categoryId) {
          return mapped;
        }
      }
    }
    return null;
  };

  return {
    listMonths: () => client.run(() => api.getBudgetMonths()),

    getMonth: (month) =>
      client.run(async () => {
        const summary = await api.getBudgetMonth(month);
        const categories: BudgetCategory[] = [];
        for (const group of summary.categoryGroups) {
          const groupName = str(group.name);
          for (const category of group.categories ?? []) {
            const mapped = toBudgetCategory(category as RawBudgetCategory, groupName);
            if (mapped) {
              categories.push(mapped);
            }
          }
        }
        return {
          month: summary.month,
          toBudget: summary.toBudget,
          totalBudgeted: summary.totalBudgeted,
          totalIncome: summary.totalIncome,
          totalSpent: summary.totalSpent,
          totalBalance: summary.totalBalance,
          fromLastMonth: summary.fromLastMonth,
          forNextMonth: summary.forNextMonth,
          categories,
        };
      }),

    setAmount: (month, categoryId, amount) =>
      client.run(async () => {
        await api.setBudgetAmount(month, categoryId, amount);
        return readBudgetCategory(month, categoryId);
      }),

    setCarryover: (month, categoryId, flag) =>
      client.run(async () => {
        await api.setBudgetCarryover(month, categoryId, flag);
        return readBudgetCategory(month, categoryId);
      }),

    holdForNextMonth: (month, amount) => client.run(() => api.holdBudgetForNextMonth(month, amount)),

    resetHold: (month) => client.run(() => api.resetBudgetHold(month)),

    listCategories: (options) => client.run(() => readCategories(options?.includeHidden ?? false)),

    createCategory: (input) =>
      client.run(async () => {
        const id = await api.createCategory({
          name: input.name,
          group_id: input.groupId,
          is_income: input.isIncome,
          hidden: input.hidden,
        } as Parameters<typeof api.createCategory>[0]);
        // Hidden categories are excluded from the default listing, so read back
        // with hidden included or a freshly-hidden category would look missing.
        return (await readCategories(true)).find((category) => category.id === id) ?? null;
      }),

    updateCategory: (id, fields) =>
      client.run(async () => {
        const patch: Record<string, unknown> = {};
        if (fields.name !== undefined) {
          patch.name = fields.name;
        }
        if (fields.groupId !== undefined) {
          patch.group_id = fields.groupId;
        }
        if (fields.hidden !== undefined) {
          patch.hidden = fields.hidden;
        }
        await api.updateCategory(id, patch);
        return (await readCategories(true)).find((category) => category.id === id) ?? null;
      }),

    listCategoryGroups: (options) => client.run(() => readCategoryGroups(options?.includeHidden ?? false)),

    createCategoryGroup: (input) =>
      client.run(async () => {
        const id = await api.createCategoryGroup({
          name: input.name,
          hidden: input.hidden,
        } as Parameters<typeof api.createCategoryGroup>[0]);
        // Read back with hidden included, or a group created hidden looks missing.
        return (await readCategoryGroups(true)).find((group) => group.id === id) ?? null;
      }),

    updateCategoryGroup: (id, fields) =>
      client.run(async () => {
        const current = (await readCategoryGroups(true)).find((group) => group.id === id);
        if (!current) {
          throw new Error(`No category group with id "${id}"`);
        }
        // Actual's duplicate-name check reads `group.name.toUpperCase()`
        // unconditionally, so a patch without a name throws a TypeError from
        // deep inside the library. Always resend the current name.
        const patch: Record<string, unknown> = { name: fields.name ?? current.name };
        if (fields.hidden !== undefined) {
          patch.hidden = fields.hidden;
        }
        await api.updateCategoryGroup(id, patch);
        return (await readCategoryGroups(true)).find((group) => group.id === id) ?? null;
      }),
  };
}
