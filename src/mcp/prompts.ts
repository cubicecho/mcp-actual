import type { ZodRawShape } from 'zod';
import { z } from 'zod';

/**
 * One MCP prompt: a reusable workflow a client can pull instead of the user
 * hand-writing it. Prompts are guidance only — they cannot reach the budget,
 * so the safety they add is in the ordering they impose on the tool calls.
 */
export interface PromptDefinition<Args extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** MCP prompt arguments are always strings; keep them optional so the prompt is usable bare. */
  argsSchema: Args;
  /** True when the workflow ends in a mutating tool, and so is gated with them. */
  write?: boolean;
  build: (args: Record<string, string | undefined>) => string;
}

function definePrompt<Args extends ZodRawShape>(definition: PromptDefinition<Args>): PromptDefinition<Args> {
  return definition;
}

/**
 * The preview → confirm → apply workflow for backfilling a rule over
 * transactions that already exist.
 *
 * The two hazards this ordering exists to bound are both properties of the
 * underlying Actual handlers, not of this server:
 * `preview_rule_effects` reports the whole ranked rule set rather than one
 * rule, so a change is easy to misattribute; and `apply_rule_actions` does not
 * re-check conditions, so an invented id is silently rewritten rather than
 * skipped.
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
  write: true,
  build: ({ goal, scope }) => {
    const objective = goal
      ? `The rule I want: ${goal}`
      : 'Ask me what the rule should do before you begin — do not guess a rule.';
    const scopeLine = scope
      ? `Limit the backfill to: ${scope}`
      : 'Ask me how far back to apply it if the answer would change which transactions you touch.';
    return [
      'Use the Actual budget tools to safely backfill a rule over transactions that already exist.',
      '',
      objective,
      scopeLine,
      '',
      'Work in this order and do not skip a step:',
      '',
      '1. Call `sync_budget` first — other clients write to this budget.',
      '2. Call `describe_rule_schema`. Do not author conditions from memory; the condition format is a',
      '   strict union and values are ids, never names.',
      '3. Find the ids you need with `list_categories`, `list_payees`, or `resolve_name_to_id`. If a name',
      '   is ambiguous, stop and ask me which one.',
      '4. Create the rule with `create_rule`. This only affects future imports and edits — nothing already',
      '   in the budget changes yet.',
      '5. Call `preview_rule_effects`, scoped as narrowly as you can (start with `uncategorized: true`, a',
      '   `dateFrom`, and a small `limit`).',
      '',
      '   Then STOP and show me a table of what it would change: date, payee, amount, and each field’s',
      '   `from` → `to`. Do not apply anything yet. Read the result carefully first:',
      '   - This is the net effect of ALL rules, not only the one you created. If a change looks unrelated',
      '     to your rule, check `list_rules` and tell me which rule you think caused it rather than',
      '     assuming it was yours.',
      '   - Empty `entries` with a non-zero `scanned` means your rule matched nothing. Say so and suggest a',
      '     fix — do not widen the filter and retry until something matches.',
      '   - If `truncated` is true, tell me; do not silently act on a partial set.',
      '',
      '6. Only after I confirm, call `apply_rule_actions` with the exact `transactionId` values from the',
      '   preview, and the action `value` taken from each change’s `toId`. Never pass an id you did not see',
      '   in the preview output, and never assemble the id list yourself — that tool does NOT re-check rule',
      '   conditions, so a wrong id is silently rewritten rather than skipped.',
      '7. Report what came back: the `updated` count, and anything under `missing` or `errors`. If `missing`',
      '   is non-empty, do not retry — tell me first.',
      '',
      'Never call `apply_rule_actions` before showing me a preview in the same conversation. If you are',
      'unsure whether a change is intended, ask.',
    ].join('\n');
  },
});

/** Every prompt this server can serve, before the write gate is applied. */
export function allPrompts(): PromptDefinition[] {
  return [backfillRule] as PromptDefinition[];
}

/**
 * The prompts actually served. A prompt whose workflow ends in a mutating tool
 * is gated with those tools: handing an agent a script for `apply_rule_actions`
 * when it is not registered would just waste a turn on a tool that is not there.
 */
export function enabledPrompts(enableWrites: boolean): PromptDefinition[] {
  const prompts = allPrompts();
  return enableWrites ? prompts : prompts.filter((prompt) => !prompt.write);
}
