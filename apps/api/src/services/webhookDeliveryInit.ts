/**
 * `webhookDelivery` registry entry wiring (wave 3.5d-b, #4086).
 *
 * Moved out of `index.ts`'s local `initializeWebhookDeliveryWorker` function
 * so `services/workerRegistry.ts` can lazy-load a single self-contained
 * module for the `webhookDelivery` entry instead of reaching back into
 * index.ts (which the registry must never import — see
 * `workerEntrypointClosure.contract.test.ts`).
 *
 * Deliberately its OWN leaf module rather than added to `workers/webhookDelivery.ts`
 * directly: that file is imported (type-only) by `services/webhookDeliveryRecord.ts`,
 * and `workers/webhookDelivery.test.ts` mocks `../db` without a `db` export —
 * `webhookDeliveryRecord.ts` destructures `db` from the module eagerly at
 * import time, so pulling it into `workers/webhookDelivery.ts`'s own import
 * graph broke that test's mock (verified: "No 'db' export is defined on the
 * '../db' mock"). Keeping the wiring here, importing both leaf modules by
 * value with neither importing the other, avoids the cycle and leaves both
 * existing test suites untouched.
 */
import { getWebhookWorker, initializeWebhookDelivery } from '../workers/webhookDelivery';
import { claimDeliveryForExecution, recordDeliveryOutcome } from './webhookDeliveryRecord';

/**
 * Wires the delivery-claim and delivery-outcome callbacks then starts the
 * drain loop.
 *
 * EXECUTION CLAIM (#4095). The delivery queue is a plain Redis list with no
 * job identity, so the same delivery can legitimately appear on it twice —
 * the recovery sweep re-queues any row that still looks unresolved, and a job
 * that was only backlogged is indistinguishable from one that was lost. This
 * CAS is what makes that safe: exactly one popped copy flips `pending` ->
 * `retrying` and POSTs; every other copy loses and is dropped by the worker.
 * It is also what bounds the sweep, since a claimed row leaves `pending` the
 * instant a worker takes it.
 *
 * Event routing itself is wired by `registerAllEventSubscribers()` before the
 * worker registry runs — this only starts the queue drain loop.
 */
export async function initializeWebhookDeliveryWorker(): Promise<void> {
  const webhookWorker = getWebhookWorker();

  webhookWorker.setDeliveryClaimCallback(claimDeliveryForExecution);
  webhookWorker.setDeliveryCallback(recordDeliveryOutcome);

  await initializeWebhookDelivery();
}

/**
 * Registry-facing shutdown for the `webhookDelivery` entry. `index.ts` also
 * calls `getWebhookWorker().stop()` directly in its shutdown preamble (must
 * run BEFORE the HTTP server stops accepting requests / other phases run) —
 * `stop()` only flips a boolean and logs, so the second call here is a
 * harmless no-op.
 */
export async function shutdownWebhookDeliveryWorker(): Promise<void> {
  getWebhookWorker().stop();
}
