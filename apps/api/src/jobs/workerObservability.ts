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
 * scope=system whose `worker` tag is empty, so there was no way to tell which
 * worker is pinning connections. Breaking that issue down by worker is the whole
 * triage step, and it was impossible.
 *
 * Every worker already calls attachWorkerObservability, so patching here covers
 * every one with no per-worker change.
 *
 * SUPERSEDED IN PART (BREEZE-18, 2026-08-23) — read before trusting the
 * paragraph above. The reasoning is correct but was not the whole story, and
 * this patch has been INERT since two days after it landed. `3c92c07cd`
 * (2026-07-25) added it; `a50769487` (2026-07-27, security wave 7) then
 * introduced ALLOWED_TAG_NAMES in services/sentry.ts, which rebuilds every
 * outbound event's tags through an allowlist that did not contain `worker`. So
 * the tag was set correctly here and deleted on the way out — by both paths,
 * the isolation scope AND the 'failed' listener below.
 *
 * That is why the ~12k BREEZE-9 events kept arriving unattributed after this
 * shipped. `worker` is allowlisted as of BREEZE-18; if you are debugging empty
 * worker attribution again, check ALLOWED_TAG_NAMES before this file.
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
