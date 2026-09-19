import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

// `contract-events` carries contract lifecycle events. Consumed since the
// service-deliverables wave (#5573 W02 — jobs/deliverableWorker.ts's
// contract-events Worker), which acts on `contract.cancelled` and ignores every
// other type. Delivery is still best-effort: emitContractEvent never throws, so
// a Redis hiccup during a cancel drops the event and the MSP closes the
// deliverable's effective window by hand.
export const CONTRACT_EVENTS_QUEUE = 'contract-events';

export type ContractEvent = {
  type: 'contract.activated' | 'contract.invoiced' | 'contract.paused' | 'contract.cancelled' | 'contract.expired' | 'contract.auto_renewed' | 'contract.renewal_notice';
  contractId: string;
  orgId: string;
  partnerId: string;
  invoiceId?: string;    // set on contract.invoiced
  actorUserId?: string;
};

let queue: Queue | null = null;

function getContractEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(CONTRACT_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

/** Fire-and-forget. Never throws — a Redis hiccup must not roll back a billing transaction. */
export async function emitContractEvent(event: ContractEvent): Promise<void> {
  try {
    await getContractEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[ContractEvents] failed to enqueue', event.type, `contractId=${event.contractId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
