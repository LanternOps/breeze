import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { ExtensionJobDefinition } from '@breeze/extension-sdk';
import type { StagedExtensionContributions } from './contributionRegistry';
import { ExtensionJobHost, type JobHostQueue } from './jobHost';

function makeSnapshot(
  name: string,
  jobs: Record<string, ExtensionJobDefinition>,
): StagedExtensionContributions {
  return {
    name,
    version: '1.0.0',
    manifest: {} as StagedExtensionContributions['manifest'],
    routeApp: null,
    jobs: new Map(Object.entries(jobs)),
    aiTools: new Map(),
    enabled: true,
  };
}

function makeRegistry(snapshots: StagedExtensionContributions[]) {
  const byName = new Map(snapshots.map((s) => [s.name, s] as const));
  return {
    get: (name: string) => byName.get(name),
    listActive: () => [...byName.values()],
  };
}

const asJob = (data: unknown): Job => ({ data } as unknown as Job);

describe('ExtensionJobHost.process', () => {
  it('skips a claimed BullMQ job after disable while allowing an in-flight handler to finish', async () => {
    const handler = vi.fn(async () => {});
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '* * * * *', handler } }),
    ]);
    const state = { isEnabled: vi.fn<(name: string) => Promise<boolean>>() };
    state.isEnabled.mockResolvedValue(false);
    const host = new ExtensionJobHost({ registry, store: state });

    await host.process(asJob({ extension: 'demo', job: 'sweep' }));

    expect(handler).not.toHaveBeenCalled();
    expect(state.isEnabled).toHaveBeenCalledWith('demo');
  });

  it('runs the handler and records a success outcome when enabled', async () => {
    const handler = vi.fn(async () => {});
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '* * * * *', handler } }),
    ]);
    const state = { isEnabled: vi.fn(async () => true) };
    const recordJob = vi.fn();
    const host = new ExtensionJobHost({ registry, store: state, recordJob });

    await host.process(asJob({ extension: 'demo', job: 'sweep' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(recordJob).toHaveBeenCalledWith('demo', 'sweep', 'success', expect.any(Number));
  });

  it('lets handler errors propagate to BullMQ and records a failure outcome', async () => {
    const boom = new Error('job exploded');
    const handler = vi.fn(async () => { throw boom; });
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '* * * * *', handler } }),
    ]);
    const state = { isEnabled: vi.fn(async () => true) };
    const recordJob = vi.fn();
    const host = new ExtensionJobHost({ registry, store: state, recordJob });

    await expect(host.process(asJob({ extension: 'demo', job: 'sweep' }))).rejects.toBe(boom);
    expect(recordJob).toHaveBeenCalledWith('demo', 'sweep', 'failure', expect.any(Number));
  });

  it('is a no-op for an unknown extension or job (never throws, never records)', async () => {
    const registry = makeRegistry([]);
    const state = { isEnabled: vi.fn(async () => true) };
    const recordJob = vi.fn();
    const host = new ExtensionJobHost({ registry, store: state, recordJob });

    await host.process(asJob({ extension: 'ghost', job: 'sweep' }));

    expect(state.isEnabled).not.toHaveBeenCalled();
    expect(recordJob).not.toHaveBeenCalled();
  });
});

describe('ExtensionJobHost.sync', () => {
  function makeFakeQueue(
    existing: Array<{ key: string; name: string; id: string | null; pattern?: string | null }>,
  ) {
    const removed: string[] = [];
    const added: Array<{ name: string; data: unknown; opts: any }> = [];
    const queue: JobHostQueue = {
      getRepeatableJobs: async () => existing,
      removeRepeatableByKey: async (key: string) => { removed.push(key); return true; },
      add: async (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data, opts });
        return {};
      },
    };
    return { queue, removed, added };
  }

  it('removes stale repeatables and adds the current desired set', async () => {
    const handler = vi.fn(async () => {});
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '0 * * * *', handler } }),
    ]);
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, removed, added } = makeFakeQueue([
      // stale: an extension job that is no longer desired
      { key: 'stale-key', name: 'old', id: 'extension-demo-old' },
      // a non-extension repeatable that must be left untouched
      { key: 'core-key', name: 'core', id: 'audit-log-retention' },
    ]);

    await host.sync(queue);

    expect(removed).toEqual(['stale-key']);
    expect(added).toHaveLength(1);
    const [scheduled] = added;
    if (!scheduled) throw new Error('expected exactly one scheduled repeatable');
    expect(scheduled.name).toBe('sweep');
    expect(scheduled.data).toEqual({ extension: 'demo', job: 'sweep' });
    expect(scheduled.opts.jobId).toBe('extension-demo-sweep');
    expect(scheduled.opts.repeat).toEqual({ pattern: '0 * * * *' });
  });

  // BullMQ keys a repeatable by its FULL option set (name:jobId:endDate:tz:pattern),
  // so a cron change mints a new key while the old entry keeps firing. Matching on
  // jobId alone left both schedules live — the job then ran on both patterns forever.
  it('replaces a same-id repeatable whose cron pattern changed instead of duplicating it', async () => {
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '*/5 * * * *', handler: vi.fn() } }),
    ]);
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, removed, added } = makeFakeQueue([
      {
        key: 'sweep:extension-demo-sweep:::0 * * * *',
        name: 'sweep',
        id: 'extension-demo-sweep',
        pattern: '0 * * * *',
      },
    ]);

    await host.sync(queue);

    expect(removed).toEqual(['sweep:extension-demo-sweep:::0 * * * *']);
    expect(added).toHaveLength(1);
    const [scheduled] = added;
    if (!scheduled) throw new Error('expected exactly one scheduled repeatable');
    expect(scheduled.opts.jobId).toBe('extension-demo-sweep');
    expect(scheduled.opts.repeat).toEqual({ pattern: '*/5 * * * *' });
  });

  it('replaces a renamed repeatable that kept the same jobId', async () => {
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '0 * * * *', handler: vi.fn() } }),
    ]);
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, removed, added } = makeFakeQueue([
      { key: 'old-name-key', name: 'sweep-old', id: 'extension-demo-sweep', pattern: '0 * * * *' },
    ]);

    await host.sync(queue);

    expect(removed).toEqual(['old-name-key']);
    expect(added).toHaveLength(1);
  });

  it('keeps an unchanged owned repeatable and never touches foreign ones', async () => {
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '0 * * * *', handler: vi.fn() } }),
    ]);
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, removed } = makeFakeQueue([
      { key: 'current-key', name: 'sweep', id: 'extension-demo-sweep', pattern: '0 * * * *' },
      { key: 'core-key', name: 'audit-log-retention', id: 'audit-log-retention', pattern: '7 * * * *' },
    ]);

    await host.sync(queue);

    expect(removed).toEqual([]);
  });

  it('drives sync from the active registry snapshot when none is passed', async () => {
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '*/5 * * * *', handler: vi.fn() } }),
    ]);
    const listSpy = vi.spyOn(registry, 'listActive');
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, added } = makeFakeQueue([]);

    await host.sync(queue);

    expect(listSpy).toHaveBeenCalled();
    expect(added).toHaveLength(1);
  });
});
