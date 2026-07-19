import type { ActualRepos } from '../../actual/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

export function accountTools(repos: Pick<ActualRepos, 'accounts'>): ToolDefinition[] {
  return [
    defineTool({
      name: 'list_accounts',
      title: 'List accounts and balances',
      description:
        'List every account in the Actual Budget file with its current balance. Returns each account’s id, ' +
        'name, balance (in cents as `amount` and as a decimal in `amountDecimal`), whether it is off-budget (a ' +
        'tracking account), and whether it is closed — plus `onBudgetTotal` (open on-budget accounts) and ' +
        '`total` (all open accounts). The budget is synced with the server before reading, so balances are current.',
      inputSchema: {},
      run: () => repos.accounts.listWithBalances(),
    }),
  ] as ToolDefinition[];
}
