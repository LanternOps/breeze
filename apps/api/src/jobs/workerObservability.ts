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
export function attachWorkerObservability(worker: Worker, name: string): void {
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
