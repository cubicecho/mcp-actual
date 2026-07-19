import { mkdir } from 'node:fs/promises';
import * as api from '@actual-app/api';
import type { Config } from '../config.ts';
import { errorChainMessage } from '../errors.ts';

/**
 * `@actual-app/api` is a process-wide singleton: `init` opens one SQLite budget
 * and every other call reads that global state, so two overlapping calls would
 * race. This client owns that global, opens the budget lazily on first use, and
 * serializes every operation through a promise chain.
 *
 * It deliberately knows nothing about accounts, payees, or rules — the domain
 * repositories in this directory build on {@link ActualClient.run}, and nothing
 * outside `src/actual/` touches the library at all.
 */
export class ActualClient {
  private readonly config: Config;
  /** Resolves once `init` + `downloadBudget` have succeeded; cleared on failure so the next call retries. */
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
   * Run `fn` with the budget open, serialized behind every earlier operation.
   * All Actual access goes through here — calling the library concurrently
   * would race on the one open budget.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
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
