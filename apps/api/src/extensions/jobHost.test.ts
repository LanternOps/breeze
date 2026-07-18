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
      { key: 'stale-key', name: 'old', id: 'extension:demo:old' },
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
    expect(scheduled.opts.jobId).toBe('extension:demo:sweep');
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
        key: 'sweep:extension:demo:sweep:::0 * * * *',
        name: 'sweep',
        id: 'extension:demo:sweep',
        pattern: '0 * * * *',
      },
    ]);

    await host.sync(queue);

    expect(removed).toEqual(['sweep:extension:demo:sweep:::0 * * * *']);
    expect(added).toHaveLength(1);
    const [scheduled] = added;
    if (!scheduled) throw new Error('expected exactly one scheduled repeatable');
    expect(scheduled.opts.jobId).toBe('extension:demo:sweep');
    expect(scheduled.opts.repeat).toEqual({ pattern: '*/5 * * * *' });
  });

  it('replaces a renamed repeatable that kept the same jobId', async () => {
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '0 * * * *', handler: vi.fn() } }),
    ]);
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, removed, added } = makeFakeQueue([
      { key: 'old-name-key', name: 'sweep-old', id: 'extension:demo:sweep', pattern: '0 * * * *' },
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
      { key: 'current-key', name: 'sweep', id: 'extension:demo:sweep', pattern: '0 * * * *' },
      { key: 'core-key', name: 'audit-log-retention', id: 'audit-log-retention', pattern: '7 * * * *' },
    ]);

    await host.sync(queue);

    expect(removed).toEqual([]);
  });

  // A disable landing on replica A never invalidates replica B's in-memory
  // registry, so B's listActive() still reports the extension as enabled. If
  // sync trusted that flag alone, B's next sync (triggered by ANY enable/disable
  // of ANY extension) would re-add the disabled extension's repeatable — and it
  // would tick forever, because nothing ever converges B without a restart.
  it('does not schedule an extension whose durable enabled flag is false, even when the local registry still lists it active', async () => {
    const registry = makeRegistry([
      makeSnapshot('stale-disabled', { sweep: { name: 'sweep', cron: '0 * * * *', handler: vi.fn() } }),
      makeSnapshot('healthy', { tidy: { name: 'tidy', cron: '5 * * * *', handler: vi.fn() } }),
    ]);
    // The stale-replica state: the snapshot says enabled, the database says no.
    expect(registry.listActive().map((s) => s.name))
      .toEqual(['stale-disabled', 'healthy']);
    const isEnabled = vi.fn(async (name: string) => name !== 'stale-disabled');
    const host = new ExtensionJobHost({ registry, store: { isEnabled } });
    const { queue, removed, added } = makeFakeQueue([
      // the disabled extension's repeatable is still in Redis
      { key: 'stale-key', name: 'sweep', id: 'extension:stale-disabled:sweep', pattern: '0 * * * *' },
    ]);

    await host.sync(queue);

    // Removed, not re-added.
    expect(removed).toEqual(['stale-key']);
    expect(added).toHaveLength(1);
    expect(added[0]?.opts.jobId).toBe('extension:healthy:tidy');
  });

  // The mirror image of the test above, and it must hold at the same time.
  // The desired set is derived from THIS replica's registry, so an extension
  // this replica never activated (optional `x`, whose `acquire` hit a transient
  // 503 here while replica A activated it fine) is simply absent from `desired`.
  // If removal keyed on that alone, enabling any UNRELATED extension here would
  // delete `x`'s live repeatable — `x` is enabled in the DB and running on A,
  // yet its cron would never fire again anywhere until A restarts. A lingering
  // foreign repeatable is inert by comparison (`process()` returns early when it
  // can't resolve the definition), so preserving it is strictly safer.
  it('preserves a repeatable for an extension absent from this replica registry, while still removing a present-but-disabled one', async () => {
    const registry = makeRegistry([
      makeSnapshot('y', { tidy: { name: 'tidy', cron: '5 * * * *', handler: vi.fn() } }),
      // present in the registry, but disabled in the database
      makeSnapshot('z', { sweep: { name: 'sweep', cron: '0 * * * *', handler: vi.fn() } }),
    ]);
    const isEnabled = vi.fn(async (name: string) => name !== 'z');
    const host = new ExtensionJobHost({ registry, store: { isEnabled } });
    const { queue, removed, added } = makeFakeQueue([
      // 'x' was never activated on this replica — it is not in the registry at all.
      { key: 'x-key', name: 'sweep', id: 'extension:x:sweep', pattern: '0 * * * *' },
      // 'z' IS in the registry but is disabled: its schedule is genuinely stale.
      { key: 'z-key', name: 'sweep', id: 'extension:z:sweep', pattern: '0 * * * *' },
    ]);

    await host.sync(queue);

    expect(removed).toEqual(['z-key']);
    expect(added.map((a) => a.opts.jobId)).toEqual(['extension:y:tidy']);
  });

  // Extension names AND job names may both contain hyphens, which is exactly
  // why the id separator is ':' (forbidden in both by the manifest schema): the
  // owner of 'extension:acme-billing:nightly-sweep' is recovered by an exact
  // split, with no registry lookup needed to disambiguate.
  it('recovers hyphenated extension names so their stale schedules are still removed', async () => {
    const registry = makeRegistry([
      makeSnapshot('acme-billing', {
        'nightly-sweep': { name: 'nightly-sweep', cron: '0 * * * *', handler: vi.fn() },
      }),
    ]);
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, removed } = makeFakeQueue([
      // same (extension, job) pair, but an outdated cron → stale identity
      {
        key: 'old-cron-key',
        name: 'nightly-sweep',
        id: 'extension:acme-billing:nightly-sweep',
        pattern: '@daily',
      },
    ]);

    await host.sync(queue);

    expect(removed).toEqual(['old-cron-key']);
  });

  // The prefix-search resolver mis-attributed on a hyphen collision: with 'demo'
  // known and 'demo-extra' absent, 'extension-demo-extra-sweep' resolved to
  // owner='demo' (non-null), fell through to `desired.get(id)` === undefined,
  // and DELETED another replica's live schedule — the exact failure the
  // absent-extension guard exists to prevent, surviving in the collision case.
  // An exact ':' split makes the owner 'demo-extra', unknown here, so it is
  // preserved.
  it('preserves a foreign repeatable whose extension name shares a hyphen prefix with a known one', async () => {
    const registry = makeRegistry([
      makeSnapshot('demo', { sweep: { name: 'sweep', cron: '0 * * * *', handler: vi.fn() } }),
    ]);
    const host = new ExtensionJobHost({ registry, store: { isEnabled: vi.fn(async () => true) } });
    const { queue, removed } = makeFakeQueue([
      // owned by 'demo-extra', which this replica does not know at all
      { key: 'foreign-key', name: 'sweep', id: 'extension:demo-extra:sweep', pattern: '0 * * * *' },
      // this replica's own, unchanged
      { key: 'mine-key', name: 'sweep', id: 'extension:demo:sweep', pattern: '0 * * * *' },
    ]);

    await host.sync(queue);

    expect(removed).toEqual([]);
  });

  // Preserving unknown owners means an extension removed from deployment config
  // FLEET-WIDE would keep its cron firing forever. The DB is the one authority
  // that can settle it, and only a POSITIVE absence justifies a removal.
  it('reaps an unknown owner only when the store confirms it has no installed_extensions row', async () => {
    const registry = makeRegistry([]);
    const listAll = vi.fn(async () => [{ name: 'still-installed' } as never]);
    const host = new ExtensionJobHost({
      registry,
      store: { isEnabled: vi.fn(async () => true), listAll },
    });
    const { queue, removed } = makeFakeQueue([
      { key: 'gone-key', name: 'sweep', id: 'extension:long-gone:sweep', pattern: '0 * * * *' },
      { key: 'other-key', name: 'sweep', id: 'extension:still-installed:sweep', pattern: '0 * * * *' },
    ]);

    await host.sync(queue);

    expect(removed).toEqual(['gone-key']);
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it('never reaps an unknown owner when the store read fails (uncertainty preserves)', async () => {
    const registry = makeRegistry([]);
    const host = new ExtensionJobHost({
      registry,
      store: {
        isEnabled: vi.fn(async () => true),
        listAll: vi.fn(async () => { throw new Error('db down'); }),
      },
    });
    const { queue, removed } = makeFakeQueue([
      { key: 'gone-key', name: 'sweep', id: 'extension:long-gone:sweep', pattern: '0 * * * *' },
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
