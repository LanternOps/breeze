/**
 * Endpoint message persistence (#8742 W02).
 *
 * Every write here runs in its OWN system-scope transaction, outside the
 * request's held DB transaction, and commits before the caller queues any
 * command. `queueCommandForExecution` commits each command immediately and an
 * agent on a live socket can answer in milliseconds; a delivery row still
 * sitting in the request's uncommitted transaction would be invisible to that
 * result. Authorization is the caller's job: the org ids and device ids here
 * come from `resolveTargetsDetailed`, which ran under the request's RLS
 * context, never from the request body.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { endpointMessageDeliveries, endpointMessages } from '../../db/schema';
import type { EndpointMessageSeverity } from '../../db/schema/endpointMessages';
import type { AiOriginRef } from '@breeze/shared';
import { transitionWhere } from './deliveryState';

const INSERT_CHUNK = 500;

export interface PersistDeviceInput {
  deviceId: string;
  orgId: string;
  status: 'queued' | 'failed';
  errorCode?: string;
}

export interface PersistSendInput {
  batchId: string;
  clientMessageId: string;
  actorId: string;
  targetMode: string;
  targetSpec: Record<string, unknown>;
  title: string;
  body: string;
  bodySha256: string;
  severity: EndpointMessageSeverity;
  requiresAck: boolean;
  expiresAt: Date;
  aiOrigin?: AiOriginRef;
  resendOfId?: string;
  /** One endpoint_messages row per org, carrying that org's sender snapshot. */
  orgGroups: Array<{ orgId: string; branding: Record<string, unknown> }>;
  devices: PersistDeviceInput[];
}

const inSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

/** Writes the message rows and one delivery per device. Returns deviceId -> deliveryId. */
export async function persistSend(input: PersistSendInput): Promise<Map<string, string>> {
  return inSystem(() => db.transaction(async (tx) => {
    const messageIdByOrg = new Map<string, string>();
    for (const g of input.orgGroups) {
      const [row] = await tx.insert(endpointMessages).values({
        orgId: g.orgId,
        batchId: input.batchId,
        clientMessageId: input.clientMessageId,
        createdBy: input.actorId,
        targetMode: input.targetMode,
        targetSpec: input.targetSpec,
        title: input.title,
        body: input.body,
        severity: input.severity,
        requiresAck: input.requiresAck,
        expiresAt: input.expiresAt,
        branding: g.branding,
        aiInitiatorKind: input.aiOrigin?.kind ?? null,
        aiSessionId: input.aiOrigin?.sessionId ?? null,
        aiAgentRunId: input.aiOrigin?.agentRunId ?? null,
        bodySha256: input.bodySha256,
        bodyLength: input.body.length,
        resendOfId: input.resendOfId ?? null,
      }).returning({ id: endpointMessages.id });
      messageIdByOrg.set(g.orgId, row!.id);
    }

    const deliveryByDevice = new Map<string, string>();
    for (let i = 0; i < input.devices.length; i += INSERT_CHUNK) {
      const chunk = input.devices.slice(i, i + INSERT_CHUNK);
      const rows = await tx.insert(endpointMessageDeliveries).values(chunk.map((d) => {
        const endpointMessageId = messageIdByOrg.get(d.orgId);
        if (!endpointMessageId) throw new Error('endpoint message persistence: device org has no message row');
        return {
          endpointMessageId,
          orgId: d.orgId,
          deviceId: d.deviceId,
          status: d.status,
          errorCode: d.errorCode ?? null,
          expiresAt: input.expiresAt,
        };
      })).returning({ id: endpointMessageDeliveries.id, deviceId: endpointMessageDeliveries.deviceId });
      for (const r of rows) deliveryByDevice.set(r.deviceId, r.id);
    }
    return deliveryByDevice;
  }));
}

/** Records the notify_user command id on a delivery (first writer wins). */
export async function attachDeliveryCommand(deliveryId: string, commandId: string): Promise<void> {
  await inSystem(() => db.update(endpointMessageDeliveries)
    .set({ commandId, updatedAt: new Date() })
    .where(and(eq(endpointMessageDeliveries.id, deliveryId), isNull(endpointMessageDeliveries.commandId))));
}

/** A command that could not be queued: queued -> failed, never a regression. */
export async function markDeliveryQueueFailed(deliveryId: string, errorCode: string): Promise<void> {
  await inSystem(() => db.update(endpointMessageDeliveries)
    .set({ status: 'failed', errorCode, updatedAt: new Date() })
    .where(transitionWhere('failed', eq(endpointMessageDeliveries.id, deliveryId))));
}
