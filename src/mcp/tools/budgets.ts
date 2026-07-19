import { z } from 'zod';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

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
        'All amounts are integer cents; spending is negative. This is the tool for "am I over budget?".',
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
        categoryId: z.string().min(1).describe('Category id, from list_categories.'),
        amount: centsSchema.describe('Amount to budget, in cents. Replaces the current amount.'),
      },
      write: true,
      idempotent: true,
      run: async (args) => {
        const { month, categoryId, amount } = z
          .object({ month: monthSchema, categoryId: z.string().min(1), amount: centsSchema })
          .parse(args);
        return { category: await repos.budgets.setAmount(month, categoryId, amount) };
      },
    }),

    defineTool({
      name: 'set_budget_carryover',
      title: 'Set a category’s carryover',
      description:
        'Turn rollover on or off for one category in one month. With carryover on, an unspent balance rolls ' +
        'into the next month instead of returning to "to budget"; an overspend carries forward as a negative.',
      inputSchema: {
        month: monthSchema.describe('Month to change, as YYYY-MM.'),
        categoryId: z.string().min(1).describe('Category id, from list_categories.'),
        carryover: z.boolean().describe('True to roll the balance forward, false to stop rolling it forward.'),
      },
      write: true,
      idempotent: true,
      run: async (args) => {
        const { month, categoryId, carryover } = z
          .object({ month: monthSchema, categoryId: z.string().min(1), carryover: z.boolean() })
          .parse(args);
        return { category: await repos.budgets.setCarryover(month, categoryId, carryover) };
      },
    }),

    defineTool({
      name: 'hold_for_next_month',
      title: 'Hold funds for next month',
      description:
        'Hold some of this month’s leftover "to budget" money back for next month, in integer cents. Returns ' +
        '`{ held: false }` when there is not enough available to hold. Each call replaces the previous hold ' +
        'for that month rather than adding to it.',
      inputSchema: {
        month: monthSchema.describe('Month whose surplus to hold, as YYYY-MM.'),
        amount: centsSchema.positive().describe('Amount to hold back, in cents.'),
      },
      write: true,
      idempotent: true,
      run: async (args) => {
        const { month, amount } = z.object({ month: monthSchema, amount: centsSchema.positive() }).parse(args);
        return { held: await repos.budgets.holdForNextMonth(month, amount) };
      },
    }),

    defineTool({
      name: 'reset_budget_hold',
      title: 'Release a held amount',
      description:
        'Release any amount held back for next month, returning it to this month’s "to budget". Safe to call ' +
        'when nothing is held.',
      inputSchema: {
        month: monthSchema.describe('Month whose hold to release, as YYYY-MM.'),
      },
      write: true,
      idempotent: true,
      run: async (args) => {
        const { month } = z.object({ month: monthSchema }).parse(args);
        await repos.budgets.resetHold(month);
        return { reset: true, month };
      },
    }),

    defineTool({
      name: 'create_category',
      title: 'Create a category',
      description:
        'Create a budget category inside an existing category group. Get the group id from `list_categories` ' +
        '(each category reports its `groupId`). Income categories behave differently from spending ones — set ' +
        '`isIncome` only for money coming in.',
      inputSchema: {
        name: z.string().min(1).describe('Name for the new category.'),
        groupId: z.string().min(1).describe('Id of the category group to create it in.'),
        isIncome: z.boolean().optional().describe('True for an income category. Defaults to false.'),
        hidden: z.boolean().optional().describe('Create it hidden. Defaults to false.'),
      },
      write: true,
      run: async (args) => {
        const input = z
          .object({
            name: z.string().min(1),
            groupId: z.string().min(1),
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
        id: z.string().min(1).describe('Id of the category to change.'),
        name: z.string().min(1).optional().describe('New name.'),
        groupId: z.string().min(1).optional().describe('Move the category into this group.'),
        hidden: z.boolean().optional().describe('Hide or unhide the category.'),
      },
      write: true,
      idempotent: true,
      run: async (args) => {
        const { id, ...fields } = z
          .object({
            id: z.string().min(1),
            name: z.string().min(1).optional(),
            groupId: z.string().min(1).optional(),
            hidden: z.boolean().optional(),
          })
          .parse(args);
        return { category: await repos.budgets.updateCategory(id, fields) };
      },
    }),
  ] as ToolDefinition[];
}
