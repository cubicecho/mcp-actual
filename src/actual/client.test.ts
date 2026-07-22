import { describe, expect, it, vi } from 'vitest';

const sync = vi.fn(async () => undefined);
const init = vi.fn(async () => ({ send: vi.fn() }));
const downloadBudget = vi.fn(async () => undefined);
const shutdown = vi.fn(async () => undefined);

vi.mock('@actual-app/api', () => ({
  init: (...args: unknown[]) => init(...(args as [])),
  downloadBudget: (...args: unknown[]) => downloadBudget(...(args as [])),
  sync: () => sync(),
  shutdown: () => shutdown(),
}));

const { ActualClient } = await import('./client.ts');
const { loadConfig } = await import('../config.ts');

function client(timeoutMs: number) {
  return new ActualClient(
    loadConfig({
      ACTUAL_SERVER_URL: 'https://budget.example.com',
      ACTUAL_PASSWORD: 'hunter2',
      ACTUAL_SYNC_ID: 'sync-1',
      MCP_ACTUAL_TOKEN: 'token',
      DATA_DIR: '/tmp/claude-1000/client-test-data',
      ACTUAL_TIMEOUT_MS: String(timeoutMs),
    }),
  );
}

const never = () => new Promise<never>(() => {});

describe('ActualClient timeouts', () => {
  it('rejects the caller once the deadline passes', async () => {
    await expect(client(1000).run(never)).rejects.toThrow(/timed out after 1000ms/);
  });

  it('does not start the next operation while the stalled one is still running', async () => {
    // The library takes no AbortSignal, so a timed-out call is still touching
    // the shared budget. Starting the next one would break the serialization
    // this class exists to provide — worse than the timeout it is recovering
    // from. The queued call must fail fast instead.
    const c = client(1000);
    await expect(c.run(never)).rejects.toThrow(/timed out/);
    let started = false;
    await expect(
      c.run(async () => {
        started = true;
      }),
    ).rejects.toThrow(/not responding/);
    expect(started).toBe(false);
  });

  it('recovers once the stalled operation finally settles', async () => {
    const c = client(1000);
    let release: () => void = () => {};
    const slow = c.run(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(slow).rejects.toThrow(/timed out/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(c.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('honours a per-call timeout over the configured default', async () => {
    // Bank sync is legitimately slow and passes its own, longer deadline.
    await expect(client(60_000).run(never, { timeoutMs: 1000 })).rejects.toThrow(/timed out after 1000ms/);
  });

  it('leaves ordinary calls untouched', async () => {
    await expect(client(5000).read(async () => 'value')).resolves.toBe('value');
    expect(sync).toHaveBeenCalled();
  });

  it('does not count queue wait against a later operation’s deadline', async () => {
    // The deadline measures execution time, not time spent waiting in the
    // serialized queue. A first op that runs close to (but under) its limit
    // must not consume a queued second op's budget while it waits — timing from
    // enqueue would spuriously time out B and trip the stalled latch.
    // 1000ms is the smallest configurable deadline. A runs ~900ms (under it);
    // B queues behind A and needs ~900ms of its own. Timing from enqueue would
    // give B ~100ms before its timer fired → spurious timeout; timing from
    // execution gives B its full budget once it starts.
    const c = client(1000);
    const a = c.run(() => new Promise((resolve) => setTimeout(() => resolve('a'), 900)));
    const b = c.run(() => new Promise((resolve) => setTimeout(() => resolve('b'), 900)));
    expect(await a).toBe('a');
    expect(await b).toBe('b');
  });
});
