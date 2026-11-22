/**
 * A counting semaphore for in-process concurrency caps (outbound requests per
 * registry, per import source).
 *
 * A released slot is handed straight to the next waiter: `active` is not
 * decremented when a waiter exists, so a caller that arrives between the
 * release and the waiter's wake-up finds the slot taken and queues, instead
 * of slipping in and pushing the count over the limit. (Decrement-then-wake
 * leaves exactly that window open for one microtask.) Waiters are served
 * first in, first out.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active += 1;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  /** Slots in use (a slot handed to a woken waiter counts). */
  get inUse(): number {
    return this.active;
  }

  /** Callers waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }
}
