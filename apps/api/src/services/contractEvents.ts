import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

// `contract-events` is an intentionally-unconsumed RESERVED bus (same pattern as
// `invoice-events` / `catalog-events` / `time-entry-events`): emitContractEvent
// publishes lifecycle events but nothing reads them yet. Future webhook / notification
// delivery wires a Worker against this queue. Until then, jobs simply expire per the
// removeOnComplete/removeOnFail retention below — there is no delivery today.
export const CONTRACT_EVENTS_QUEUE = 'contract-events';

export type ContractEvent = {
  type: 'contract.activated' | 'contract.invoiced' | 'contract.paused' | 'contract.cancelled' | 'contract.expired';
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
