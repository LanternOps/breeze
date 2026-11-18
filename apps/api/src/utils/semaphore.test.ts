import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore';

/** The decrement-then-wake shape the shared Semaphore replaced, kept here as the control. */
class DecrementThenWake {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

type Runner = { run<T>(fn: () => Promise<T>): Promise<T> };

/**
 * Limit 1: A holds the slot, B waits. As A finishes, a newcomer C arrives in
 * the microtask between A's release and B's wake-up. Returns the peak number
 * of tasks running at once.
 */
async function newcomerAtRelease(sem: Runner): Promise<number> {
  let active = 0;
  let peak = 0;
  const work = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 1));
    active -= 1;
  };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started: Array<Promise<void>> = [];
  started.push(sem.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    // Two hops: past the semaphore's own resumption of A, before B's wake-up.
    queueMicrotask(() => queueMicrotask(() => { started.push(sem.run(work)); }));
  }));
  started.push(sem.run(work));
  release();
  for (let i = 0; i < 20; i += 1) await Promise.all([...started]);
  return peak;
}

describe('Semaphore (hand-off)', () => {
  it('never lets a newcomer overtake a woken waiter', async () => {
    expect(await newcomerAtRelease(new Semaphore(1))).toBe(1);
  });

  it('control: decrement-then-wake admits two at once in the same schedule', async () => {
    // If this ever stops overshooting, the schedule above no longer hits the
    // window, and the first case proves nothing: revisit both together.
    expect(await newcomerAtRelease(new DecrementThenWake(1))).toBe(2);
  });

  it('keeps at most `limit` running under load, serving waiters first in, first out', async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(Array.from({ length: 30 }, (_, i) => sem.run(async () => {
      order.push(i);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, i % 3));
      active -= 1;
    })));
    expect(peak).toBe(3);
    expect(order.slice(0, 3)).toEqual([0, 1, 2]);
    expect(sem.inUse).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it('releases the slot when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sem.inUse).toBe(0);
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('refuses a limit below one', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});
