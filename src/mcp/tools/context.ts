import { z } from 'zod';
import type { ResolvableType } from '../../actual/context.ts';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { idSchema } from './ids.ts';

const RESOLVABLE_TYPES = ['accounts', 'categories', 'payees', 'schedules'] as const;

export function contextTools(repos: Pick<ActualRepos, 'context' | 'budgets'>): ToolDefinition[] {
  return [
    defineTool({
      name: 'resolve_name_to_id',
      title: 'Resolve a name to an id',
      description:
        'Look up the id of an account, category, payee, or schedule by its exact name. Returns `{ id: null }` ' +
        'when nothing matches — that is a normal answer, not an error, so use it to check whether something ' +
        'exists before creating it. Most other tools take ids, so this saves listing everything just to find one.',
      inputSchema: {
        type: z.enum(RESOLVABLE_TYPES).describe('Which kind of entity to look up.'),
        name: z.string().min(1).describe('The exact name to match.'),
      },
      run: async (args) => {
        const { type, name } = z.object({ type: z.enum(RESOLVABLE_TYPES), name: z.string().min(1) }).parse(args);
        return { id: await repos.context.resolveNameToId(type as ResolvableType, name) };
      },
    }),

    defineTool({
      name: 'list_categories',
      title: 'List budget categories',
      description:
        'List every budget category with its id, name, and containing group. Categories are addressed by id by ' +
        'the budgeting and rule tools, so this is usually the first call when working with either. Hidden ' +
        'categories are excluded unless `includeHidden` is true.',
      inputSchema: {
        includeHidden: z.boolean().optional().describe('Include hidden categories and groups. Defaults to false.'),
      },
      run: async (args) => {
        const { includeHidden } = z.object({ includeHidden: z.boolean().optional() }).parse(args);
        return { categories: await repos.budgets.listCategories({ includeHidden }) };
      },
    }),

    defineTool({
      name: 'list_schedules',
      title: 'List scheduled transactions',
      description:
        'List Actual’s scheduled (recurring) transactions with their next due date and amount. Useful context ' +
        'when a budget or rule looks wrong: a category may be funded for a schedule that has not posted yet.',
      inputSchema: {},
      run: async () => ({ schedules: await repos.context.listSchedules() }),
    }),

    defineTool({
      name: 'list_tags',
      title: 'List tags',
      description:
        'List the tags defined in this budget. Rules can match tags in transaction notes (`hasTags`), so this ' +
        'is the vocabulary available to such a rule.',
      inputSchema: {},
      run: async () => ({ tags: await repos.context.listTags() }),
    }),

    defineTool({
      name: 'get_note',
      title: 'Get a note',
      description:
        'Read the note attached to an entity (transaction, account, category, …) by its id. Returns ' +
        '`{ note: null }` when there is none.',
      inputSchema: {
        id: idSchema.describe('Id of the entity whose note to read.'),
      },
      run: async (args) => {
        const { id } = z.object({ id: idSchema }).parse(args);
        return { note: await repos.context.getNote(id) };
      },
    }),

    defineTool({
      name: 'sync_budget',
      title: 'Sync with the Actual server',
      description:
        'Pull the latest changes from the Actual sync server. Read tools already sync where it matters, so ' +
        'reach for this after editing the budget in the Actual UI and wanting those edits reflected immediately.',
      inputSchema: {},
      // Pulls server state; changes nothing the user did not already cause.
      run: async () => {
        await repos.context.sync();
        return { synced: true };
      },
    }),

    defineTool({
      name: 'update_note',
      title: 'Set a note',
      description:
        'Replace the note attached to an entity by its id. Notes are free text and overwrite wholesale — read ' +
        'the existing note first with `get_note` if you mean to append to it.',
      inputSchema: {
        id: idSchema.describe('Id of the entity to annotate.'),
        note: z.string().describe('The full note text. Replaces any existing note.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { id, note } = z.object({ id: idSchema, note: z.string() }).parse(args);
        return { note: await repos.context.updateNote(id, note) };
      },
    }),

    defineTool({
      name: 'run_bank_sync',
      title: 'Fetch transactions from linked banks',
      description:
        'Trigger Actual’s bank sync to pull new transactions from linked accounts, optionally for one account. ' +
        'Slow and rate-limited by the bank, so call it deliberately rather than before every read. Fails rather ' +
        'than reporting a hollow success when the account does not exist, is closed, or has no bank link. ' +
        'Returns the accounts it actually synced — Actual does not report how many transactions arrived, so ' +
        'follow up with `search_transactions` rather than claiming a count.',
      inputSchema: {
        accountId: idSchema.optional().describe('Sync only this account. Omit to sync every linked account.'),
      },
      write: true,
      destructive: true,
      run: async (args) => {
        const { accountId } = z.object({ accountId: idSchema.optional() }).parse(args);
        return repos.context.runBankSync(accountId);
      },
    }),
  ] as ToolDefinition[];
}
