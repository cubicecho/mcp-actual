import { z } from 'zod';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { idSchema } from './ids.ts';

/** Budget months are `YYYY-MM` — a day component is not accepted. */
const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Months must be YYYY-MM')
  .describe('Budget month in YYYY-MM format.');

const centsSchema = z.number().int('Amounts are integer cents — 12.34 dollars is 1234.');

export function budgetTools(repos: Pick<ActualRepos, 'budgets'>): ToolDefinition[] {
  return [
    defineTool({
      name: 'list_budget_months',
      title: 'List budget months',
      description:
        'List every month the budget file covers, oldest first, as YYYY-MM. Use it to find the current or ' +
        'most recent month before reading or setting budget amounts.',
      inputSchema: {},
      run: async () => {
        const months = await repos.budgets.listMonths();
        return { months, count: months.length };
      },
    }),

    defineTool({
      name: 'get_budget_month',
      title: 'Get a month’s budget',
      description:
        'Read one month’s budget: totals (income, budgeted, spent, balance, and `toBudget` — what is still ' +
        'unassigned) plus every category with its budgeted, spent, and balance amounts and its carryover flag. ' +
        'All amounts are integer cents; spending is negative. This is the tool for "am I over budget?".\n' +
        'Income categories (`isIncome: true`) are different: Actual tracks money coming in as `received`, and ' +
        'leaves their budgeted/spent/balance at 0 on a standard envelope budget. Read `received` for those, and ' +
        'never report an income category as "0 spent" — the figure simply lives elsewhere.',
      inputSchema: {
        month: monthSchema.describe('The month to read, as YYYY-MM.'),
      },
      run: async (args) => {
        const { month } = z.object({ month: monthSchema }).parse(args);
        return repos.budgets.getMonth(month);
      },
    }),

    defineTool({
      name: 'set_budget_amount',
      title: 'Set a category’s budget',
      description:
        'Set the amount budgeted to one category for one month, in integer cents. This replaces the existing ' +
        'amount rather than adding to it. Returns the category’s resulting budgeted/spent/balance figures so ' +
        'the effect is visible immediately.',
      inputSchema: {
        month: monthSchema.describe('Month to budget in, as YYYY-MM.'),
        categoryId: idSchema.describe('Category id, from list_categories.'),
        amount: centsSchema.describe('Amount to budget, in cents. Replaces the current amount.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { month, categoryId, amount } = z
          .object({ month: monthSchema, categoryId: idSchema, amount: centsSchema })
          .parse(args);
        return { category: await repos.budgets.setAmount(month, categoryId, amount) };
      },
    }),

    defineTool({
      name: 'set_budget_carryover',
      title: 'Set a category’s carryover',
      description:
        'Turn rollover on or off for a category. With carryover on, an unspent balance rolls into the next ' +
        'month instead of returning to "to budget"; an overspend carries forward as a negative.\n' +
        'IMPORTANT: this is not scoped to the one month. Actual applies the flag from the given month FORWARD ' +
        'to the end of the budget range, overwriting it on every later month — including ones set deliberately. ' +
        'The result reports only the month you named, so say what you changed rather than implying it was one ' +
        'month.',
      inputSchema: {
        month: monthSchema.describe('Month to change, as YYYY-MM.'),
        categoryId: idSchema.describe('Category id, from list_categories.'),
        carryover: z.boolean().describe('True to roll the balance forward, false to stop rolling it forward.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { month, categoryId, carryover } = z
          .object({ month: monthSchema, categoryId: idSchema, carryover: z.boolean() })
          .parse(args);
        return { category: await repos.budgets.setCarryover(month, categoryId, carryover) };
      },
    }),

    defineTool({
      name: 'hold_for_next_month',
      title: 'Hold funds for next month',
      description:
        'Hold some of this month’s leftover "to budget" money back for next month, in integer cents.\n' +
        'This ADDS to whatever is already held for that month — it does not replace it, so calling twice with ' +
        '1000 leaves 2000 held. To correct a hold, call `reset_budget_hold` first.\n' +
        'The amount is clamped to what is actually available, so the hold can be smaller than you asked for. ' +
        'Read `heldAmount` (how much the buffer really grew) and `forNextMonth` (the resulting total) rather ' +
        'than assuming the request landed in full; `held: false` means there was no surplus to hold at all.',
      inputSchema: {
        month: monthSchema.describe('Month whose surplus to hold, as YYYY-MM.'),
        amount: centsSchema.positive().describe('Amount to hold back, in cents.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { month, amount } = z.object({ month: monthSchema, amount: centsSchema.positive() }).parse(args);
        return repos.budgets.holdForNextMonth(month, amount);
      },
    }),

    defineTool({
      name: 'reset_budget_hold',
      title: 'Release a held amount',
      description:
        'Release everything held back for next month, returning it to this month’s "to budget". Safe to call ' +
        'when nothing is held. Returns the resulting `forNextMonth`, which should be 0.',
      inputSchema: {
        month: monthSchema.describe('Month whose hold to release, as YYYY-MM.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { month } = z.object({ month: monthSchema }).parse(args);
        return { month, ...(await repos.budgets.resetHold(month)) };
      },
    }),

    defineTool({
      name: 'list_category_groups',
      title: 'List category groups',
      description:
        'List the groups categories are filed under, with their ids and how many categories each holds. Use ' +
        'this to find the `groupId` for `create_category` — `list_categories` only names groups that already ' +
        'have a visible category, so a new or empty group (`categoryCount: 0`) is only discoverable here.',
      inputSchema: {
        includeHidden: z.boolean().optional().describe('Include hidden groups. Defaults to false.'),
      },
      run: async (args) => {
        const { includeHidden } = z.object({ includeHidden: z.boolean().optional() }).parse(args);
        return { groups: await repos.budgets.listCategoryGroups({ includeHidden }) };
      },
    }),

    defineTool({
      name: 'create_category_group',
      title: 'Create a category group',
      description:
        'Create an empty category group to file categories under, then fill it with `create_category`. Groups ' +
        'are spending groups: Actual’s API cannot create an income group, and every budget already has the ' +
        'one it needs.',
      inputSchema: {
        name: z.string().min(1).describe('Name for the new group.'),
        hidden: z.boolean().optional().describe('Create it hidden. Defaults to false.'),
      },
      write: true,
      run: async (args) => {
        const input = z.object({ name: z.string().min(1), hidden: z.boolean().optional() }).parse(args);
        return { group: await repos.budgets.createCategoryGroup(input) };
      },
    }),

    defineTool({
      name: 'update_category_group',
      title: 'Update a category group',
      description:
        'Rename a category group or hide/unhide it. Only the fields you pass are changed. Hiding a group hides ' +
        'every category in it, so `list_categories` will report those categories as hidden — unhide the group ' +
        'here rather than trying to unhide them one by one.',
      inputSchema: {
        id: idSchema.describe('Id of the group to change, from list_category_groups.'),
        name: z.string().min(1).optional().describe('New name.'),
        hidden: z.boolean().optional().describe('Hide or unhide the group and everything in it.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { id, ...fields } = z
          .object({
            id: idSchema,
            name: z.string().min(1).optional(),
            hidden: z.boolean().optional(),
          })
          .parse(args);
        return { group: await repos.budgets.updateCategoryGroup(id, fields) };
      },
    }),

    defineTool({
      name: 'create_category',
      title: 'Create a category',
      description:
        'Create a budget category inside an existing category group. Get the group id from ' +
        '`list_category_groups`, or create the group first with `create_category_group`. Income categories ' +
        'behave differently from spending ones — set `isIncome` only for money coming in.',
      inputSchema: {
        name: z.string().min(1).describe('Name for the new category.'),
        groupId: idSchema.describe('Id of the category group to create it in.'),
        isIncome: z.boolean().optional().describe('True for an income category. Defaults to false.'),
        hidden: z.boolean().optional().describe('Create it hidden. Defaults to false.'),
      },
      write: true,
      run: async (args) => {
        const input = z
          .object({
            name: z.string().min(1),
            groupId: idSchema,
            isIncome: z.boolean().optional(),
            hidden: z.boolean().optional(),
          })
          .parse(args);
        return { category: await repos.budgets.createCategory(input) };
      },
    }),

    defineTool({
      name: 'update_category',
      title: 'Update a category',
      description:
        'Rename a category, move it to another group, or hide/unhide it. Only the fields you pass are changed. ' +
        'Hiding keeps history intact and is the safe alternative to deleting a category you no longer use.',
      inputSchema: {
        id: idSchema.describe('Id of the category to change.'),
        name: z.string().min(1).optional().describe('New name.'),
        groupId: idSchema.optional().describe('Move the category into this group.'),
        hidden: z.boolean().optional().describe('Hide or unhide the category.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { id, ...fields } = z
          .object({
            id: idSchema,
            name: z.string().min(1).optional(),
            groupId: idSchema.optional(),
            hidden: z.boolean().optional(),
          })
          .parse(args);
        return { category: await repos.budgets.updateCategory(id, fields) };
      },
    }),
  ] as ToolDefinition[];
}
