import { z } from 'zod';
import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

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

const ACTION_OPS = ['set', 'set-split-amount', 'link-schedule', 'prepend-notes', 'append-notes', 'delete'] as const;

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

const actionSchema = z.object({
  field: z.string().optional(),
  op: z.enum(ACTION_OPS),
  value: z.unknown(),
  options: z.record(z.unknown()).optional(),
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
    'set-split-amount': 'Split the transaction; value is the amount, options.splitIndex selects the split.',
    delete: 'Delete the matching transaction. Use with extreme care.',
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

export function ruleTools(repos: Pick<ActualRepos, 'rules'>): ToolDefinition[] {
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
        payeeId: z.string().min(1).optional().describe('Only rules associated with this payee id.'),
      },
      run: async (args) => {
        const { payeeId } = z.object({ payeeId: z.string().min(1).optional() }).parse(args);
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
        id: z.string().min(1).describe('Id of the rule to replace.'),
        conditions: z.array(conditionSchema).min(1).describe('The complete condition set, not a partial update.'),
        actions: z.array(actionSchema).min(1).describe('The complete action set, not a partial update.'),
        conditionsOp: z.enum(['and', 'or']).optional().describe('Defaults to "and".'),
        stage: z.enum(['pre', 'post']).nullable().optional().describe('Defaults to null, the normal stage.'),
      },
      write: true,
      idempotent: true,
      run: async (args) => {
        const { id, ...body } = ruleBodySchema.extend({ id: z.string().min(1) }).parse(args);
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
  ] as ToolDefinition[];
}
