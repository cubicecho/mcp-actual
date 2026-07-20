import type { ZodRawShape } from 'zod';
import { z } from 'zod';

/** Context a prompt renders against — chiefly whether the write tools exist in this server. */
export interface PromptContext {
  enableWrites: boolean;
}

/**
 * One MCP prompt: a reusable workflow a client can pull instead of the user
 * hand-writing it. Prompts are guidance only — they cannot reach the budget, so
 * the value they add is the ordering they impose on the tool calls, and the
 * conventions (ids not names, integer cents, sync first) an agent would
 * otherwise have to rediscover.
 */
export interface PromptDefinition<Args extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  argsSchema: Args;
  build: (args: Record<string, string | undefined>, context: PromptContext) => string;
}

function definePrompt<Args extends ZodRawShape>(definition: PromptDefinition<Args>): PromptDefinition<Args> {
  return definition;
}

/** Conventions every workflow here depends on. Repeated into each prompt rather than assumed. */
const GROUND_RULES = [
  '- Call `sync_budget` before reading. Other clients write to this budget, and a stale read is worse',
  '  than a slow one.',
  '- Tools take ids, never names. Use `resolve_name_to_id`, `list_categories`, or `list_payees` to look',
  '  one up, and stop and ask me if a name is ambiguous rather than picking one.',
  '- Money is integer cents; -1250 is an outflow of $12.50. The `amountDecimal` field is for display only.',
  '- Lists are capped. If a result says `truncated: true`, say so — do not present a partial answer as if',
  '  it were complete.',
];

/** Closing line for a workflow whose write half is unavailable. */
function readOnlyNote(action: string): string {
  return [
    '',
    `This server is in read-only mode, so ${action} is not available. Do the analysis, present your`,
    'recommendation, and stop there. Do not claim anything was changed, and do not look for another tool',
    'to do it with — there is not one.',
  ].join('\n');
}

/**
 * The preview → confirm → apply workflow for backfilling a rule over
 * transactions that already exist.
 *
 * The two hazards this ordering exists to bound are properties of the
 * underlying Actual handlers, not of this server: `preview_rule_effects`
 * reports the whole ranked rule set rather than one rule, so a change is easy
 * to misattribute; and `apply_rule_actions` does not re-check conditions, so an
 * invented id is silently rewritten rather than skipped.
 */
const backfillRule = definePrompt({
  name: 'backfill_rule',
  title: 'Backfill a rule over existing transactions',
  description:
    'Safely apply a categorization (or renaming) rule to transactions already in the budget: author the ' +
    'rule, preview what it would change, confirm, then apply. Use this instead of calling ' +
    'apply_rule_actions directly — it enforces the preview-then-confirm ordering those tools rely on.',
  argsSchema: {
    goal: z
      .string()
      .optional()
      .describe('What the rule should do, e.g. "categorize Starbucks as Coffee". Asked for if omitted.'),
    scope: z.string().optional().describe('Optional limit on which transactions to touch, e.g. "since 2026-01-01".'),
  },
  build: ({ goal, scope }, { enableWrites }) => {
    const lines = [
      'Use the Actual budget tools to safely backfill a rule over transactions that already exist.',
      '',
      goal ? `The rule I want: ${goal}` : 'Ask me what the rule should do before you begin — do not guess a rule.',
      scope
        ? `Limit the backfill to: ${scope}`
        : 'Ask me how far back to apply it if that would change which transactions you touch.',
      '',
      'Ground rules:',
      ...GROUND_RULES,
      '',
      'Work in this order and do not skip a step:',
      '',
      '1. Sync, then call `describe_rule_schema`. Do not author conditions from memory; the condition format',
      '   is a strict union and values are ids, never names.',
      '2. Look up the ids the rule needs.',
    ];

    if (enableWrites) {
      lines.push(
        '3. Create the rule with `create_rule`. This only affects future imports and edits — nothing already',
        '   in the budget changes yet.',
      );
    } else {
      lines.push(
        '3. Writes are disabled, so you cannot create the rule. Show me the exact `create_rule` arguments you',
        '   would use, then continue — the preview below still works against the rules that already exist.',
      );
    }

    lines.push(
      '4. Call `preview_rule_effects`, scoped as narrowly as you can (start with `uncategorized: true`, a',
      '   `dateFrom`, and a small `limit`).',
      '',
      '   Then STOP and show me a table of what it would change: date, payee, amount, and each field’s',
      '   `from` → `to`. Read the result carefully first:',
      '   - This is the net effect of ALL rules, not only the one in question. If a change looks unrelated,',
      '     check `list_rules` and tell me which rule you think caused it rather than assuming.',
      '   - Empty `entries` with a non-zero `scanned` means the rule matched nothing. Say so and suggest a',
      '     fix — do not widen the filter and retry until something matches.',
    );

    if (enableWrites) {
      lines.push(
        '5. Only after I confirm, call `apply_rule_actions` with the exact `transactionId` values from the',
        '   preview, and each action `value` taken from the change’s `toId`. Never pass an id you did not see',
        '   in the preview output, and never assemble the id list yourself — that tool does NOT re-check rule',
        '   conditions, so a wrong id is silently rewritten rather than skipped.',
        '6. Report the `updated` count and anything under `missing` or `errors`. If `missing` is non-empty, do',
        '   not retry — tell me first.',
        '',
        'Never call `apply_rule_actions` before showing me a preview in the same conversation. If you are',
        'unsure whether a change is intended, ask.',
      );
    } else {
      lines.push(readOnlyNote('applying the changes'));
    }
    return lines.join('\n');
  },
});

/**
 * Payee cleanup. `find_duplicate_payees` only clusters similar names — the
 * judgement about which are the same merchant is the user's, and merges cannot
 * be undone through this server, so the prompt keeps the agent proposing rather
 * than deciding.
 */
const cleanupPayees = definePrompt({
  name: 'cleanup_payees',
  title: 'Find and merge duplicate payees',
  description:
    'Review payees that look like the same merchant under different names (bank noise like "AMZN Mktp ' +
    'US*2H4" vs "Amazon") and merge them after confirmation. Groups the candidates, shows usage counts, ' +
    'and never merges without asking.',
  argsSchema: {
    focus: z.string().optional().describe('Optional merchant or name fragment to concentrate on, e.g. "Amazon".'),
  },
  build: ({ focus }, { enableWrites }) => {
    const lines = [
      'Help me clean up duplicate payees in my Actual budget.',
      '',
      focus ? `Concentrate on: ${focus}` : 'Cover the whole payee list, worst offenders first.',
      '',
      'Ground rules:',
      ...GROUND_RULES,
      '',
      'Steps:',
      '',
      '1. Sync, then call `find_duplicate_payees` to get the candidate clusters. Cross-reference with',
      '   `list_payees` for transaction counts and last-used dates.',
      '2. Present each cluster as a group: the suggested target, the other names, how many transactions each',
      '   has, and when each was last used. Recommend which name should win — normally the clean human',
      '   name, not the bank string, regardless of which has more transactions.',
      '3. Treat the clustering as a suggestion, not a verdict. Similar names are not always the same',
      '   merchant ("Shell" the fuel station vs "Shell Energy"). Call out anything you are unsure about',
      '   instead of folding it in quietly.',
      '4. NEVER merge a payee that has a `transferAccountId`. Those represent the other side of an account',
      '   transfer, and merging one corrupts the transfers that reference it. Exclude them and say you did.',
    ];

    if (enableWrites) {
      lines.push(
        '5. Ask me to confirm each group — or to confirm the whole batch explicitly — before doing anything.',
        '6. On confirmation, call `merge_payees` per group. This cannot be undone through this server, so if',
        '   my instruction is ambiguous, ask instead of guessing.',
        '7. Afterwards, consider whether a rule would stop the duplicate coming back on the next import, and',
        '   offer it. Do not create one unasked.',
      );
    } else {
      lines.push(readOnlyNote('merging payees'));
    }
    return lines.join('\n');
  },
});

/** Triage for uncategorized transactions — the most common recurring cleanup task. */
const categorizeTransactions = definePrompt({
  name: 'categorize_transactions',
  title: 'Triage uncategorized transactions',
  description:
    'Find transactions with no category, group them by payee, and propose a category for each — then ' +
    'apply the ones I approve, and optionally write rules so they categorize themselves next time.',
  argsSchema: {
    period: z.string().optional().describe('Which period to triage, e.g. "July 2026" or "the last 90 days".'),
  },
  build: ({ period }, { enableWrites }) => {
    const lines = [
      'Help me categorize the uncategorized transactions in my Actual budget.',
      '',
      period ? `Period to triage: ${period}` : 'Ask me which period to cover before you start.',
      '',
      'Ground rules:',
      ...GROUND_RULES,
      '',
      'Steps:',
      '',
      '1. Sync, then call `search_transactions` with `uncategorized: true` and a date range for the period.',
      '2. Call `list_categories` so you propose only categories that exist. Never invent one, and do not',
      '   create a category unless I ask.',
      '3. Group what you found by payee and show me the groups largest-first: payee, count, total amount, and',
      '   the category you propose for each. Base the proposal on how I have categorized that same payee',
      '   before — check with `search_transactions` filtered to that payee — not on what the name suggests.',
      '4. Where you cannot tell, say so and ask. A wrong category is worse than an unanswered question,',
      '   because it silently distorts the budget.',
    ];

    if (enableWrites) {
      lines.push(
        '5. After I approve a group, apply it with `update_transaction` per transaction, or with',
        '   `apply_rule_actions` passing the ids you just showed me and a single',
        '   `{ op: "set", field: "category", value: "<category id>" }` action.',
        '6. For any payee that will recur, offer a `create_rule` so the next import categorizes itself, and',
        '   use the `backfill_rule` workflow if I want it applied to older transactions too.',
      );
    } else {
      lines.push(readOnlyNote('applying categories'));
    }
    return lines.join('\n');
  },
});

/** Orientation: what this server exposes and how to use it without breaking anything. */
const exploreBudget = definePrompt({
  name: 'explore_budget',
  title: 'Explore the budget and this server',
  description:
    'Start here. Orients you (and the agent) around what this Actual budget contains and which tools to ' +
    'reach for, with the conventions that make the rest of the tools behave — ids over names, integer ' +
    'cents, sync before reading, and where the write gate sits.',
  argsSchema: {
    question: z
      .string()
      .optional()
      .describe('An optional question to answer, e.g. "where did the grocery budget go last month?".'),
  },
  build: ({ question }, { enableWrites }) => {
    return [
      'You have access to my Actual Budget through an MCP server. Get oriented before you answer anything.',
      '',
      'Ground rules:',
      ...GROUND_RULES,
      enableWrites
        ? '- Writes are ENABLED. Mutating tools are real and mostly cannot be undone through this server, so\n  confirm with me before the first one in any conversation.'
        : '- Writes are DISABLED. Only read tools are registered; do not plan changes you cannot make.',
      '',
      'Start by calling `sync_budget`, then `list_accounts` for the shape of things. From there:',
      '',
      '- **Where money went** — `search_transactions` filters across all accounts (date range, payee,',
      '  category, amount, notes). `get_transactions` is the narrower per-account version.',
      '- **Budget vs actual** — `list_budget_months`, then `get_budget_month` for one month’s budgeted,',
      '  spent, and balance per category.',
      '- **Structure** — `list_categories`, `list_category_groups`, `list_payees`, `list_schedules`,',
      '  `list_tags`. Use these to turn a name I mention into the id a tool needs.',
      '- **Why something was categorized that way** — `list_rules`, optionally filtered by payee.',
      '',
      'Named workflows exist for the common jobs; prefer them over improvising:',
      '`cleanup_payees` for duplicate merchant names, `categorize_transactions` for uncategorized spending,',
      '`backfill_rule` for applying a new rule to transactions that already exist.',
      '',
      question ? `Then answer this: ${question}` : 'Then ask me what I want to look at.',
      '',
      'When you report numbers, state the period they cover and whether any result was truncated. Do not',
      'estimate a total you did not actually read from a tool.',
    ].join('\n');
  },
});

/**
 * Every prompt this server serves. Unlike tools, prompts are **not** write-
 * gated: a prompt cannot change anything, and a read-only server is exactly
 * where an agent most needs to be told that writing is not an option —
 * withholding the workflow would leave it to improvise instead. Each prompt
 * renders against {@link PromptContext} so its steps match the tools that
 * actually exist.
 */
export function allPrompts(): PromptDefinition[] {
  return [exploreBudget, categorizeTransactions, cleanupPayees, backfillRule] as PromptDefinition[];
}
