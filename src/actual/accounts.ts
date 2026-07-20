import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import { money } from './money.ts';
import type { AccountBalance, AccountBalances } from './types.ts';

export interface AccountsRepo {
  listWithBalances(): Promise<AccountBalances>;
}

export function createAccountsRepo(client: ActualClient): AccountsRepo {
  return {
    /**
     * Every account with its current balance. Syncs first so the numbers
     * reflect what other Actual clients have written since the last read.
     */
    listWithBalances: () =>
      client.read(async () => {
        const raw = await api.getAccounts();
        const accounts: AccountBalance[] = [];
        for (const account of raw) {
          const balance = await api.getAccountBalance(account.id);
          accounts.push({
            id: account.id,
            name: account.name,
            ...money(balance),
            offBudget: Boolean(account.offbudget),
            closed: Boolean(account.closed),
          });
        }
        const open = accounts.filter((a) => !a.closed);
        return {
          accounts,
          onBudgetTotal: open.filter((a) => !a.offBudget).reduce((sum, a) => sum + a.amount, 0),
          total: open.reduce((sum, a) => sum + a.amount, 0),
        };
      }),
  };
}
