import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import type { Rule } from './types.ts';

export interface RulesRepo {
  list(options?: { payeeId?: string }): Promise<Rule[]>;
  create(rule: RuleInput): Promise<Rule>;
  update(id: string, rule: RuleInput): Promise<Rule>;
}

/**
 * A rule as a tool supplies it. Conditions and actions stay `unknown[]` here —
 * they are validated by the zod schema at the tool boundary (see
 * `src/mcp/tools/rules.ts`), which mirrors Actual's discriminated union far
 * more precisely than a hand-written interface could.
 */
export interface RuleInput {
  stage: 'pre' | 'post' | null;
  conditionsOp: 'and' | 'or';
  conditions: unknown[];
  actions: unknown[];
}

type RawRule = Awaited<ReturnType<typeof api.getRules>>[number];

function toRule(raw: RawRule): Rule {
  return {
    id: raw.id,
    stage: raw.stage ?? null,
    conditionsOp: raw.conditionsOp,
    conditions: raw.conditions,
    actions: raw.actions,
  };
}

export function createRulesRepo(client: ActualClient): RulesRepo {
  return {
    /**
     * All rules, or only those Actual associates with one payee. The payee
     * filter uses `getPayeeRules`, which resolves rules that *reference* the
     * payee rather than string-matching our own way.
     */
    list: (options) =>
      client.run(async () => {
        const raw = options?.payeeId ? await api.getPayeeRules(options.payeeId) : await api.getRules();
        return raw.map(toRule);
      }),

    create: (rule) =>
      client.run(async () => {
        const created = await api.createRule(rule as Parameters<typeof api.createRule>[0]);
        return toRule(created as RawRule);
      }),

    /**
     * Actual's `updateRule` replaces the whole rule, so callers must send the
     * complete conditions/actions set — a partial update would silently drop
     * whatever it omitted.
     */
    update: (id, rule) =>
      client.run(async () => {
        const updated = await api.updateRule({ id, ...rule } as Parameters<typeof api.updateRule>[0]);
        return toRule(updated as RawRule);
      }),
  };
}
