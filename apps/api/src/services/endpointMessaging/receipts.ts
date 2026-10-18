/**
 * Agent-attested message events -> endpoint_message_receipts (#8742 W02).
 *
 * Replaces the W1 Redis-deduped audit sink for every message that has a
 * delivery row. Dedup is the DB unique key (delivery_id, session_key,
 * event_type); the delivery aggregate moves through the state machine's
 * compare-and-set, so a late or duplicate event never regresses it.
 *
 * Runs in the agent route's request context (the device's org). The delivery
 * is found on the authenticated device only, by the persisted notify_user
 * command id or by the batch/message ids the API stored on that command.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { endpointMessageDeliveries, endpointMessageReceipts, endpointMessages } from '../../db/schema';
import type { EndpointMessageReceiptEvent } from '../../db/schema/endpointMessages';
import { deliveryStatusFromEvent, transitionTimestamps, transitionWhere } from './deliveryState';

export interface DeliveryEventInput {
  deviceId: string;
  commandId: string;
  batchId: string | null;
  messageId: string;
  sessionKey: string;
  sessionUsername: string;
  eventType: EndpointMessageReceiptEvent;
  occurredAt: Date;
}

export type DeliveryEventOutcome = { found: false } | { found: true; inserted: boolean };

export async function recordDeliveryEvent(input: DeliveryEventInput): Promise<DeliveryEventOutcome> {
  const byBatch = input.batchId
    ? inArray(
        endpointMessageDeliveries.endpointMessageId,
        db.select({ id: endpointMessages.id })
          .from(endpointMessages)
          .where(and(eq(endpointMessages.batchId, input.batchId), eq(endpointMessages.clientMessageId, input.messageId))),
      )
    : undefined;
  const rowFilter = and(
    eq(endpointMessageDeliveries.deviceId, input.deviceId),
    byBatch ? or(eq(endpointMessageDeliveries.commandId, input.commandId), byBatch) : eq(endpointMessageDeliveries.commandId, input.commandId),
  );

  const [delivery] = await db
    .select({ id: endpointMessageDeliveries.id, orgId: endpointMessageDeliveries.orgId })
    .from(endpointMessageDeliveries)
    .where(rowFilter)
    .limit(1);
  if (!delivery) return { found: false };

  const inserted = await db.insert(endpointMessageReceipts)
    .values({
      deliveryId: delivery.id,
      orgId: delivery.orgId,
      deviceId: input.deviceId,
      sessionKey: input.sessionKey,
      sessionUsername: input.sessionUsername,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: endpointMessageReceipts.id });
  if (inserted.length === 0) return { found: true, inserted: false };

  // Aggregate: one acknowledging session is enough for `acknowledged`. A
  // second session's dismiss after another's ack is a receipt only.
  const to = deliveryStatusFromEvent(input.eventType);
  const now = new Date();
  await db.update(endpointMessageDeliveries)
    .set({ status: to, updatedAt: now, ...transitionTimestamps(to, input.occurredAt) })
    .where(transitionWhere(to, eq(endpointMessageDeliveries.id, delivery.id)));
  return { found: true, inserted: true };
}
