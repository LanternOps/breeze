import { Job } from 'bullmq';

/**
 * A real BullMQ `Job`, deserialised exactly the way a Worker builds the job it
 * hands to a processor (`Job.fromJSON` over the Redis hash). `atm` is the
 * persisted `attemptsMade`: BullMQ bumps it only when an attempt finishes or is
 * retried, so the Nth attempt of a job runs with `attemptsMade === N - 1`.
 * Do NOT hand-build `{ attemptsMade, opts }` objects — that is how the 1-based
 * misreading of `attemptsMade` (#8351) went unnoticed.
 */
export function makeRealJob<T>(
  data: T,
  opts: { attemptsMade: number; attempts?: number },
): Job<T> {
  // Just enough of a Queue for the Job constructor (it only reads key names); never touches Redis.
  const queueStub = {
    toKey: (type: string) => `bull:test:${type}`,
    qualifiedName: 'bull:test',
    keys: new Proxy({}, { get: (_t, prop) => `bull:test:${String(prop)}` }),
    opts: {},
  } as never;
  return Job.fromJSON(queueStub, {
    id: 'job-1',
    name: 'test',
    data: JSON.stringify(data),
    opts: JSON.stringify(opts.attempts === undefined ? {} : { attempts: opts.attempts }),
    atm: String(opts.attemptsMade),
    ats: String(opts.attemptsMade + 1),
    timestamp: String(Date.now()),
    delay: '0',
  } as never) as Job<T>;
}
