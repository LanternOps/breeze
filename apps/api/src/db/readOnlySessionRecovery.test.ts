import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('./index', () => ({
  db: { execute },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./requestDatabaseConfig', () => ({
  resolveRequestDatabaseConfig: () => ({ url: 'postgres://example.invalid/db' }),
}));

import { isPoolObservedReadOnly, notePoolReadOnly, notePoolWritable } from './readOnlyDatabase';
import {
  createReadOnlySessionRecovery,
  probeRequestPool,
  READ_ONLY_SESSION_RECOVERY_INTERVAL_MS,
  startReadOnlySessionRecovery,
  stopReadOnlySessionRecovery,
  type ReadOnlySessionRecoveryDeps,
} from './readOnlySessionRecovery';

function harness(overrides: Partial<ReadOnlySessionRecoveryDeps> = {}) {
  let now = 0;
  const deps: ReadOnlySessionRecoveryDeps = {
    probePool: vi.fn(async () => ({ readOnly: false, applicationName: 'breeze-api' })),
    probeFreshSession: vi.fn(async () => ({ readOnly: true, checkedAt: '2026-11-14T00:00:00Z' })),
    recycleSessionsOpenedBefore: vi.fn(async () => ({ terminated: 0, remaining: 0 })),
    now: () => now,
    ...overrides,
  };
  const recovery = createReadOnlySessionRecovery(deps, {
    maxRecoveryMs: 10_000,
    freshProbeBackoffAfterMs: 60_000,
    freshProbeBackoffEvery: 3,
  });
  return { deps, recovery, advance: (ms: number) => { now += ms; } };
}

describe('createReadOnlySessionRecovery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only probes the pool while the pool is writable', async () => {
    const { deps, recovery } = harness();
    await recovery.tick();
    await recovery.tick();
    expect(deps.probePool).toHaveBeenCalledTimes(2);
    expect(deps.probeFreshSession).not.toHaveBeenCalled();
    expect(deps.recycleSessionsOpenedBefore).not.toHaveBeenCalled();
    expect(recovery.state()).toBe('watching');
  });

  it('does nothing while a fresh session is read-only too (the database really is read-only)', async () => {
    const { deps, recovery } = harness({
      probePool: vi.fn(async () => ({ readOnly: true, applicationName: 'breeze-api' })),
    });
    await recovery.tick(); // pool read-only -> watch fresh sessions
    expect(recovery.state()).toBe('read-only');
    await recovery.tick();
    await recovery.tick();
    expect(deps.probeFreshSession).toHaveBeenCalledTimes(2);
    expect(deps.recycleSessionsOpenedBefore).not.toHaveBeenCalled();
    expect(recovery.state()).toBe('read-only');
  });

  it('recycles sessions opened before the database became writable, until none is left', async () => {
    const recycle = vi.fn()
      .mockResolvedValueOnce({ terminated: 4, remaining: 6 })
      .mockResolvedValueOnce({ terminated: 2, remaining: 2 })
      .mockResolvedValueOnce({ terminated: 0, remaining: 0 });
    const { deps, recovery } = harness({
      probePool: vi.fn(async () => ({ readOnly: true, applicationName: 'breeze-api' })),
      probeFreshSession: vi.fn(async () => ({ readOnly: false, checkedAt: '2026-11-14T01:02:03Z' })),
      recycleSessionsOpenedBefore: recycle,
    });

    await recovery.tick(); // pool read-only
    await recovery.tick(); // fresh session writable -> first recycle pass
    expect(recovery.state()).toBe('recovering');
    expect(recycle).toHaveBeenLastCalledWith('breeze-api', '2026-11-14T01:02:03Z');
    await recovery.tick();
    expect(recovery.state()).toBe('recovering');
    await recovery.tick();
    expect(recovery.state()).toBe('watching');
    expect(recycle).toHaveBeenCalledTimes(3);
    // The cutoff never moves: a session opened after recovery is never touched.
    for (const call of recycle.mock.calls) expect(call).toEqual(['breeze-api', '2026-11-14T01:02:03Z']);
    expect(deps.probeFreshSession).toHaveBeenCalledTimes(1);
  });

  it('gives up after the recovery window (max_lifetime recycles the rest)', async () => {
    const recycle = vi.fn(async () => ({ terminated: 0, remaining: 1 }));
    const { recovery, advance } = harness({
      probePool: vi.fn(async () => ({ readOnly: true, applicationName: 'breeze-api' })),
      probeFreshSession: vi.fn(async () => ({ readOnly: false, checkedAt: 't' })),
      recycleSessionsOpenedBefore: recycle,
    });
    await recovery.tick();
    await recovery.tick();
    advance(5_000);
    await recovery.tick();
    expect(recovery.state()).toBe('recovering');
    advance(6_000);
    await recovery.tick();
    expect(recovery.state()).toBe('watching');
  });

  it('survives a failing probe and never overlaps two ticks', async () => {
    let release: () => void = () => {};
    const probePool = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockImplementationOnce(() => new Promise((resolve) => {
        release = () => resolve({ readOnly: false, applicationName: 'breeze-api' });
      }));
    const { recovery } = harness({ probePool });

    await expect(recovery.tick()).resolves.toBeUndefined();
    expect(recovery.state()).toBe('watching');

    const first = recovery.tick();
    await recovery.tick(); // skipped: the first is still running
    expect(probePool).toHaveBeenCalledTimes(2);
    release();
    await first;
  });

  it('ends the recovery window even when every recycle pass fails', async () => {
    const { recovery, advance } = harness({
      probePool: vi.fn(async () => ({ readOnly: true, applicationName: 'breeze-api' })),
      probeFreshSession: vi.fn(async () => ({ readOnly: false, checkedAt: 't' })),
      recycleSessionsOpenedBefore: vi.fn(async () => {
        throw new Error('permission denied for function pg_terminate_backend');
      }),
    });
    await recovery.tick();
    await recovery.tick();
    expect(recovery.state()).toBe('recovering');
    advance(11_000);
    await recovery.tick();
    expect(recovery.state()).toBe('watching');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('pg_terminate_backend'));
  });

  it('re-logs a persistent failure every 20 ticks, not every tick', async () => {
    const { recovery } = harness({
      probePool: vi.fn(async () => { throw new Error('connection refused'); }),
    });
    for (let i = 0; i < 40; i++) await recovery.tick();
    const lines = vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes('connection refused'));
    expect(lines).toHaveLength(3); // ticks 1, 20, 40
  });

  it('backs the fresh-session check off when the database stays read-only (a standby)', async () => {
    const { deps, recovery, advance } = harness({
      probePool: vi.fn(async () => ({ readOnly: true, applicationName: 'breeze-api' })),
    });
    await recovery.tick(); // -> read-only
    for (let i = 0; i < 3; i++) await recovery.tick();
    expect(deps.probeFreshSession).toHaveBeenCalledTimes(3);
    advance(60_000);
    for (let i = 0; i < 6; i++) await recovery.tick();
    expect(deps.probeFreshSession).toHaveBeenCalledTimes(5); // every 3rd tick now
  });
});

// #11741 review: the monitor owns the "pool observed read-only" flag that
// gates the log throttle.
describe('createReadOnlySessionRecovery pool read-only flag', () => {
  beforeEach(() => {
    notePoolWritable();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    notePoolWritable();
    vi.restoreAllMocks();
  });

  it('sets the flag when a pooled session reads read-only, keeps it through recovery, clears it when done', async () => {
    const recycle = vi.fn()
      .mockResolvedValueOnce({ terminated: 1, remaining: 1 })
      .mockResolvedValueOnce({ terminated: 1, remaining: 0 });
    const probeFreshSession = vi.fn()
      .mockResolvedValueOnce({ readOnly: true, checkedAt: 't0' })
      .mockResolvedValue({ readOnly: false, checkedAt: 't1' });
    const { recovery } = harness({
      probePool: vi.fn(async () => ({ readOnly: true, applicationName: 'breeze-api' })),
      probeFreshSession,
      recycleSessionsOpenedBefore: recycle,
    });
    expect(isPoolObservedReadOnly()).toBe(false);
    await recovery.tick(); // pool read-only
    expect(isPoolObservedReadOnly()).toBe(true);
    await recovery.tick(); // fresh session still read-only
    expect(isPoolObservedReadOnly()).toBe(true);
    await recovery.tick(); // fresh writable -> recovering, 1 stale session left
    expect(recovery.state()).toBe('recovering');
    expect(isPoolObservedReadOnly()).toBe(true);
    await recovery.tick(); // none left
    expect(recovery.state()).toBe('watching');
    expect(isPoolObservedReadOnly()).toBe(false);
  });

  it('clears the flag when the recovery window expires', async () => {
    const { recovery, advance } = harness({
      probePool: vi.fn(async () => ({ readOnly: true, applicationName: 'breeze-api' })),
      probeFreshSession: vi.fn(async () => ({ readOnly: false, checkedAt: 't' })),
      recycleSessionsOpenedBefore: vi.fn(async () => ({ terminated: 0, remaining: 1 })),
    });
    await recovery.tick();
    await recovery.tick();
    expect(isPoolObservedReadOnly()).toBe(true);
    advance(11_000);
    await recovery.tick();
    expect(recovery.state()).toBe('watching');
    expect(isPoolObservedReadOnly()).toBe(false);
  });

  it('a watching tick that reads a writable pooled session clears a flag set elsewhere (readiness)', async () => {
    notePoolReadOnly();
    const { recovery } = harness();
    await recovery.tick();
    expect(recovery.state()).toBe('watching');
    expect(isPoolObservedReadOnly()).toBe(false);
  });

  it('a failing probe leaves the flag as it was', async () => {
    notePoolReadOnly();
    const { recovery } = harness({ probePool: vi.fn(async () => { throw new Error('connection refused'); }) });
    await recovery.tick();
    expect(isPoolObservedReadOnly()).toBe(true);
  });
});

describe('probeRequestPool', () => {
  it('reads both result shapes and names the pool\'s application_name', async () => {
    execute.mockResolvedValueOnce([{ ro: 'on', app: 'breeze-api' }]);
    await expect(probeRequestPool()).resolves.toEqual({ readOnly: true, applicationName: 'breeze-api' });
    execute.mockResolvedValueOnce({ rows: [{ ro: 'off', app: 'breeze-api' }] });
    await expect(probeRequestPool()).resolves.toEqual({ readOnly: false, applicationName: 'breeze-api' });
  });

  it('throws on an unexpected shape instead of reading it as writable', async () => {
    execute.mockResolvedValueOnce([]);
    await expect(probeRequestPool()).rejects.toThrow('unexpected result shape');
  });
});

describe('startReadOnlySessionRecovery', () => {
  afterEach(() => {
    stopReadOnlySessionRecovery();
    vi.useRealTimers();
  });

  it('starts one timer however often it is called, and stop clears it', () => {
    vi.useFakeTimers();
    expect(startReadOnlySessionRecovery()).toBe(READ_ONLY_SESSION_RECOVERY_INTERVAL_MS);
    startReadOnlySessionRecovery();
    expect(vi.getTimerCount()).toBe(1);
    stopReadOnlySessionRecovery();
    expect(vi.getTimerCount()).toBe(0);
  });
});
