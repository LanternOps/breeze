import { describe, expect, it } from 'vitest';
import { FLOW_RUN_LIMITS } from '@breeze/shared';
import { acquireUnit, createUnitSemaphore } from './unitSemaphore';

/** Tool Catalog W05 (#5220) Task A7 — the process-wide cap on concurrent for-each units. */

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('unit semaphore', () => {
  it('never more than its size, granted FIFO', async () => {
    const sem = createUnitSemaphore(2);
    const order: number[] = [];
    let held = 0;
    let maxHeld = 0;
    const releases: Array<() => void> = [];
    const waiters = [0, 1, 2, 3, 4].map((n) => sem.acquire().then((release) => {
      held += 1;
      maxHeld = Math.max(maxHeld, held);
      order.push(n);
      releases.push(() => { held -= 1; release(); });
    }));
    await tick();
    expect(order).toEqual([0, 1]);
    releases.shift()!();
    await tick();
    expect(order).toEqual([0, 1, 2]);
    while (releases.length) { releases.shift()!(); await tick(); }
    await Promise.all(waiters);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(maxHeld).toBe(2);
  });

  it('a release is idempotent', async () => {
    const sem = createUnitSemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inUse()).toBe(0);
    const again = await sem.acquire();
    expect(sem.inUse()).toBe(1);
    again();
  });

  it('the process-wide instance is sized maxParallelUnitsPerProcess (20)', async () => {
    expect(FLOW_RUN_LIMITS.maxParallelUnitsPerProcess).toBe(20);
    const held = await Promise.all(Array.from({ length: 20 }, () => acquireUnit()));
    let extra = false;
    const pending = acquireUnit().then((r) => { extra = true; return r; });
    await tick();
    expect(extra).toBe(false);
    held[0]!();
    const r = await pending;
    expect(extra).toBe(true);
    r();
    for (const release of held.slice(1)) release();
  });
});
