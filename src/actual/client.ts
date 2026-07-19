import { mkdir } from 'node:fs/promises';
import * as api from '@actual-app/api';
import type { Config } from '../config.ts';
import { errorChainMessage } from '../errors.ts';

/** One account plus its current balance, in the shape the MCP tool returns. */
export interface AccountBalance {
  id: string;
  name: string;
  /** Balance in minor units (cents) — Actual's native integer representation. */
  balance: number;
  /** The same balance as a decimal number of currency units, for display. */
  balanceDecimal: number;
  /** Tracking (off-budget) accounts are excluded from the budget's available funds. */
  offBudget: boolean;
  closed: boolean;
}

/** Accounts plus a total, so an agent does not have to sum them itself. */
export interface AccountBalances {
  accounts: AccountBalance[];
  /** Sum of the on-budget, non-closed accounts — Actual's headline "balance". */
  onBudgetTotal: number;
  /** Sum of every non-closed account, on- and off-budget. */
  total: number;
}

/**
 * The account shape the API hands back, derived from `getAccounts` rather than
 * imported — the entity type lives behind a deep `@actual-app/core` path that
 * is not part of the API package's public surface.
 */
type RawAccount = Awaited<ReturnType<typeof api.getAccounts>>[number];

/**
 * What the MCP layer needs from the client — narrower than {@link ActualClient}
 * so tools can be exercised against a stub without an Actual server.
 */
export interface AccountBalanceSource {
  getAccountBalances(): Promise<AccountBalances>;
}

/**
 * `@actual-app/api` is a process-wide singleton: `init` opens one SQLite budget
 * and every other call reads that global state, so two overlapping calls would
 * race. This client owns that global, initializes it lazily on first use, and
 * serializes every operation through a promise chain.
 */
export class ActualClient implements AccountBalanceSource {
  private readonly config: Config;
  /** Resolves once `init` + `downloadBudget` have succeeded; retried on failure. */
  private ready: Promise<void> | null = null;
  /** Tail of the serialized operation queue — every `run` links onto it. */
  private queue: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;

  constructor(config: Config) {
    this.config = config;
  }

  /** Open the budget eagerly (at startup) so misconfiguration surfaces before the first tool call. */
  async init(): Promise<void> {
    await this.run(async () => {});
  }

  /**
   * Every account with its current balance. Syncs first so the numbers reflect
   * what other Actual clients have written since the budget was downloaded.
   */
  async getAccountBalances(): Promise<AccountBalances> {
    return this.run(async () => {
      await api.sync();
      const raw: RawAccount[] = await api.getAccounts();
      const accounts: AccountBalance[] = [];
      for (const account of raw) {
        const balance = await api.getAccountBalance(account.id);
        accounts.push({
          id: account.id,
          name: account.name,
          balance,
          balanceDecimal: api.utils.integerToAmount(balance),
          offBudget: Boolean(account.offbudget),
          closed: Boolean(account.closed),
        });
      }
      const open = accounts.filter((a) => !a.closed);
      return {
        accounts,
        onBudgetTotal: open.filter((a) => !a.offBudget).reduce((sum, a) => sum + a.balance, 0),
        total: open.reduce((sum, a) => sum + a.balance, 0),
      };
    });
  }

  /** Close the budget and release the API's resources. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    // Drain the queue first so we never shut the API down mid-operation.
    await this.queue.catch(() => {});
    if (this.ready) {
      await api.shutdown().catch(() => {});
      this.ready = null;
    }
  }

  /** Serialize `fn` behind every earlier operation, ensuring the budget is open first. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.shuttingDown) {
        throw new Error('Actual client is shutting down');
      }
      await this.ensureReady();
      return fn();
    });
    // Keep the chain alive after a rejection — one failed call must not wedge the queue.
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * Connect to the sync server and open the budget, once. A failed attempt
   * clears the memo so the next call retries — the server is often just
   * temporarily unreachable.
   */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.open().catch((err: unknown) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  private async open(): Promise<void> {
    const { dataDir, serverUrl, password, syncId, encryptionPassword } = this.config;
    await mkdir(dataDir, { recursive: true });
    try {
      await api.init({ dataDir, serverURL: serverUrl, password });
    } catch (cause) {
      throw new Error(`Failed to connect to the Actual server at ${serverUrl}: ${errorChainMessage(cause)}`, { cause });
    }
    try {
      await api.downloadBudget(syncId, encryptionPassword ? { password: encryptionPassword } : undefined);
    } catch (cause) {
      // Shut the half-open API down so the next attempt starts from a clean slate.
      await api.shutdown().catch(() => {});
      throw new Error(`Failed to open budget "${syncId}": ${errorChainMessage(cause)}`, { cause });
    }
  }
}
