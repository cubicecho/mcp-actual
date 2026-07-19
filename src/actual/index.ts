import { type AccountsRepo, createAccountsRepo } from './accounts.ts';
import { type BudgetsRepo, createBudgetsRepo } from './budgets.ts';
import type { ActualClient } from './client.ts';
import { type ContextRepo, createContextRepo } from './context.ts';
import { createPayeesRepo, type PayeesRepo } from './payees.ts';
import { createRulesRepo, type RulesRepo } from './rules.ts';
import { createTransactionsRepo, type TransactionsRepo } from './transactions.ts';

/**
 * Everything the MCP layer may do to a budget, grouped by domain. Tools depend
 * on the individual repos (or on narrower slices of them), never on
 * {@link ActualClient} itself — that keeps them testable against plain stubs
 * with no Actual server in the loop.
 */
export interface ActualRepos {
  accounts: AccountsRepo;
  budgets: BudgetsRepo;
  context: ContextRepo;
  payees: PayeesRepo;
  rules: RulesRepo;
  transactions: TransactionsRepo;
}

export function createRepos(client: ActualClient): ActualRepos {
  return {
    accounts: createAccountsRepo(client),
    budgets: createBudgetsRepo(client),
    context: createContextRepo(client),
    payees: createPayeesRepo(client),
    rules: createRulesRepo(client),
    transactions: createTransactionsRepo(client),
  };
}

export { ActualClient } from './client.ts';
export type * from './types.ts';
