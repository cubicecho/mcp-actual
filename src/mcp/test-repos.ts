import type { ActualRepos } from '../actual/index.ts';

/** Every repo method stubbed to reject, so a test only wires up what it exercises. */
function unimplemented(name: string) {
  return () => Promise.reject(new Error(`${name} not stubbed in this test`));
}

/**
 * Build a full {@link ActualRepos} whose methods all fail, overridden by
 * `overrides`. Tools depend on repos rather than on `ActualClient`, so tool
 * tests need no Actual server at all.
 */
export function stubRepos(overrides: Partial<{ [K in keyof ActualRepos]: Partial<ActualRepos[K]> }> = {}): ActualRepos {
  const base: ActualRepos = {
    accounts: { listWithBalances: unimplemented('accounts.listWithBalances') },
    budgets: {
      listMonths: unimplemented('budgets.listMonths'),
      getMonth: unimplemented('budgets.getMonth'),
      setAmount: unimplemented('budgets.setAmount'),
      setCarryover: unimplemented('budgets.setCarryover'),
      holdForNextMonth: unimplemented('budgets.holdForNextMonth'),
      resetHold: unimplemented('budgets.resetHold'),
      listCategories: unimplemented('budgets.listCategories'),
      createCategory: unimplemented('budgets.createCategory'),
      updateCategory: unimplemented('budgets.updateCategory'),
      listCategoryGroups: unimplemented('budgets.listCategoryGroups'),
      createCategoryGroup: unimplemented('budgets.createCategoryGroup'),
      updateCategoryGroup: unimplemented('budgets.updateCategoryGroup'),
    },
    context: {
      resolveNameToId: unimplemented('context.resolveNameToId'),
      listSchedules: unimplemented('context.listSchedules'),
      listTags: unimplemented('context.listTags'),
      getNote: unimplemented('context.getNote'),
      updateNote: unimplemented('context.updateNote'),
      sync: unimplemented('context.sync'),
      runBankSync: unimplemented('context.runBankSync'),
      serverVersion: unimplemented('context.serverVersion'),
    },
    payees: {
      list: unimplemented('payees.list'),
      findDuplicates: unimplemented('payees.findDuplicates'),
      merge: unimplemented('payees.merge'),
      update: unimplemented('payees.update'),
      create: unimplemented('payees.create'),
    },
    rules: {
      list: unimplemented('rules.list'),
      create: unimplemented('rules.create'),
      update: unimplemented('rules.update'),
      previewEffects: unimplemented('rules.previewEffects'),
      applyActions: unimplemented('rules.applyActions'),
    },
    transactions: {
      search: unimplemented('transactions.search'),
      listForAccount: unimplemented('transactions.listForAccount'),
      update: unimplemented('transactions.update'),
    },
  };

  for (const [domain, methods] of Object.entries(overrides)) {
    Object.assign(base[domain as keyof ActualRepos], methods);
  }
  return base;
}
