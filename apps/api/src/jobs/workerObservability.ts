import * as Sentry from '@sentry/node';
import type { Job, Worker } from 'bullmq';
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

/**
 * How a worker wants ONE of its own failure modes reported (BREEZE-1J).
 *
 * The default — every rejection of every attempt captured at error level — is
 * right for a worker whose job handler only throws on genuine faults. It is
 * wrong for a handler that also `throw`s to ask BullMQ for a retry on an
 * EXPECTED, self-healing condition: that produces one error-level Sentry event
 * per attempt for something nobody should be paged about, and (because the
 * attempts are identical) the SDK's default Dedupe integration collapses the
 * burst so the issue's occurrence count doesn't even reflect reality.
 *
 * Returning a classification does NOT make the failure silent — it stays
 * console-logged on every attempt and still reaches Sentry. It only changes the
 * severity and, for `reportOnlyWhenExhausted`, folds the identical intermediate
 * attempts into the single report that says the job actually gave up.
 */
export interface WorkerFailureClassification {
  /**
   * Closed, hardcoded label for this failure mode — becomes the
   * `worker_failure_reason` tag. Must never carry a tenant, device, session or
   * job identifier: it is a discriminator, not a payload.
   */
  reason: string;
  /** `warning` for an expected, self-healing condition; `error` otherwise. */
  level: 'warning' | 'error';
  /**
   * Report only once the job has exhausted its configured attempts. Use for a
   * condition where every attempt fails for the same reason, so the
   * intermediate attempts add volume and no information.
   */
  reportOnlyWhenExhausted?: boolean;
}

export interface WorkerObservabilityOptions {
  /**
   * Classify a job failure. Return `null` (or omit the option entirely) to keep
   * the default error-level report on every attempt.
   */
  classifyFailure?: (
    job: Job | undefined,
    err: Error,
  ) => WorkerFailureClassification | null;
}

/**
 * True once BullMQ will not retry this job again. `attemptsMade` is already
 * incremented when `failed` fires, so the final attempt is the one where it has
 * reached the configured ceiling. Unknown job shape → treat as exhausted, so an
 * unrecognised BullMQ version reports MORE rather than swallowing the report.
 */
function hasExhaustedAttempts(job: Job | undefined): boolean {
  if (!job) return true;
  const attempts = job.opts?.attempts ?? 1;
  const made = job.attemptsMade ?? 0;
  if (!Number.isFinite(attempts) || !Number.isFinite(made)) return true;
  return made >= attempts;
}

/**
 * A classifier fault must cost the classification, never the report — same
 * trade as the CONNECT_TIMEOUT classifier in services/sentry.
 */
function safeClassify(
  classify: WorkerObservabilityOptions['classifyFailure'],
  name: string,
  job: Job | undefined,
  err: Error,
): WorkerFailureClassification | null {
  if (!classify) return null;
  try {
    return classify(job, err) ?? null;
  } catch (classifierError) {
    console.error(
      `[${name}] failure classifier threw; reporting at default severity:`,
      classifierError,
    );
    return null;
  }
}

export function attachWorkerObservability(
  worker: Worker,
  name: string,
  options?: WorkerObservabilityOptions,
): void {
  tagJobExecution(worker, name);

  worker.on('error', (e) => {
    console.error(`[${name}] worker error:`, e);
    captureException(e);
  });

  worker.on('failed', (job, err) => {
    const classification = safeClassify(options?.classifyFailure, name, job, err);

    if (classification?.reportOnlyWhenExhausted && !hasExhaustedAttempts(job)) {
      // Not silent: the attempt is logged, and the exhausting attempt below is
      // what reaches Sentry with the same reason label.
      console.warn(
        `[${name}] job ${job?.id} attempt ${job?.attemptsMade} failed `
        + `(${classification.reason}); retrying:`,
        err,
      );
      return;
    }

    console.error(`[${name}] job ${job?.id} failed:`, err);
    Sentry.withScope((scope) => {
      scope.setTag('worker', name);
      scope.setTag('jobId', job?.id);
      if (classification) {
        scope.setLevel(classification.level);
        scope.setTag('worker_failure_reason', classification.reason);
      }
      scope.setContext('job', { name: job?.name });
      captureException(err);
    });
  });
}
