import { z } from 'zod';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { idSchema } from './ids.ts';

export function payeeTools(repos: Pick<ActualRepos, 'payees'>): ToolDefinition[] {
  return [
    defineTool({
      name: 'list_payees',
      title: 'List payees',
      description:
        'List every payee. With `withUsage` (the default) each payee also carries `transactionCount` and ' +
        '`lastTransactionDate`, which is what makes cleanup decisions possible — the busiest payee in a group ' +
        'is normally the one to merge others into. Payees with a `transferAccountId` represent the other side ' +
        'of a transfer, not a merchant, and must never be merged.',
      inputSchema: {
        withUsage: z
          .boolean()
          .optional()
          .describe('Include transaction counts and last-used dates. Defaults to true; false is faster.'),
      },
      run: async (args) => {
        const { withUsage } = z.object({ withUsage: z.boolean().optional() }).parse(args);
        const payees = await repos.payees.list({ withUsage: withUsage ?? true });
        return { payees, count: payees.length };
      },
    }),

    defineTool({
      name: 'find_duplicate_payees',
      title: 'Find likely duplicate payees',
      description:
        'Group payees whose names differ only by case, punctuation, or a trailing store/reference number — ' +
        '`Trader Joe’s #123` and `TRADER JOES 456`, for example. Each group names a `suggestedTarget` (the ' +
        'most-used member) and the other `candidates`, plus the `reason` they were grouped.\n' +
        'Matching is exact once normalized, so an abbreviation and its expansion do NOT group: `AMZN Mktp ' +
        'US*2H4` and `Amazon` are reported separately. An empty result therefore means "no name-shaped ' +
        'duplicates", not "no duplicates" — to find those, scan `list_payees` yourself and propose them to ' +
        'the user. The conservative rule is deliberate: a false positive here feeds an irreversible merge.\n' +
        'This only suggests; nothing is merged. Confirm a group really is one merchant before calling ' +
        '`merge_payees`. Transfer payees are never included.',
      inputSchema: {
        minGroupSize: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe('Only report groups with at least this many payees. Defaults to 2.'),
      },
      run: async (args) => {
        const { minGroupSize } = z.object({ minGroupSize: z.number().int().min(2).optional() }).parse(args);
        const groups = await repos.payees.findDuplicates({ minGroupSize });
        return { groups, count: groups.length };
      },
    }),

    defineTool({
      name: 'create_payee',
      title: 'Create a payee',
      description:
        'Create a payee by name and return it with its new id. Check `resolve_name_to_id` first — creating a ' +
        'payee that already exists under a slightly different name is how duplicates appear in the first place.',
      inputSchema: {
        name: z.string().min(1).describe('Name for the new payee.'),
      },
      write: true,
      run: async (args) => {
        const { name } = z.object({ name: z.string().min(1) }).parse(args);
        return { payee: await repos.payees.create(name) };
      },
    }),

    defineTool({
      name: 'update_payee',
      title: 'Rename a payee',
      description:
        'Rename a payee. Renaming is the only edit Actual’s public API exposes for payees — favorite and ' +
        'category-learning flags are not reachable. Renaming does not merge: to combine two payees, use ' +
        '`merge_payees`.',
      inputSchema: {
        id: idSchema.describe('Id of the payee to rename.'),
        name: z.string().min(1).describe('The new name.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { id, name } = z.object({ id: idSchema, name: z.string().min(1) }).parse(args);
        return { payee: await repos.payees.update(id, { name }) };
      },
    }),

    defineTool({
      name: 'merge_payees',
      title: 'Merge payees',
      description:
        'Merge one or more payees into a target payee: their transactions move to the target and the merged ' +
        'payees are removed. THIS CANNOT BE UNDONE — confirm the payees really are the same merchant before ' +
        'calling, and never merge a payee that has a `transferAccountId`, which would corrupt transfers. Takes ' +
        'ids, not names, so a near-miss on a name cannot silently merge the wrong thing.',
      inputSchema: {
        targetId: idSchema.describe('Id of the payee to keep; everything merges into this one.'),
        mergeIds: z
          .array(idSchema)
          .min(1)
          .describe('Ids of the payees to merge into the target. They will no longer exist afterwards.'),
      },
      write: true,
      destructive: true,
      run: async (args) => {
        const { targetId, mergeIds } = z.object({ targetId: idSchema, mergeIds: z.array(idSchema).min(1) }).parse(args);
        if (mergeIds.includes(targetId)) {
          throw new Error('targetId must not also appear in mergeIds — a payee cannot be merged into itself');
        }
        const payee = await repos.payees.merge(targetId, mergeIds);
        return { payee, mergedCount: mergeIds.length };
      },
    }),
  ] as ToolDefinition[];
}
