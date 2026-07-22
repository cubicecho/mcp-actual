import { z } from 'zod';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { idSchema } from './ids.ts';

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
  accountId: idSchema.optional(),
  payeeId: idSchema.optional(),
  categoryId: idSchema.optional(),
  notesContains: z.string().min(1).optional(),
  payeeNameContains: z.string().min(1).optional(),
  amountMin: centsSchema.optional(),
  amountMax: centsSchema.optional(),
  cleared: z.boolean().optional(),
  reconciled: z.boolean().optional(),
  uncategorized: z.boolean().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

const updateSchema = z.object({
  id: idSchema,
  categoryId: idSchema.nullable().optional(),
  payeeId: idSchema.nullable().optional(),
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
        'page with `offset` or narrow the filters rather than assuming you have seen everything. This is the ' +
        'tool for payee cleanup: ' +
        'it can answer "where else does this payee appear?", which the per-account listing cannot.',
      inputSchema: {
        dateFrom: dateSchema.optional().describe('Only transactions on or after this date.'),
        dateTo: dateSchema.optional().describe('Only transactions on or before this date.'),
        accountId: idSchema.optional().describe('Restrict to one account.'),
        payeeId: idSchema.optional().describe('Restrict to one payee, by id.'),
        categoryId: idSchema.optional().describe('Restrict to one category, by id.'),
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
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'How many matching results to skip, for paging past `limit`. Keep every other filter identical ' +
              'between pages, or the pages will not line up.',
          ),
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
        'for anything cross-account or filtered; this is the exhaustive per-account read, e.g. for reconciling.\n' +
        'Split transactions are returned as the parent followed by each of its legs (`isParent` / `isChild`), ' +
        'so summing every row double-counts a split — total the legs, or the parents, not both.',
      inputSchema: {
        accountId: idSchema.describe('The account to read.'),
        startDate: dateSchema.describe('First date to include (inclusive).'),
        endDate: dateSchema.describe('Last date to include (inclusive).'),
      },
      run: async (args) => {
        const { accountId, startDate, endDate } = z
          .object({ accountId: idSchema, startDate: dateSchema, endDate: dateSchema })
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
        id: idSchema.describe('Id of the transaction to change.'),
        categoryId: idSchema.nullable().optional().describe('New category id, or null to clear it.'),
        payeeId: idSchema.nullable().optional().describe('New payee id, or null to clear it.'),
        notes: z.string().nullable().optional().describe('New note text, or null to clear it.'),
        cleared: z.boolean().optional().describe('Mark cleared or uncleared.'),
        date: dateSchema.optional().describe('New date.'),
        amount: centsSchema.optional().describe('New amount in cents; negative is an outflow.'),
      },
      write: true,
      destructive: true,
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

    defineTool({
      name: 'link_transfer',
      title: 'Link two transactions as a transfer',
      description:
        'Mark two existing transactions as the two halves of one transfer between accounts — the same operation ' +
        'as "Make transfer" in Actual. Each transaction’s payee becomes the other account’s transfer payee and ' +
        'the two are linked, so the movement stops counting as spending or income.\n' +
        'Requirements, all enforced: two different transactions, in two different accounts, whose amounts cancel ' +
        'out exactly (e.g. -5000 and 5000), neither already linked, neither a split parent. Find the pair with ' +
        '`search_transactions` — a matching date range plus `amountMin`/`amountMax` is the usual way.\n' +
        'When only one side exists (the other account has not imported it, or is not tracked here), do NOT use ' +
        'this tool: call `update_transaction` with `payeeId` set to the destination account’s transfer payee ' +
        '(the payee whose `transferAccountId` is that account, from `list_payees`), and Actual will create the ' +
        'matching transaction in that account itself.\n' +
        'If both accounts sit on the same side of the budget (both on-budget or both off-budget) the category is ' +
        'cleared from both legs, as Actual does for transfers it creates itself. Returns both transactions as ' +
        'stored afterwards.',
      inputSchema: {
        transactionId: idSchema.describe('One side of the transfer.'),
        counterpartId: idSchema.describe(
          'The other side: a transaction in a different account for the opposite amount.',
        ),
      },
      write: true,
      destructive: true,
      run: async (args) => {
        const { transactionId, counterpartId } = z
          .object({ transactionId: idSchema, counterpartId: idSchema })
          .parse(args);
        return repos.transactions.linkTransfer(transactionId, counterpartId);
      },
    }),

    defineTool({
      name: 'unlink_transfer',
      title: 'Unlink a transfer',
      description:
        'Break the link between the two halves of a transfer, given either half. Both transactions are kept — ' +
        'this undoes the pairing, it does not delete anything — and both have their transfer payee cleared along ' +
        'with the link, because a transaction that still names a transfer payee with no counterpart makes Actual ' +
        'recreate the missing leg on the next edit. Their categories are left as they are, so a transfer that was ' +
        'really spending needs recategorizing afterwards with `update_transaction`. ' +
        'Errors if the transaction is not part of a transfer.',
      inputSchema: {
        transactionId: idSchema.describe('Either half of the transfer to unlink.'),
      },
      write: true,
      destructive: true,
      run: async (args) => {
        const { transactionId } = z.object({ transactionId: idSchema }).parse(args);
        return repos.transactions.unlinkTransfer(transactionId);
      },
    }),
  ] as ToolDefinition[];
}
