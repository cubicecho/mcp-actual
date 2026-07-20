import { z } from 'zod';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { idSchema } from './ids.ts';

/**
 * Which operators are legal for each condition field. Actual models this as a
 * discriminated union in TypeScript; an agent cannot see that type, so we
 * publish it through `describe_rule_schema` and validate against it here.
 * Sourced from `RuleConditionEntity` in `@actual-app/core`.
 */
const CONDITION_OPS: Record<string, readonly string[]> = {
  account: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain', 'matches', 'onBudget', 'offBudget'],
  category: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain', 'matches'],
  category_group: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain', 'matches'],
  amount: ['is', 'isapprox', 'isbetween', 'gt', 'gte', 'lt', 'lte'],
  date: ['is', 'isapprox', 'isbetween', 'gt', 'gte', 'lt', 'lte'],
  notes: ['is', 'isNot', 'contains', 'doesNotContain', 'matches', 'hasTags', 'hasAnyTag'],
  payee: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain', 'matches'],
  imported_payee: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain', 'matches'],
  saved: ['is'],
  cleared: ['is'],
  reconciled: ['is'],
  transfer: ['is'],
};

/**
 * Actual's `ACTION_OPS`, verbatim. The `Action` constructor asserts membership,
 * so a wrong op throws from inside the library — note it is
 * `delete-transaction`, not `delete`.
 */
const ACTION_OPS = [
  'set',
  'set-split-amount',
  'link-schedule',
  'prepend-notes',
  'append-notes',
  'delete-transaction',
] as const;

/**
 * Fields a `set` action may target, from Actual's `FIELD_INFO`. The `Action`
 * constructor asserts `FIELD_TYPES.get(field)` is defined, so an unlisted field
 * throws from inside the library rather than failing validation here.
 */
const SET_FIELDS = [
  'imported_payee',
  'payee',
  'payee_name',
  'date',
  'notes',
  'amount',
  'category',
  'category_group',
  'account',
  'cleared',
  'reconciled',
  'saved',
  'transfer',
  'parent',
] as const;

const conditionSchema = z
  .object({
    field: z.string().min(1),
    op: z.string().min(1),
    value: z.unknown(),
    options: z.record(z.unknown()).optional(),
  })
  .superRefine((condition, ctx) => {
    const ops = CONDITION_OPS[condition.field];
    if (!ops) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown condition field "${condition.field}". Valid fields: ${Object.keys(CONDITION_OPS).join(', ')}`,
      });
      return;
    }
    if (!ops.includes(condition.op)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator "${condition.op}" is not valid for field "${condition.field}". Valid: ${ops.join(', ')}`,
      });
    }
  });

const actionSchema = z
  .object({
    field: z.string().optional(),
    op: z.enum(ACTION_OPS),
    value: z.unknown(),
    options: z.record(z.unknown()).optional(),
  })
  .superRefine((action, ctx) => {
    if (action.op !== 'set') {
      return;
    }
    if (!action.field) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A "set" action requires a `field`.' });
      return;
    }
    if (!SET_FIELDS.includes(action.field as (typeof SET_FIELDS)[number])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot set field "${action.field}". Valid fields: ${SET_FIELDS.join(', ')}`,
      });
    }
  });

const ruleBodySchema = z.object({
  stage: z.enum(['pre', 'post']).nullable().optional(),
  conditionsOp: z.enum(['and', 'or']).optional(),
  conditions: z.array(conditionSchema).min(1),
  actions: z.array(actionSchema).min(1),
});

/** The reference document `describe_rule_schema` returns. */
const RULE_SCHEMA_DOC = {
  summary:
    'A rule is a set of conditions and the actions applied to any transaction matching them. Conditions are ' +
    'combined with conditionsOp ("and" by default). Rules run when a transaction is imported or edited; ' +
    'stage "pre" runs before normal rules, "post" after, null (the default) in the middle.',
  conditionFields: Object.entries(CONDITION_OPS).map(([field, ops]) => ({ field, ops })),
  valueNotes: {
    account: 'value is an account id (see resolve_name_to_id). onBudget/offBudget take no meaningful value.',
    category: 'value is a category id.',
    payee: 'value is a payee id.',
    imported_payee: 'value is the raw text the bank sent, before any rule renamed it — matched as a string.',
    amount: 'value is integer cents; negative is an outflow. isbetween takes { num1, num2 }.',
    date: 'value is YYYY-MM-DD. isapprox matches within a few days.',
    notes: 'value is a string. hasTags / hasAnyTag match tags inside the note text.',
    oneOf: 'ops oneOf/notOneOf take an array of values rather than a single value.',
  },
  actionOps: {
    set: 'Set a field: { op: "set", field: "category", value: "<category id>" }.',
    'prepend-notes': 'Prepend text to the note: { op: "prepend-notes", value: "text" }.',
    'append-notes': 'Append text to the note: { op: "append-notes", value: "text" }.',
    'link-schedule': 'Link the transaction to a schedule: { op: "link-schedule", value: "<schedule id>" }.',
    'set-split-amount':
      'Split the transaction; value is the amount, options.splitIndex selects the split, and options.method ' +
      'is one of fixed-amount, fixed-percent, formula, remainder.',
    'delete-transaction':
      'Delete the matching transaction. The op is "delete-transaction" — plain "delete" is rejected. Use with ' +
      'extreme care.',
  },
  examples: [
    {
      description: 'Categorize anything the bank labels as a coffee shop',
      rule: {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'imported_payee', op: 'contains', value: 'STARBUCKS' }],
        actions: [{ op: 'set', field: 'category', value: '<category id from list_categories>' }],
      },
    },
    {
      description: 'Rename a noisy payee and tag large outflows from it',
      rule: {
        stage: null,
        conditionsOp: 'and',
        conditions: [
          { field: 'imported_payee', op: 'contains', value: 'AMZN Mktp' },
          { field: 'amount', op: 'lte', value: -10000 },
        ],
        actions: [
          { op: 'set', field: 'payee', value: '<payee id from resolve_name_to_id>' },
          { op: 'append-notes', value: ' #big-purchase' },
        ],
      },
    },
  ],
} as const;

/** Ceiling on a single bulk apply. A runaway loop should hit a wall, not rewrite the budget. */
const MAX_BATCH = 500;

/** Filters selecting which transactions to preview against. Mirrors `search_transactions`. */
const previewFilterSchema = {
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Only transactions on or after this date (YYYY-MM-DD).'),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Only transactions on or before this date (YYYY-MM-DD).'),
  accountId: idSchema.optional().describe('Restrict to one account.'),
  payeeId: idSchema.optional().describe('Restrict to one payee.'),
  categoryId: idSchema.optional().describe('Restrict to one category.'),
  uncategorized: z.boolean().optional().describe('Only transactions with no category — the usual cleanup target.'),
  notesContains: z.string().min(1).optional().describe('Substring match against notes.'),
  payeeNameContains: z.string().min(1).optional().describe('Substring match against the payee name.'),
  limit: z.number().int().min(1).max(MAX_BATCH).optional().describe('How many transactions to scan. Default 100.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('How many matching transactions to skip, for paging past `limit`. Keep the other filters identical.'),
};

export function ruleTools(repos: Pick<ActualRepos, 'rules'>, enableWrites: boolean): ToolDefinition[] {
  return [
    defineTool({
      name: 'describe_rule_schema',
      title: 'Describe the rule format',
      description:
        'Return the exact structure of an Actual rule: every condition field with the operators legal for it, ' +
        'the action operations, how values are typed, and worked examples. Call this BEFORE create_rule or ' +
        'update_rule — the condition format is a strict union and an invalid field/operator pairing is rejected.',
      inputSchema: {},
      run: async () => RULE_SCHEMA_DOC,
    }),

    defineTool({
      name: 'list_rules',
      title: 'List rules',
      description:
        'List the budget’s rules with their conditions and actions. Pass `payeeId` to list only the rules ' +
        'Actual associates with that payee, which is the quick way to see why transactions for one merchant ' +
        'keep getting a particular category.',
      inputSchema: {
        payeeId: idSchema.optional().describe('Only rules associated with this payee id.'),
      },
      run: async (args) => {
        const { payeeId } = z.object({ payeeId: idSchema.optional() }).parse(args);
        const rules = await repos.rules.list({ payeeId });
        return { rules, count: rules.length };
      },
    }),

    defineTool({
      name: 'create_rule',
      title: 'Create a rule',
      description:
        'Create a rule from conditions and actions. Call `describe_rule_schema` first for the exact format. ' +
        'Conditions reference accounts, categories, and payees by id, not name. The rule applies to future ' +
        'imports and edits — it does not retroactively change existing transactions.',
      inputSchema: {
        conditions: z
          .array(conditionSchema)
          .min(1)
          .describe('Conditions a transaction must match. See describe_rule_schema.'),
        actions: z.array(actionSchema).min(1).describe('Actions applied to matching transactions.'),
        conditionsOp: z
          .enum(['and', 'or'])
          .optional()
          .describe('Whether all conditions must match ("and", the default) or any one ("or").'),
        stage: z
          .enum(['pre', 'post'])
          .nullable()
          .optional()
          .describe('Run before ("pre") or after ("post") normal rules. Defaults to null, the normal stage.'),
      },
      write: true,
      run: async (args) => {
        const body = ruleBodySchema.parse(args);
        return {
          rule: await repos.rules.create({
            stage: body.stage ?? null,
            conditionsOp: body.conditionsOp ?? 'and',
            conditions: body.conditions,
            actions: body.actions,
          }),
        };
      },
    }),

    defineTool({
      name: 'update_rule',
      title: 'Update a rule',
      description:
        'Replace a rule’s conditions and actions. This overwrites the whole rule, so send the complete set — ' +
        'anything omitted is dropped, not preserved. Read the current rule with `list_rules` first.',
      inputSchema: {
        id: idSchema.describe('Id of the rule to replace.'),
        conditions: z.array(conditionSchema).min(1).describe('The complete condition set, not a partial update.'),
        actions: z.array(actionSchema).min(1).describe('The complete action set, not a partial update.'),
        conditionsOp: z.enum(['and', 'or']).optional().describe('Defaults to "and".'),
        stage: z.enum(['pre', 'post']).nullable().optional().describe('Defaults to null, the normal stage.'),
      },
      write: true,
      destructive: true,
      idempotent: true,
      run: async (args) => {
        const { id, ...body } = ruleBodySchema.extend({ id: idSchema }).parse(args);
        return {
          rule: await repos.rules.update(id, {
            stage: body.stage ?? null,
            conditionsOp: body.conditionsOp ?? 'and',
            conditions: body.conditions,
            actions: body.actions,
          }),
        };
      },
    }),

    defineTool({
      name: 'preview_rule_effects',
      title: 'Preview what the rules would change',
      description:
        'Run the budget’s rules over EXISTING transactions without saving anything, and report the field ' +
        'changes they would make. Actual applies rules on import and edit only, so transactions already in ' +
        'the budget are untouched until you act on them — this shows what a rule would have done to them. ' +
        'The usual flow is `create_rule`, then this to check it against real data, then `apply_rule_actions` ' +
        'to make the changes stick.\n' +
        'IMPORTANT: this reports the net effect of the ENTIRE rule set, not one rule in isolation. Actual has ' +
        'no per-rule preview, and rules interact by rank, so a change shown here may come from a rule other ' +
        'than the one you just wrote. Verify against `list_rules` before assuming which rule caused it.\n' +
        'Each change gives `from`/`to` as readable names plus `fromId`/`toId` for the fields that hold ids — ' +
        'pass `toId` as the action `value` to `apply_rule_actions`. Transactions the rules would not change ' +
        'are omitted, so an empty `entries` with a non-zero `scanned` means the rules are a no-op here.',
      inputSchema: previewFilterSchema,
      run: async (args) => {
        const filters = z
          .object({
            ...previewFilterSchema,
            limit: z.number().int().min(1).max(MAX_BATCH).optional(),
            offset: z.number().int().min(0).optional(),
          })
          .parse(args);
        // Previewing can insert a payee when a rule sets `payee_name` (Actual's
        // engine creates unknown payees as it finalizes), so on a read-only
        // server the repo refuses instead of writing behind the gate.
        return repos.rules.previewEffects(
          { ...filters, limit: filters.limit ?? 100 },
          { allowPayeeCreation: enableWrites },
        );
      },
    }),

    defineTool({
      name: 'apply_rule_actions',
      title: 'Apply rule actions to transactions',
      description:
        'Apply rule actions to specific transactions and SAVE the result. This is the write half of ' +
        '`preview_rule_effects`: preview first, then pass the transaction ids it returned.\n' +
        'The actions are applied UNCONDITIONALLY to every id you pass — rule conditions are NOT evaluated ' +
        'here, so a wrong id is silently changed rather than skipped. Pass only ids you have actually seen, ' +
        'from `preview_rule_effects` or `search_transactions`; never ids you assembled yourself.\n' +
        `Edits real transactions in bulk, at most ${MAX_BATCH} per call, and cannot be undone through this ` +
        'server. Actions use the same format as `create_rule` (see `describe_rule_schema`), and values are ' +
        'ids, not names — `preview_rule_effects` reports these as `toId`. Returns the ids actually updated, ' +
        'plus any that did not exist under `missing`.',
      inputSchema: {
        transactionIds: z
          .array(idSchema)
          .min(1)
          .max(MAX_BATCH)
          .describe(`Ids of the transactions to change. At most ${MAX_BATCH}.`),
        actions: z.array(actionSchema).min(1).describe('Actions to apply. Same format as create_rule.'),
      },
      write: true,
      destructive: true,
      run: async (args) => {
        const { transactionIds, actions } = z
          .object({
            transactionIds: z.array(idSchema).min(1).max(MAX_BATCH),
            actions: z.array(actionSchema).min(1),
          })
          .parse(args);
        return repos.rules.applyActions(transactionIds, actions);
      },
    }),
  ] as ToolDefinition[];
}
