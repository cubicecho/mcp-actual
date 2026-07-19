import { z } from 'zod';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

/** `YYYY-MM-DD`, the only date format Actual accepts. */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD')
  .describe('Date in YYYY-MM-DD format.');

/** Money is integer cents in, always — a float here would silently lose value. */
const centsSchema = z.number().int('Amounts are integer cents — 12.34 dollars is 1234, and negative means an outflow.');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const searchSchema = z.object({
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  accountId: z.string().min(1).optional(),
  payeeId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  notesContains: z.string().min(1).optional(),
  payeeNameContains: z.string().min(1).optional(),
  amountMin: centsSchema.optional(),
  amountMax: centsSchema.optional(),
  cleared: z.boolean().optional(),
  reconciled: z.boolean().optional(),
  uncategorized: z.boolean().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});

const updateSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1).nullable().optional(),
  payeeId: z.string().min(1).nullable().optional(),
  notes: z.string().nullable().optional(),
  cleared: z.boolean().optional(),
  date: dateSchema.optional(),
  amount: centsSchema.optional(),
});

export function transactionTools(repos: Pick<ActualRepos, 'transactions'>): ToolDefinition[] {
  return [
    defineTool({
      name: 'search_transactions',
      title: 'Search transactions',
      description:
        'Search transactions across every account, filtered by any combination of date range, account, payee, ' +
        'category, note text, payee-name text, amount range, and cleared/reconciled state. Amounts are integer ' +
        'cents and negative means an outflow. Results are newest-first and capped by `limit` (default ' +
        `${DEFAULT_LIMIT}, max ${MAX_LIMIT}); when \`truncated\` is true, more matched than were returned — ` +
        'narrow the filters rather than assuming you have seen everything. This is the tool for payee cleanup: ' +
        'it can answer "where else does this payee appear?", which the per-account listing cannot.',
      inputSchema: {
        dateFrom: dateSchema.optional().describe('Only transactions on or after this date.'),
        dateTo: dateSchema.optional().describe('Only transactions on or before this date.'),
        accountId: z.string().min(1).optional().describe('Restrict to one account.'),
        payeeId: z.string().min(1).optional().describe('Restrict to one payee, by id.'),
        categoryId: z.string().min(1).optional().describe('Restrict to one category, by id.'),
        notesContains: z.string().min(1).optional().describe('Substring match against the notes field.'),
        payeeNameContains: z.string().min(1).optional().describe('Substring match against the payee’s name.'),
        amountMin: centsSchema.optional().describe('Minimum amount in cents (inclusive).'),
        amountMax: centsSchema.optional().describe('Maximum amount in cents (inclusive).'),
        cleared: z.boolean().optional().describe('Filter by cleared state.'),
        reconciled: z.boolean().optional().describe('Filter by reconciled state.'),
        uncategorized: z.boolean().optional().describe('Only transactions with no category set.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum results to return. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`),
      },
      run: async (args) => {
        const filters = searchSchema.parse(args);
        return repos.transactions.search({ ...filters, limit: filters.limit ?? DEFAULT_LIMIT });
      },
    }),

    defineTool({
      name: 'get_transactions',
      title: 'Get an account’s transactions',
      description:
        'List every transaction in one account between two dates, with no result cap. Use `search_transactions` ' +
        'for anything cross-account or filtered; this is the exhaustive per-account read, e.g. for reconciling.',
      inputSchema: {
        accountId: z.string().min(1).describe('The account to read.'),
        startDate: dateSchema.describe('First date to include (inclusive).'),
        endDate: dateSchema.describe('Last date to include (inclusive).'),
      },
      run: async (args) => {
        const { accountId, startDate, endDate } = z
          .object({ accountId: z.string().min(1), startDate: dateSchema, endDate: dateSchema })
          .parse(args);
        const transactions = await repos.transactions.listForAccount(accountId, startDate, endDate);
        return { transactions, count: transactions.length };
      },
    }),

    defineTool({
      name: 'update_transaction',
      title: 'Update a transaction',
      description:
        'Change a transaction’s category, payee, notes, cleared flag, date, or amount. Only the fields you pass ' +
        'are touched; pass null to clear a category, payee, or note. Amounts are integer cents. Returns the ' +
        'transaction as stored afterwards — rules may rewrite a value on write, so trust the response over the ' +
        'request. The main tool for recategorizing during cleanup.',
      inputSchema: {
        id: z.string().min(1).describe('Id of the transaction to change.'),
        categoryId: z.string().min(1).nullable().optional().describe('New category id, or null to clear it.'),
        payeeId: z.string().min(1).nullable().optional().describe('New payee id, or null to clear it.'),
        notes: z.string().nullable().optional().describe('New note text, or null to clear it.'),
        cleared: z.boolean().optional().describe('Mark cleared or uncleared.'),
        date: dateSchema.optional().describe('New date.'),
        amount: centsSchema.optional().describe('New amount in cents; negative is an outflow.'),
      },
      write: true,
      idempotent: true,
      run: async (args) => {
        const { id, ...fields } = updateSchema.parse(args);
        const transaction = await repos.transactions.update(id, fields);
        if (!transaction) {
          throw new Error(`No transaction found with id "${id}" after the update`);
        }
        return { transaction };
      },
    }),
  ] as ToolDefinition[];
}
