/**
 * Async queue that decouples event producers from consumers.
 *
 * IMPORTANT: Single-consumer only. Each queue instance must have exactly one
 * async iterator consumer (one `for await...of` loop). Multiple concurrent
 * consumers will cause silent data loss.
 *
 * Used by the streaming session manager and event bus to bridge
 * push-based producers (SDK callbacks, background processors)
 * with pull-based async iterators (SSE streams, input controllers).
 */
export class AsyncEventQueue<T> {
  private buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  /** Push an item to the queue. Returns false if the queue is closed (item dropped). */
  push(item: T): boolean {
    if (this.closed) return false;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        if (this.waiting) {
          throw new Error('AsyncEventQueue: only one consumer is allowed at a time');
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      }
    };
  }
}
