import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDocumentV1 } from '@breeze/shared';
import { effectiveForEachConcurrency, runForEachItems, type ForEachItemResult } from './forEachConcurrent';
import { createUnitSemaphore } from './unitSemaphore';

/**
 * Tool Catalog W05 (#5220) Task A7 / Decision 11 — the bounded parallel
 * for-each coordinator. Items are fake executors with controllable finish
 * order; the run-state writes (empty item patches, one batch checkpoint) are
 * covered in jobs/flowRunner.test.ts.
 */

type Step = FlowDocumentV1['steps'][number];
const step = (over: Partial<Step> = {}): Step => ({
  id: 'each', tool: 'get_device_details', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300,
  forEach: { items: 'inputs.ids', as: 'item', maxItems: 100, concurrency: 5 }, ...over,
} as Step);
const pin = (tier: 1 | 2 | 3) => ({ stepId: 'each', tool: 'get_device_details', source: 'core' as const, tier, approvalScope: null });

afterEach(() => vi.unstubAllEnvs());

/** A controllable item: resolves when `finish(i)` is called. */
function harness(count: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  const started: number[] = [];
  const resolvers = new Map<number, (r: ForEachItemResult) => void>();
  const runItem = (i: number) => new Promise<ForEachItemResult>((resolve) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started.push(i);
    resolvers.set(i, (r) => { inFlight -= 1; resolve(r); });
  });
  const finish = async (i: number, r: ForEachItemResult = { kind: 'done', status: 'completed', output: `out-${i}` }) => {
    resolvers.get(i)!(r);
    await new Promise((res) => setTimeout(res, 0));
  };
  return { runItem, finish, started, get maxInFlight() { return maxInFlight; }, count };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const base = { stopOnFailure: false, settled: () => null, beforeLaunch: async () => 'ok' as const, acquire: createUnitSemaphore(20).acquire };

describe('effectiveForEachConcurrency', () => {
  it('honours concurrency only for tier ≤ 2 and never for wait', () => {
    expect(effectiveForEachConcurrency(step(), pin(1))).toBe(5);
    expect(effectiveForEachConcurrency(step(), pin(2))).toBe(5);
    expect(effectiveForEachConcurrency(step(), pin(3))).toBe(1);
    expect(effectiveForEachConcurrency(step({ tool: 'wait' }), pin(1))).toBe(1);
    expect(effectiveForEachConcurrency(step({ forEach: undefined }), pin(1))).toBe(1);
  });

  it('concurrency is capped by FLOW_FOREACH_MAX_PARALLEL', () => {
    vi.stubEnv('FLOW_FOREACH_MAX_PARALLEL', '3');
    expect(effectiveForEachConcurrency(step(), pin(1))).toBe(3);
    vi.stubEnv('FLOW_FOREACH_MAX_PARALLEL', '10');
    expect(effectiveForEachConcurrency(step({ forEach: { items: 'x', as: 'item', maxItems: 10, concurrency: 8 } }), pin(1))).toBe(8);
  });
});

describe('runForEachItems', () => {
  it('five items with concurrency 5 overlap', async () => {
    const h = harness(5);
    const done = runForEachItems({ ...base, count: 5, parallelism: 5, runItem: h.runItem });
    await tick();
    expect(h.started).toEqual([0, 1, 2, 3, 4]);
    for (const i of [0, 1, 2, 3, 4]) await h.finish(i);
    await done;
    expect(h.maxInFlight).toBe(5);
  });

  it('never more in flight than the parallelism, launched in index order', async () => {
    const h = harness(7);
    const done = runForEachItems({ ...base, count: 7, parallelism: 2, runItem: h.runItem });
    await tick();
    expect(h.started).toEqual([0, 1]);
    await h.finish(1);
    expect(h.started).toEqual([0, 1, 2]);
    for (const i of [0, 2, 3, 4, 5, 6]) { await tick(); await h.finish(i); }
    await done;
    expect(h.maxInFlight).toBe(2);
  });

  it('outputs keep item order when items finish out of order', async () => {
    const h = harness(3);
    const done = runForEachItems({ ...base, count: 3, parallelism: 3, runItem: h.runItem });
    await tick();
    await h.finish(2);
    await h.finish(0);
    await h.finish(1);
    const r = await done;
    expect(r.results.map((x) => (x?.kind === 'done' ? x.output : null))).toEqual(['out-0', 'out-1', 'out-2']);
    expect(r.halted).toBeNull();
  });

  it('stop launches nothing after the first failure and awaits in-flight items', async () => {
    const h = harness(6);
    const done = runForEachItems({ ...base, count: 6, parallelism: 2, stopOnFailure: true, runItem: h.runItem });
    await tick();
    await h.finish(0, { kind: 'failed', terminal: false });
    // Item 1 is still in flight and must finish; nothing new launches.
    expect(h.started).toEqual([0, 1]);
    let settled = false;
    void done.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    await h.finish(1);
    const r = await done;
    expect(h.started).toEqual([0, 1]);
    expect(r.halted).toBe('failure');
    expect(r.results.slice(2)).toEqual([null, null, null, null]);
  });

  it('continue runs every item and reports the failures', async () => {
    const h = harness(4);
    const done = runForEachItems({ ...base, count: 4, parallelism: 2, stopOnFailure: false, runItem: h.runItem });
    await tick();
    await h.finish(0, { kind: 'failed', terminal: false });
    await tick();
    for (const i of [1, 2, 3]) { await h.finish(i); await tick(); }
    const r = await done;
    expect(h.started).toEqual([0, 1, 2, 3]);
    expect(r.halted).toBeNull();
    expect(r.results.map((x) => x?.kind)).toEqual(['failed', 'done', 'done', 'done']);
  });

  it('a terminal failure (policy / unknown outcome) halts even under continue', async () => {
    const h = harness(4);
    const done = runForEachItems({ ...base, count: 4, parallelism: 1, stopOnFailure: false, runItem: h.runItem });
    await tick();
    await h.finish(0, { kind: 'failed', terminal: true });
    const r = await done;
    expect(h.started).toEqual([0]);
    expect(r.halted).toBe('failure');
  });

  it('cancel between launches stops new items', async () => {
    const h = harness(5);
    let checks = 0;
    const done = runForEachItems({
      ...base, count: 5, parallelism: 1, runItem: h.runItem,
      beforeLaunch: async () => (++checks >= 3 ? 'cancelled' : 'ok'),
    });
    await tick();
    await h.finish(0);
    await tick();
    await h.finish(1);
    const r = await done;
    expect(h.started).toEqual([0, 1]);
    expect(r.halted).toBe('cancelled');
  });

  it('resume skips items with settled rows (no re-execution)', async () => {
    const h = harness(4);
    const settled = (i: number): ForEachItemResult | null => (i === 0 || i === 2 ? { kind: 'done', status: 'completed', output: `prev-${i}` } : null);
    const done = runForEachItems({ ...base, count: 4, parallelism: 4, settled, runItem: h.runItem });
    await tick();
    expect(h.started).toEqual([1, 3]);
    await h.finish(1);
    await h.finish(3);
    const r = await done;
    expect(r.results.map((x) => (x?.kind === 'done' ? x.output : null))).toEqual(['prev-0', 'out-1', 'prev-2', 'out-3']);
  });

  it('lost lease mid-batch launches nothing more', async () => {
    const h = harness(5);
    const done = runForEachItems({ ...base, count: 5, parallelism: 2, runItem: h.runItem });
    await tick();
    await h.finish(0, { kind: 'stop' });
    await h.finish(1);
    const r = await done;
    expect(h.started).toEqual([0, 1]);
    expect(r.halted).toBe('stop');
  });

  it('a lease or terminal-run check before a launch stops the batch', async () => {
    const h = harness(3);
    const done = runForEachItems({ ...base, count: 3, parallelism: 3, runItem: h.runItem, beforeLaunch: async () => 'stop' });
    const r = await done;
    expect(h.started).toEqual([]);
    expect(r.halted).toBe('stop');
  });

  it('the process-wide semaphore bounds every batch together', async () => {
    const sem = createUnitSemaphore(3);
    const a = harness(3);
    const b = harness(3);
    const runA = runForEachItems({ ...base, acquire: sem.acquire, count: 3, parallelism: 3, runItem: a.runItem });
    const runB = runForEachItems({ ...base, acquire: sem.acquire, count: 3, parallelism: 3, runItem: b.runItem });
    await tick();
    expect(a.started.length + b.started.length).toBe(3);
    for (const i of [0, 1, 2]) { if (a.started.includes(i)) await a.finish(i); }
    await tick();
    for (const i of [0, 1, 2]) { await tick(); if (b.started.includes(i)) await b.finish(i); }
    await tick();
    for (const i of [0, 1, 2]) { await tick(); if (b.started.includes(i)) { try { await b.finish(i); } catch { /* finished */ } } }
    await Promise.all([runA, runB]);
    expect(sem.inUse()).toBe(0);
  });

  // PR review: a control-check (DB) error must never abandon in-flight items.
  it('a beforeLaunch throw awaits in-flight items before failing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(4);
    let checks = 0;
    const done = runForEachItems({
      ...base, count: 4, parallelism: 2, runItem: h.runItem,
      beforeLaunch: async () => { if (++checks === 3) throw new Error('pool timeout'); return 'ok'; },
    });
    let rejected: unknown = null;
    void done.catch((e) => { rejected = e; });
    await tick();
    await h.finish(0);
    await tick();
    // Item 1 is still in flight: the batch must not have settled yet.
    expect(rejected).toBeNull();
    await h.finish(1);
    await expect(done).rejects.toThrow('pool timeout');
    expect(h.started).toEqual([0, 1]);
    err.mockRestore();
  });

  it('a process slot is taken before the control check, so the check is fresh at launch', async () => {
    const order: string[] = [];
    const sem = createUnitSemaphore(1);
    const r = runForEachItems({
      ...base, count: 1, parallelism: 1,
      acquire: async () => { order.push('acquire'); return sem.acquire(); },
      beforeLaunch: async () => { order.push('check'); return 'ok'; },
      runItem: async () => { order.push('run'); return { kind: 'done', status: 'completed', output: null }; },
    });
    await r;
    expect(order).toEqual(['acquire', 'check', 'run']);
  });

  it('an item that throws is a stop (never an unrecorded success)', async () => {
    const r = await runForEachItems({ ...base, count: 2, parallelism: 1, runItem: async () => { throw new Error('boom'); } });
    expect(r.halted).toBe('stop');
    expect(r.results[0]).toEqual({ kind: 'stop' });
    expect(r.results[1]).toBeNull();
  });
});
