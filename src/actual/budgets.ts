import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import type { BudgetCategory, BudgetMonthSummary, Category, CategoryGroup } from './types.ts';

export interface BudgetsRepo {
  listMonths(): Promise<string[]>;
  getMonth(month: string): Promise<BudgetMonthSummary>;
  setAmount(month: string, categoryId: string, amount: number): Promise<BudgetCategory | null>;
  setCarryover(month: string, categoryId: string, flag: boolean): Promise<BudgetCategory | null>;
  holdForNextMonth(month: string, amount: number): Promise<BudgetHoldResult>;
  resetHold(month: string): Promise<{ forNextMonth: number }>;
  listCategories(options?: { includeHidden?: boolean }): Promise<Category[]>;
  createCategory(input: CategoryInput): Promise<Category | null>;
  updateCategory(id: string, fields: Partial<CategoryInput>): Promise<Category | null>;
  listCategoryGroups(options?: { includeHidden?: boolean }): Promise<CategoryGroup[]>;
  createCategoryGroup(input: CategoryGroupInput): Promise<CategoryGroup | null>;
  updateCategoryGroup(id: string, fields: Partial<CategoryGroupInput>): Promise<CategoryGroup | null>;
}

/** What a hold actually did, as opposed to what was asked for. */
export interface BudgetHoldResult {
  /** Actual's own return: true when there was surplus to hold from at all. */
  held: boolean;
  /** How much the buffer actually grew — less than requested when clamped. */
  heldAmount: number;
  /** The resulting total held for next month. */
  forNextMonth: number;
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
export interface RawBudgetCategory {
  id?: unknown;
  name?: unknown;
  budgeted?: unknown;
  spent?: unknown;
  balance?: unknown;
  carryover?: unknown;
  /**
   * Income categories report `received` instead of `spent`, and on the default
   * envelope budget they carry *only* `received` — no budgeted, balance, or
   * carryover at all. Reading `spent` off one yields 0, which is why income
   * lines used to come back looking empty.
   */
  received?: unknown;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function toBudgetCategory(raw: RawBudgetCategory, groupName?: string, isIncome = false): BudgetCategory | null {
  const id = str(raw.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: str(raw.name) ?? '(unnamed)',
    groupName,
    isIncome,
    budgeted: num(raw.budgeted),
    spent: num(raw.spent),
    balance: num(raw.balance),
    carryover: Boolean(raw.carryover),
    // Present only for income categories, where Actual reports money coming in
    // as `received` and leaves `spent` undefined.
    ...(isIncome ? { received: num(raw.received) } : {}),
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
      const isIncome = Boolean((group as { is_income?: unknown }).is_income);
      for (const category of group.categories ?? []) {
        const mapped = toBudgetCategory(category as RawBudgetCategory, groupName, isIncome);
        if (mapped?.id === categoryId) {
          return mapped;
        }
      }
    }
    return null;
  };

  return {
    listMonths: () => client.read(() => api.getBudgetMonths()),

    getMonth: (month) =>
      client.read(async () => {
        const summary = await api.getBudgetMonth(month);
        const categories: BudgetCategory[] = [];
        for (const group of summary.categoryGroups) {
          const groupName = str(group.name);
          const isIncome = Boolean((group as { is_income?: unknown }).is_income);
          for (const category of group.categories ?? []) {
            const mapped = toBudgetCategory(category as RawBudgetCategory, groupName, isIncome);
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
      client.read(async () => {
        // `api/budget-set-amount` validates nothing: it inserts a budget row for
        // any month string and any category. An unknown month leaves a junk row
        // behind and then fails on read-back, and an income category has no
        // budget cell at all on an envelope budget, so the write lands nowhere
        // while the tool reports `budgeted: 0` — indistinguishable from success.
        const category = (await readCategories(true)).find((candidate) => candidate.id === categoryId);
        if (!category) {
          throw new Error(`No category with id "${categoryId}"`);
        }
        if (category.isIncome) {
          throw new Error(
            `"${category.name}" is an income category, which cannot be budgeted — Actual would accept the write ` +
              'and discard it. Income is tracked as `received`, not budgeted.',
          );
        }
        if (!(await api.getBudgetMonths()).includes(month)) {
          throw new Error(`No budget exists for month ${month}. Use list_budget_months to see the valid range.`);
        }
        await api.setBudgetAmount(month, categoryId, amount);
        return readBudgetCategory(month, categoryId);
      }),

    /**
     * Set a category's rollover flag. Actual's `setCategoryCarryover` applies
     * the flag to `getAllMonths(startMonth)` — every month from this one to the
     * end of the budget range (today + 12) — not just the month given. The
     * return value reports only the named month, so the wider effect is stated
     * in the tool description rather than left invisible.
     */
    setCarryover: (month, categoryId, flag) =>
      client.run(async () => {
        await api.setBudgetCarryover(month, categoryId, flag);
        return readBudgetCategory(month, categoryId);
      }),

    /**
     * Hold surplus back for next month. Actual's `holdForNextMonth` *adds* to
     * the existing buffer (`return buffered + amount`) and clamps the amount to
     * what is actually available, yet returns `true` whenever `to-budget > 0` —
     * so a clamped, partial hold is indistinguishable from the full one. Read
     * the resulting buffer back so the caller sees what really landed.
     */
    holdForNextMonth: (month, amount) =>
      client.read(async () => {
        const before = (await api.getBudgetMonth(month)).forNextMonth;
        const held = await api.holdBudgetForNextMonth(month, amount);
        const after = (await api.getBudgetMonth(month)).forNextMonth;
        return { held, heldAmount: after - before, forNextMonth: after };
      }),

    resetHold: (month) =>
      client.read(async () => {
        await api.resetBudgetHold(month);
        return { forNextMonth: (await api.getBudgetMonth(month)).forNextMonth };
      }),

    listCategories: (options) => client.read(() => readCategories(options?.includeHidden ?? false)),

    createCategory: (input) =>
      client.read(async () => {
        // `categories.cat_group` has no foreign key and `createCategory` checks
        // only that a group id is non-empty, so a wrong one creates a category
        // that no read path can reach: every listing derives its categories
        // from the groups. Validate before writing.
        const groups = await readCategoryGroups(true);
        const group = groups.find((candidate) => candidate.id === input.groupId);
        if (!group) {
          throw new Error(`No category group with id "${input.groupId}"`);
        }
        // Actual derives income-ness from the group; a category that disagrees
        // with its group gets no budget cells and can never be budgeted.
        if (input.isIncome !== undefined && input.isIncome !== group.isIncome) {
          throw new Error(
            `Category isIncome (${input.isIncome}) does not match group "${group.name}" (isIncome ${group.isIncome}). ` +
              'Actual derives this from the group — put the category in a matching group instead.',
          );
        }
        const id = await api.createCategory({
          name: input.name,
          group_id: input.groupId,
          is_income: group.isIncome,
          hidden: input.hidden,
        } as Parameters<typeof api.createCategory>[0]);
        // Hidden categories are excluded from the default listing, so read back
        // with hidden included or a freshly-hidden category would look missing.
        return (await readCategories(true)).find((category) => category.id === id) ?? null;
      }),

    updateCategory: (id, fields) =>
      client.read(async () => {
        const current = (await readCategories(true)).find((category) => category.id === id);
        if (!current) {
          throw new Error(`No category with id "${id}"`);
        }
        if (fields.groupId !== undefined && !(await readCategoryGroups(true)).some((g) => g.id === fields.groupId)) {
          // No foreign key on `cat_group`: a bad group id would move the
          // category somewhere no listing can reach it.
          throw new Error(`No category group with id "${fields.groupId}"`);
        }
        // `updateCategory` does `category.name.trim()` unconditionally, even
        // when the patch has no name, so a hidden-only or move-only update
        // throws a TypeError from inside the library. Always resend the name —
        // the same workaround `updateCategoryGroup` needs.
        const patch: Record<string, unknown> = { name: fields.name ?? current.name };
        if (fields.groupId !== undefined) {
          patch.group_id = fields.groupId;
        }
        if (fields.hidden !== undefined) {
          patch.hidden = fields.hidden;
        }
        await api.updateCategory(id, patch);
        return (await readCategories(true)).find((category) => category.id === id) ?? null;
      }),

    listCategoryGroups: (options) => client.read(() => readCategoryGroups(options?.includeHidden ?? false)),

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
