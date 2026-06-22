/**
 * bullmqQueue — shared, #1105-instrumented BullMQ Queue factory.
 *
 * Why this exists: there is no single chokepoint for enqueues in this codebase —
 * each worker module constructs its own `new Queue(...)` and calls `queue.add()`
 * directly. That made the #1105 txn-around-slow-work foot-gun (a held
 * `withDbAccessContext` transaction pinning a pooled connection idle across a
 * Redis enqueue) undetectable per-enqueue: it took a production incident to find
 * each instance by hand (#1116, #1313).
 *
 * `createInstrumentedQueue(name, opts)` is a drop-in replacement for
 * `new Queue(name, { connection: getBullMQConnection(), ... })` that wires the
 * `assertOutsideHeldDbContext` tripwire (#1105) into the queue's `add()` /
 * `addBulk()` so EVERY enqueue made through it reports when it runs inside a
 * held DB transaction. Warn-only by default (prod-safe, mirroring the
 * contextless-write guard #1375); set `DB_CONTEXT_TRIPWIRE_STRICT` to throw so a
 * newly-introduced violation fails the build. The fix at a flagged call site is
 * to enqueue AFTER the context closes, or to wrap the enqueue in
 * `runOutsideDbContext(...)` (which exits the context, making the guard a no-op).
 *
 * Adopting this factory across queue constructors is incremental: callers that
 * still use bare `new Queue(...)` simply aren't instrumented yet. Start with the
 * agent/reconnect blast-radius queues (the #1105 trigger surface) and migrate
 * the rest over time.
 */
import { Queue } from 'bullmq';
import type { QueueOptions } from 'bullmq';
import { getBullMQConnection } from './redis';
import { assertOutsideHeldDbContext } from '../db';

/**
 * Construct a BullMQ Queue whose enqueue methods are guarded by the #1105
 * held-context tripwire. `connection` defaults to the shared BullMQ Redis
 * connection, so most callers pass only the queue name (and optionally
 * `defaultJobOptions`).
 *
 * The returned object IS a real `Queue` — `add` and `addBulk` are wrapped in
 * place, so existing call sites (`queue.add(...)`, `queue.getJob(...)`,
 * `queue.close()`, …) work unchanged.
 */
export function createInstrumentedQueue<DataType = unknown, ResultType = unknown, NameType extends string = string>(
  name: string,
  opts: Omit<QueueOptions, 'connection'> & Partial<Pick<QueueOptions, 'connection'>> = {},
): Queue<DataType, ResultType, NameType> {
  const queue = new Queue<DataType, ResultType, NameType>(name, {
    connection: getBullMQConnection(),
    ...opts,
  });

  type Q = Queue<DataType, ResultType, NameType>;

  // Wrap each enqueue method in place. We only rebind a method that is actually
  // a function so a partial test double (a mocked Queue that stubs only `add`,
  // not `addBulk`) doesn't blow up on `.bind(undefined)`; the real BullMQ Queue
  // always has both. Cast through the method's own type so the wrapper preserves
  // the exact signature/overloads BullMQ exposes; the guard runs first.
  if (typeof queue.add === 'function') {
    const originalAdd = queue.add.bind(queue);
    queue.add = ((...args: Parameters<Q['add']>) => {
      assertOutsideHeldDbContext(`bullmq.add(${name})`);
      return originalAdd(...args);
    }) as Q['add'];
  }

  if (typeof queue.addBulk === 'function') {
    const originalAddBulk = queue.addBulk.bind(queue);
    queue.addBulk = ((...args: Parameters<Q['addBulk']>) => {
      assertOutsideHeldDbContext(`bullmq.addBulk(${name})`);
      return originalAddBulk(...args);
    }) as Q['addBulk'];
  }

  return queue;
}
