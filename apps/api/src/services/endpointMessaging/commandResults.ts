/**
 * notify_user command results -> endpoint message deliveries (#8742 W02).
 *
 * Registered in `commandResultHandlers` (and the HTTP route's
 * REGISTRY_DISPATCHED_COMMAND_TYPES), so the websocket and HTTP transports run
 * this one leaf. It runs inside the transport's result transaction, in the
 * device's org context: a throw rolls the result back and parks it
 * reopenable, the same contract as every other registry handler.
 *
 * Ownership: the delivery is found on the transport-authenticated device only,
 * by the command id, or (a result that raced the send's command-id
 * bookkeeping) by the batch and message ids the API itself put in the
 * persisted command payload. Never from anything the agent reports.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { endpointMessageDeliveries, endpointMessages } from '../../db/schema';
import type { CommandResultHandler } from '../commandResultHandlers';
import { deliveryStatusFromCommandResult, transitionTimestamps, transitionWhere } from './deliveryState';

type HandlerParams = Parameters<CommandResultHandler>[0];

function str(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

export async function handleNotifyUserResult({ command, commandId, resolvedDeviceId, result, stdout }: HandlerParams): Promise<void> {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  // Plain notify_user (no endpoint-message source) has no delivery row.
  if (payload.source !== 'endpoint_message') return;
  const batchId = str(payload.batchId);
  const messageId = str(payload.messageId);

  const byBatch = batchId && messageId
    ? inArray(
        endpointMessageDeliveries.endpointMessageId,
        db.select({ id: endpointMessages.id })
          .from(endpointMessages)
          .where(and(eq(endpointMessages.batchId, batchId), eq(endpointMessages.clientMessageId, messageId))),
      )
    : undefined;
  const rowFilter = and(
    eq(endpointMessageDeliveries.deviceId, resolvedDeviceId),
    byBatch ? or(eq(endpointMessageDeliveries.commandId, commandId), byBatch) : eq(endpointMessageDeliveries.commandId, commandId),
  );

  const [match] = await db.select({ id: endpointMessageDeliveries.id })
    .from(endpointMessageDeliveries)
    .where(rowFilter)
    .limit(1);
  if (!match) {
    // A W2 send always has a delivery row; a miss means it was erased or the
    // device moved and detached it. Not an error for the agent, but visible.
    console.warn('[endpoint-messages] notify_user result matched no delivery', { commandId, deviceId: resolvedDeviceId, batchId });
    return;
  }

  const outcome = deliveryStatusFromCommandResult({ status: result.status, error: result.error, stdout });
  const now = new Date();
  if (outcome.status === 'retracted') {
    await db.update(endpointMessageDeliveries)
      .set({
        status: 'retracted',
        commandId: sql`COALESCE(${endpointMessageDeliveries.commandId}, ${commandId}::uuid)`,
        updatedAt: now,
        ...transitionTimestamps('retracted', now),
      })
      .where(transitionWhere('retracted', rowFilter));
    return;
  }
  if (outcome.status === 'delivered') {
    await db.update(endpointMessageDeliveries)
      .set({
        status: 'delivered',
        surface: outcome.surface,
        commandId: sql`COALESCE(${endpointMessageDeliveries.commandId}, ${commandId}::uuid)`,
        updatedAt: now,
        ...transitionTimestamps('delivered', now),
      })
      .where(transitionWhere('delivered', rowFilter));
    // A display/ack event that beat the result already moved the row past
    // `delivered`; still record the surface and command id it lacked.
    await db.update(endpointMessageDeliveries)
      .set({
        surface: sql`COALESCE(${endpointMessageDeliveries.surface}, ${outcome.surface})`,
        commandId: sql`COALESCE(${endpointMessageDeliveries.commandId}, ${commandId}::uuid)`,
        deliveredAt: sql`COALESCE(${endpointMessageDeliveries.deliveredAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(and(rowFilter, sql`${endpointMessageDeliveries.deliveredAt} IS NULL`));
    return;
  }
  await db.update(endpointMessageDeliveries)
    .set({
      status: 'failed',
      errorCode: outcome.errorCode,
      commandId: sql`COALESCE(${endpointMessageDeliveries.commandId}, ${commandId}::uuid)`,
      updatedAt: now,
    })
    .where(transitionWhere('failed', rowFilter));
}

/**
 * retract_message results (#8742 W02). The delivery was marked `retracted`
 * when the operator asked; a retract the agent could not carry out (no helper
 * reachable, timeout, unknown type) is recorded as `error_code =
 * 'retract_failed'` so the history shows the card may still be on screen.
 * Ownership: the delivery naming this retract command on the
 * transport-authenticated device.
 */
export async function handleRetractMessageResult({ commandId, resolvedDeviceId, result }: HandlerParams): Promise<void> {
  if (result.status === 'completed') return;
  const updated = await db.update(endpointMessageDeliveries)
    .set({ errorCode: 'retract_failed', updatedAt: new Date() })
    .where(and(
      eq(endpointMessageDeliveries.retractCommandId, commandId),
      eq(endpointMessageDeliveries.deviceId, resolvedDeviceId),
    ))
    .returning({ id: endpointMessageDeliveries.id });
  if (updated.length === 0) {
    console.warn('[endpoint-messages] retract_message result matched no delivery', { commandId, deviceId: resolvedDeviceId });
  }
}
