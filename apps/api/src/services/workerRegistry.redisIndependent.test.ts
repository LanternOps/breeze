// #7105 item 4 — when Redis is down at boot, index.ts skips every BullMQ
// worker. Entries flagged `runsWithoutRedis` still get started through their
// `startWithoutRedis` fallback, and their shutdown is still registered.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_REGISTRY,
  _buildShutdownTasksForTest,
  _resetLoadedShutdownsForTest,
  _startRedisIndependentWorkersForTest,
  type WorkerRegistration,
} from './workerRegistry';

describe('startRedisIndependentWorkers (#7105)', () => {
  beforeEach(() => {
    _resetLoadedShutdownsForTest();
  });

  it('starts only runsWithoutRedis entries, via startWithoutRedis (never init), and registers their shutdown', async () => {
    const fallback = vi.fn();
    const init = vi.fn();
    const shutdown = vi.fn(async () => {});
    const otherLoad = vi.fn();
    const entries: WorkerRegistration[] = [
      {
        name: 'reaper', placement: 'socket-owner', runsWithoutRedis: true,
        load: async () => ({ init, shutdown, startWithoutRedis: fallback }),
      },
      { name: 'queueOnly', placement: 'socket-owner', load: otherLoad },
    ];
    const onResult = vi.fn();

    await _startRedisIndependentWorkersForTest(entries, 'all', { onResult });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(init).not.toHaveBeenCalled();
    expect(otherLoad).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith('reaper', true);
    expect(await _buildShutdownTasksForTest(entries, 'all')).toEqual([shutdown]);
  });

  it('honours role placement', async () => {
    const fallback = vi.fn();
    const entries: WorkerRegistration[] = [{
      name: 'reaper', placement: 'socket-owner', runsWithoutRedis: true,
      load: async () => ({ init: vi.fn(), startWithoutRedis: fallback }),
    }];

    await _startRedisIndependentWorkersForTest(entries, 'worker', { onResult: vi.fn() });

    expect(fallback).not.toHaveBeenCalled();
  });

  it('reports a flagged entry that exports no fallback as a failure, never silently skips it', async () => {
    const entries: WorkerRegistration[] = [{
      name: 'broken', placement: 'global', runsWithoutRedis: true,
      load: async () => ({ init: vi.fn() }),
    }];
    const onResult = vi.fn();

    await _startRedisIndependentWorkersForTest(entries, 'all', { onResult });

    expect(onResult).toHaveBeenCalledWith('broken', false, expect.any(Error));
  });

  it('reports a fallback that throws as a failure', async () => {
    const boom = new Error('db down too');
    const entries: WorkerRegistration[] = [{
      name: 'reaper', placement: 'global', runsWithoutRedis: true,
      load: async () => ({ init: vi.fn(), startWithoutRedis: () => { throw boom; } }),
    }];
    const onResult = vi.fn();

    await _startRedisIndependentWorkersForTest(entries, 'all', { onResult });

    expect(onResult).toHaveBeenCalledWith('reaper', false, boom);
  });

  it('flags the stale command reaper, and it exports the fallback', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'staleCommandReaper');
    expect(entry?.runsWithoutRedis).toBe(true);
    const mod = await entry!.load();
    expect(typeof mod.startWithoutRedis).toBe('function');
  });
});
