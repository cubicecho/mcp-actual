import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { AccountBalances, ActualRepos } from '../actual/index.ts';
import { createActualServer, enabledTools } from './server.ts';
import { stubRepos } from './test-repos.ts';

const BALANCES: AccountBalances = {
  accounts: [
    { id: 'a1', name: 'Checking', amount: 123456, amountDecimal: 1234.56, offBudget: false, closed: false },
    { id: 'a2', name: 'Brokerage', amount: 500000, amountDecimal: 5000, offBudget: true, closed: false },
  ],
  onBudgetTotal: 123456,
  total: 623456,
};

/** Connect an MCP client to a server backed by `repos`, over a paired in-memory transport. */
async function connect(repos: ActualRepos, enableWrites = true): Promise<Client> {
  const server = createActualServer({ repos, enableWrites });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]!.text;
}

describe('createActualServer', () => {
  it('serves the account listing', async () => {
    const client = await connect(stubRepos({ accounts: { listWithBalances: async () => BALANCES } }));
    const result = await client.callTool({ name: 'list_accounts' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual(BALANCES);
  });

  it('reports an Actual failure as a tool error rather than throwing', async () => {
    const client = await connect(
      stubRepos({
        accounts: {
          listWithBalances: async () => {
            throw new Error('Failed to open budget "abc"', { cause: new Error('SyncError') });
          },
        },
      }),
    );
    const result = await client.callTool({ name: 'list_accounts' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Failed to open budget "abc": SyncError');
  });

  it('rejects arguments that fail the input schema', async () => {
    const client = await connect(stubRepos());
    const result = await client.callTool({ name: 'get_budget_month', arguments: { month: '2026-07-19' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/YYYY-MM/);
  });

  it('lists category groups, empty ones included', async () => {
    const groups = [
      { id: 'g-1', name: 'Everyday', isIncome: false, hidden: false, categoryCount: 2 },
      { id: 'g-2', name: 'Fresh', isIncome: false, hidden: false, categoryCount: 0 },
    ];
    const client = await connect(stubRepos({ budgets: { listCategoryGroups: async () => groups } }));
    const result = await client.callTool({ name: 'list_category_groups', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ groups });
  });

  it('creates a category group and reports what landed', async () => {
    const client = await connect(
      stubRepos({
        budgets: {
          createCategoryGroup: async (input) => ({
            id: 'g-9',
            name: input.name,
            isIncome: false,
            hidden: Boolean(input.hidden),
            categoryCount: 0,
          }),
        },
      }),
    );
    const result = await client.callTool({ name: 'create_category_group', arguments: { name: 'Travel' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      group: { id: 'g-9', name: 'Travel', isIncome: false, hidden: false, categoryCount: 0 },
    });
  });

  it('passes only the fields given to a category group update', async () => {
    let seen: unknown;
    const client = await connect(
      stubRepos({
        budgets: {
          updateCategoryGroup: async (id, fields) => {
            seen = { id, fields };
            return { id, name: 'Retired', isIncome: false, hidden: true, categoryCount: 1 };
          },
        },
      }),
    );
    const result = await client.callTool({ name: 'update_category_group', arguments: { id: 'g-2', hidden: true } });
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual({ id: 'g-2', fields: { hidden: true } });
  });

  describe('rule preview and apply', () => {
    it('previews rule effects without writing, passing the filters through', async () => {
      let seen: unknown;
      const preview = {
        entries: [
          {
            transactionId: 't-1',
            date: '2026-07-01',
            payeeName: 'AMZN Mktp US*2H4',
            amount: -2500,
            amountDecimal: -25,
            changes: { category: { from: null, to: 'Shopping' } },
          },
        ],
        scanned: 40,
        truncated: false,
      };
      const client = await connect(
        stubRepos({
          rules: {
            previewEffects: async (filters) => {
              seen = filters;
              return preview;
            },
          },
        }),
      );
      const result = await client.callTool({
        name: 'preview_rule_effects',
        arguments: { uncategorized: true, dateFrom: '2026-01-01' },
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual(preview);
      // The limit is defaulted at the tool boundary, not left for the repo to guess.
      expect(seen).toEqual({ uncategorized: true, dateFrom: '2026-01-01', limit: 100 });
    });

    it('is advertised as a read tool, so it survives the write gate', async () => {
      const { tools } = await (await connect(stubRepos(), false)).listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('preview_rule_effects');
      expect(names).not.toContain('apply_rule_actions');
    });

    it('applies actions to the ids given and reports what changed', async () => {
      let seen: unknown;
      const client = await connect(
        stubRepos({
          rules: {
            applyActions: async (transactionIds, actions) => {
              seen = { transactionIds, actions };
              return { updated: ['t-1'], missing: ['t-9'], errors: [] };
            },
          },
        }),
      );
      const result = await client.callTool({
        name: 'apply_rule_actions',
        arguments: {
          transactionIds: ['t-1', 't-9'],
          actions: [{ op: 'set', field: 'category', value: 'c-1' }],
        },
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual({ updated: ['t-1'], missing: ['t-9'], errors: [] });
      expect(seen).toEqual({
        transactionIds: ['t-1', 't-9'],
        actions: [{ op: 'set', field: 'category', value: 'c-1' }],
      });
    });

    it('refuses a bulk apply larger than the cap', async () => {
      const client = await connect(stubRepos());
      const result = await client.callTool({
        name: 'apply_rule_actions',
        arguments: {
          transactionIds: Array.from({ length: 501 }, (_, i) => `t-${i}`),
          actions: [{ op: 'set', field: 'category', value: 'c-1' }],
        },
      });
      expect(result.isError).toBe(true);
    });

    it('rejects an action whose op is not a real rule action', async () => {
      const client = await connect(stubRepos());
      const result = await client.callTool({
        name: 'apply_rule_actions',
        arguments: { transactionIds: ['t-1'], actions: [{ op: 'drop-table', value: 'x' }] },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('prompts', () => {
    const PROMPT_NAMES = ['explore_budget', 'categorize_transactions', 'cleanup_payees', 'backfill_rule'];

    /** Fetch a prompt's rendered text. */
    async function render(name: string, args: Record<string, string> = {}, enableWrites = true): Promise<string> {
      const client = await connect(stubRepos(), enableWrites);
      const result = await client.getPrompt({ name, arguments: args });
      return (result.messages[0]!.content as { text: string }).text;
    }

    it('advertises every prompt with its arguments', async () => {
      const { prompts } = await (await connect(stubRepos())).listPrompts();
      expect(prompts.map((entry) => entry.name).sort()).toEqual([...PROMPT_NAMES].sort());
      const backfill = prompts.find((entry) => entry.name === 'backfill_rule');
      expect(backfill?.arguments?.map((arg) => arg.name).sort()).toEqual(['goal', 'scope']);
      // Every argument is optional, so none may be advertised as required.
      expect(prompts.flatMap((entry) => entry.arguments ?? []).every((arg) => !arg.required)).toBe(true);
    });

    it('renders when the request omits arguments entirely', async () => {
      // A declared argsSchema otherwise rejects a bare call outright, which is
      // the most natural way for a client to invoke an all-optional prompt.
      const client = await connect(stubRepos());
      for (const name of PROMPT_NAMES) {
        const result = await client.getPrompt({ name });
        expect((result.messages[0]!.content as { text: string }).text.length).toBeGreaterThan(0);
      }
    });

    it('serves every prompt in read-only mode too', async () => {
      const { prompts } = await (await connect(stubRepos(), false)).listPrompts();
      expect(prompts.map((entry) => entry.name).sort()).toEqual([...PROMPT_NAMES].sort());
    });

    it('weaves arguments into the workflow, and asks rather than guessing without them', async () => {
      const filled = await render('backfill_rule', {
        goal: 'categorize Starbucks as Coffee',
        scope: 'since 2026-01-01',
      });
      expect(filled).toContain('The rule I want: categorize Starbucks as Coffee');
      expect(filled).toContain('Limit the backfill to: since 2026-01-01');
      expect(await render('backfill_rule')).toContain('do not guess a rule');
      expect(await render('categorize_transactions')).toContain('Ask me which period to cover');
    });

    it('keeps preview ahead of apply in the rule workflow', async () => {
      const text = await render('backfill_rule');
      expect(text.indexOf('preview_rule_effects')).toBeLessThan(text.indexOf('apply_rule_actions'));
    });

    it('drops the write steps and says so when writes are disabled', async () => {
      for (const [name, tool] of [
        ['backfill_rule', 'apply_rule_actions'],
        ['cleanup_payees', 'merge_payees'],
        ['categorize_transactions', 'update_transaction'],
      ] as const) {
        const text = await render(name, {}, false);
        expect(text).toContain('read-only mode');
        expect(text).not.toContain(tool);
      }
    });

    it('names the write tools when writes are enabled', async () => {
      expect(await render('cleanup_payees')).toContain('merge_payees');
      expect(await render('categorize_transactions')).toContain('update_transaction');
    });

    it('warns against merging transfer payees, which cannot be undone', async () => {
      expect(await render('cleanup_payees')).toContain('transferAccountId');
    });

    it('reports the write gate honestly in the orientation prompt', async () => {
      expect(await render('explore_budget')).toContain('Writes are ENABLED');
      expect(await render('explore_budget', {}, false)).toContain('Writes are DISABLED');
    });
  });

  describe('the write gate', () => {
    const writeTools = [
      'update_transaction',
      'merge_payees',
      'create_rule',
      'set_budget_amount',
      'update_note',
      'create_category_group',
      'update_category_group',
      'apply_rule_actions',
    ];

    it('advertises write tools when writes are enabled', async () => {
      const { tools } = await (await connect(stubRepos(), true)).listTools();
      const names = tools.map((t) => t.name);
      for (const tool of writeTools) {
        expect(names).toContain(tool);
      }
    });

    it('hides every write tool when writes are disabled', async () => {
      const { tools } = await (await connect(stubRepos(), false)).listTools();
      const names = tools.map((t) => t.name);
      for (const tool of writeTools) {
        expect(names).not.toContain(tool);
      }
      // Reads survive the gate.
      expect(names).toContain('list_accounts');
      expect(names).toContain('search_transactions');
      expect(names).toContain('list_category_groups');
    });

    it('refuses to call a write tool that is not registered', async () => {
      const client = await connect(stubRepos(), false);
      const result = await client.callTool({ name: 'merge_payees', arguments: { targetId: 'a', mergeIds: ['b'] } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/merge_payees/);
    });
  });

  describe('tool annotations', () => {
    it('marks reads read-only and writes not', async () => {
      const { tools } = await (await connect(stubRepos())).listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get('list_accounts')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('merge_payees')?.annotations?.readOnlyHint).toBe(false);
      // A merge cannot be re-applied to the same state, so it is destructive.
      expect(byName.get('merge_payees')?.annotations?.destructiveHint).toBe(true);
      // Setting a budget amount twice lands on the same state.
      expect(byName.get('set_budget_amount')?.annotations?.destructiveHint).toBe(false);
    });
  });

  it('gives every tool a unique name, a description, and a schema', () => {
    const tools = enabledTools(stubRepos(), true);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.title).toBeTruthy();
    }
  });
});
