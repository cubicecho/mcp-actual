import { mkdir } from 'node:fs/promises';
import * as api from '@actual-app/api';
import type { Config } from '../config.ts';
import { errorChainMessage } from '../errors.ts';

/** What `init` hands back — the typed handler channel, among other things. */
type ActualLib = Awaited<ReturnType<typeof api.init>>;

/**
 * Call an Actual server handler by name. This is the supported escape hatch for
 * the handful of operations `@actual-app/api` never re-exports as functions
 * (the rule engine, notably): `send` is typed against `Handlers`, and the old
 * top-level `internal` export is deprecated *in favour of* it.
 *
 * Reach for a named `api.*` function first — this is for what is missing there.
 */
export type ActualSend = ActualLib['send'];

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
  /** `init`'s return value, kept for {@link send}. Null until the budget is open. */
  private lib: ActualLib | null = null;
  /** Memoized shutdown, so concurrent `close` calls await one teardown. */
  private closing: Promise<void> | null = null;
  /** True while an operation has passed its deadline but not yet settled. */
  private stalled = false;

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
  run<T>(fn: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    // Checked before enqueuing, not inside the queued body: while an operation
    // is hung the queue never advances, so a check in there would itself wait
    // out the full deadline and report a timeout instead of the real reason.
    // Failing immediately turns an invisible wait into a legible error.
    if (this.stalled) {
      return Promise.reject(
        new Error(
          'Actual is not responding: a previous operation passed its deadline and has not finished. Every call ' +
            'is serialized behind it, so nothing can run until it does. Restart the server if this persists.',
        ),
      );
    }
    const started = this.queue.then(async () => {
      if (this.shuttingDown) {
        throw new Error('Actual client is shutting down');
      }
      await this.ensureReady();
      return fn();
    });

    // The queue must keep waiting for the *real* operation even after the caller
    // has given up. `@actual-app/api` takes no AbortSignal, so a timed-out call
    // is still running against the shared budget; letting the next one start
    // would break the serialization this class exists to provide.
    this.queue = started.catch(() => {});

    return this.withDeadline(started, timeoutMs);
  }

  /**
   * Reject the caller once `timeoutMs` elapses, while leaving the underlying
   * operation to finish on its own. The client is marked stalled meanwhile, so
   * later calls fail immediately instead of queueing invisibly, and recovers by
   * itself if the operation eventually settles.
   */
  private withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stalled = true;
        reject(new Error(`Actual operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      operation.then(
        (value) => {
          clearTimeout(timer);
          this.stalled = false;
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          this.stalled = false;
          reject(err as Error);
        },
      );
    });
  }

  /**
   * Run `fn` with the budget open **and freshly synced**, serialized like
   * {@link run}. Every tool that reports budget data should use this: other
   * Actual clients write to the same budget, and a tool that reports a stale
   * balance is worse than one that is slightly slower.
   *
   * A sync failure propagates rather than falling back to the cached copy —
   * silently answering from stale data is the failure mode this exists to
   * prevent.
   */
  read<T>(fn: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    return this.run(async () => {
      await api.sync();
      return fn();
    }, options);
  }

  /**
   * The typed handler channel (see {@link ActualSend}). Only valid once the
   * budget is open, so call it **inside** {@link run} — it does not serialize
   * on its own, and reading it before the budget opens throws.
   */
  get send(): ActualSend {
    if (!this.lib) {
      throw new Error('Actual budget is not open — use ActualClient.send inside ActualClient.run');
    }
    return this.lib.send;
  }

  /** Close the budget and release the API's resources. Safe to call more than once. */
  async close(): Promise<void> {
    // Memoized, not short-circuited: a second caller must *await* the first
    // shutdown rather than resolve immediately. Returning early let a second
    // signal run `process.exit(0)` while the budget was still being closed.
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.shuttingDown = true;
    // Drain the queue first so we never shut the API down mid-operation.
    await this.queue.catch(() => {});
    if (this.ready) {
      await api.shutdown().catch(() => {});
      this.ready = null;
      this.lib = null;
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
      // `verbose: false` is load-bearing, not tidiness. loot-core's logger
      // defaults to verbose, `logger.log`/`logger.info` write to **stdout**,
      // and a failed login logs the whole request body — which contains the
      // password — as "API call failed: ... Data: { "password": ... }". The
      // same logger narrates every sync, which on stdio would interleave
      // non-JSON lines into the JSON-RPC stream that stdout *is*. Warnings and
      // errors are not gated by this flag and go to stderr, so nothing
      // diagnostic is lost.
      this.lib = await api.init({ dataDir, serverURL: serverUrl, password, verbose: false });
    } catch (cause) {
      throw new Error(`Failed to connect to the Actual server at ${serverUrl}: ${errorChainMessage(cause)}`, { cause });
    }
    try {
      await api.downloadBudget(syncId, encryptionPassword ? { password: encryptionPassword } : undefined);
    } catch (cause) {
      // Shut the half-open API down so the next attempt starts from a clean slate.
      await api.shutdown().catch(() => {});
      this.lib = null;
      throw new Error(`Failed to open budget "${syncId}": ${errorChainMessage(cause)}`, { cause });
    }
  }
}
