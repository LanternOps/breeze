import * as Sentry from '@sentry/node';
import type { Worker } from 'bullmq';
import { captureException } from '../services/sentry';

/**
 * Attaches unified error + failed-job reporting to a BullMQ worker (#1379).
 *
 * Many workers historically only `console.error`'d on `error`/`failed`, so
 * job failures were invisible in Sentry — a class of silent failure this
 * wires up. Purely additive: callers keep any existing `.on('error')` /
 * `.on('failed')` handlers; this just adds Sentry capture alongside.
 */
/**
 * Run each job inside a Sentry isolation scope tagged with the worker and job
 * identity, so EVERY event captured while that job runs inherits them — not
 * just the `failed` handler below.
 *
 * Why: the `worker` tag was only ever set on the 'failed' listener, which fires
 * outside job execution. Anything captured *during* a job — most importantly the
 * #1105 held-context warning from withDbAccessContext — arrived with no
 * attribution at all. BREEZE-9 accumulated ~12k held-context events at
 * scope=system whose `worker` tag is empty, so there is no way to tell which of
 * the 38 workers is pinning connections. Breaking that issue down by worker is
 * the whole triage step, and it was impossible.
 *
 * All 38 workers already call attachWorkerObservability, so patching here covers
 * every one with no per-worker change.
 *
 * `processFn` is a BullMQ instance property (visible in production stack traces
 * as `at Worker.processFn`). Patching a library internal is a trade: it is
 * guarded by a typeof check so a BullMQ rename degrades to the previous
 * behaviour — no tags — rather than throwing, and workerObservability.test.ts
 * asserts the tagging works so an upgrade that moves it fails loudly in CI
 * instead of silently returning us to unattributable events.
 */
function tagJobExecution(worker: Worker, name: string): void {
  const target = worker as unknown as {
    processFn?: (...args: unknown[]) => unknown;
  };
  const original = target.processFn;
  if (typeof original !== 'function') {
    console.warn(
      `[${name}] could not tag job execution for Sentry: BullMQ Worker.processFn is not a function `
      + '(library internals changed). Held-context and in-job events will lack worker attribution.',
    );
    return;
  }

  target.processFn = function patchedProcessFn(...args: unknown[]) {
    const job = args[0] as { id?: string; name?: string } | undefined;
    return Sentry.withIsolationScope((scope) => {
      scope.setTag('worker', name);
      if (job?.name) scope.setTag('jobName', job.name);
      if (job?.id) scope.setTag('jobId', job.id);
      return original.apply(this, args);
    });
  };
}

export function attachWorkerObservability(worker: Worker, name: string): void {
  tagJobExecution(worker, name);

  worker.on('error', (e) => {
    console.error(`[${name}] worker error:`, e);
    captureException(e);
  });

  worker.on('failed', (job, err) => {
    console.error(`[${name}] job ${job?.id} failed:`, err);
    Sentry.withScope((scope) => {
      scope.setTag('worker', name);
      scope.setTag('jobId', job?.id);
      scope.setContext('job', { name: job?.name });
      captureException(err);
    });
  });
}
