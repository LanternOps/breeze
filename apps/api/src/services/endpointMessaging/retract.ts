/**
 * Retract an endpoint message (#8742 W02).
 *
 * Per live delivery of the message:
 *   - its notify_user command is still `pending` (never left the API): cancel
 *     the command (payload erased like any terminal row) -> `retracted`;
 *   - otherwise the card may be on screen: queue `retract_message` (a
 *     lifecycle command carrying only the message id, so a restricted partner
 *     can still take content down) -> `retracted`. An agent below the retract
 *     gate is reported `agent_unsupported` and its delivery is left as is.
 *   - a delivery already past its expiry needs no command: the agent dropped
 *     the card at expiry -> `retracted`.
 * Terminal deliveries are untouched. Retract is idempotent: a second call
 * reports what is still live (normally nothing).
 *
 * Runs in the request's RLS context. Site-restricted callers only touch
 * deliveries on devices in their allowed sites.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { deviceCommands, devices, endpointMessageDeliveries, endpointMessages } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { queueCommandForExecution } from '../commandQueue';
import { CommandTypes } from '../commandTypes';
import { deliveryTtlMs } from '../commandOfflinePolicy';
import { agentSupportsRetract } from '../commandMinVersion';
import { terminalPayloadErasureSet } from '../sensitiveCommandPayload';
import { canAccessSite, type UserPermissions } from '../permissions';
import { transitionTimestamps, transitionWhere } from './deliveryState';

export type RetractDeviceResult =
  | { deviceId: string; status: 'retracted'; via: 'cancelled' | 'command' | 'expired'; commandId?: string }
  | { deviceId: string; status: 'failed'; errorCode: 'agent_unsupported' | 'no_permission' | 'queue_failed' | 'offline_rejected' };

export type RetractOutcome =
  | { kind: 'not_found' }
  | { kind: 'ok'; id: string; orgId: string; retractedAt: string; alreadyRetracted: boolean; results: RetractDeviceResult[] };

const LIVE: Array<'queued' | 'delivered' | 'displayed'> = ['queued', 'delivered', 'displayed'];

export async function retractEndpointMessage(args: {
  auth: AuthContext;
  permissions?: Pick<UserPermissions, 'allowedSiteIds'>;
  messageRowId: string;
}): Promise<RetractOutcome> {
  const { auth, permissions, messageRowId } = args;
  const [message] = await db
    .select({
      id: endpointMessages.id,
      orgId: endpointMessages.orgId,
      clientMessageId: endpointMessages.clientMessageId,
      expiresAt: endpointMessages.expiresAt,
      retractedAt: endpointMessages.retractedAt,
    })
    .from(endpointMessages)
    .where(and(eq(endpointMessages.id, messageRowId), auth.orgCondition(endpointMessages.orgId)))
    .limit(1);
  if (!message || !auth.canAccessOrg(message.orgId)) return { kind: 'not_found' };

  const now = new Date();
  const alreadyRetracted = message.retractedAt !== null;
  let retractedAt = message.retractedAt ?? now;
  if (!alreadyRetracted) {
    const [stamped] = await db.update(endpointMessages)
      .set({ retractedAt: now, retractedBy: auth.user.id })
      .where(and(eq(endpointMessages.id, message.id), sql`${endpointMessages.retractedAt} IS NULL`))
      .returning({ retractedAt: endpointMessages.retractedAt });
    if (stamped?.retractedAt) retractedAt = stamped.retractedAt;
  }

  const live = await db
    .select({
      id: endpointMessageDeliveries.id,
      deviceId: endpointMessageDeliveries.deviceId,
      orgId: endpointMessageDeliveries.orgId,
      commandId: endpointMessageDeliveries.commandId,
      siteId: devices.siteId,
      agentVersion: devices.agentVersion,
    })
    .from(endpointMessageDeliveries)
    .innerJoin(devices, eq(devices.id, endpointMessageDeliveries.deviceId))
    .where(and(
      eq(endpointMessageDeliveries.endpointMessageId, message.id),
      inArray(endpointMessageDeliveries.status, LIVE),
    ));

  const results: RetractDeviceResult[] = [];
  const ttlMs = deliveryTtlMs('standard');
  const remainingMs = message.expiresAt.getTime() - now.getTime();

  const markRetracted = async (deliveryId: string, retractCommandId: string | null) => {
    await db.update(endpointMessageDeliveries)
      .set({ status: 'retracted', retractCommandId, updatedAt: now, ...transitionTimestamps('retracted', now) })
      .where(transitionWhere('retracted', eq(endpointMessageDeliveries.id, deliveryId)));
  };

  for (const d of live) {
    if (permissions?.allowedSiteIds !== undefined && !canAccessSite(permissions as UserPermissions, d.siteId)) {
      results.push({ deviceId: d.deviceId, status: 'failed', errorCode: 'no_permission' });
      continue;
    }

    // Still in the API's queue: cancelling the command is the whole retract.
    if (d.commandId) {
      const cancelled = await db.update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt: now,
          result: { status: 'cancelled', reason: 'endpoint_message_retracted', cancelledBy: auth.user.id },
          ...terminalPayloadErasureSet(),
        })
        .where(and(
          eq(deviceCommands.id, d.commandId),
          eq(deviceCommands.deviceId, d.deviceId),
          eq(deviceCommands.status, 'pending'),
        ))
        .returning({ id: deviceCommands.id });
      if (cancelled.length > 0) {
        await markRetracted(d.id, null);
        results.push({ deviceId: d.deviceId, status: 'retracted', via: 'cancelled' });
        continue;
      }
    }

    if (remainingMs <= 0) {
      await markRetracted(d.id, null);
      results.push({ deviceId: d.deviceId, status: 'retracted', via: 'expired' });
      continue;
    }

    if (!agentSupportsRetract(d.agentVersion)) {
      results.push({ deviceId: d.deviceId, status: 'failed', errorCode: 'agent_unsupported' });
      continue;
    }

    try {
      const res = await queueCommandForExecution(
        d.deviceId,
        CommandTypes.RETRACT_MESSAGE,
        { messageId: message.clientMessageId },
        {
          userId: auth.user.id,
          expectedOrgId: d.orgId,
          offlinePolicy: { kind: 'queue', deliverWithinMs: Math.min(Math.max(remainingMs, 1000), ttlMs) },
          aiOrigin: auth.aiOrigin,
        },
      );
      if (res.error || !res.command) {
        console.error('[endpoint-messages] retract queue refused', { deviceId: d.deviceId, error: res.error });
        results.push({
          deviceId: d.deviceId,
          status: 'failed',
          errorCode: res.trust ? 'no_permission' : res.error && /offline/i.test(res.error) ? 'offline_rejected' : 'queue_failed',
        });
        continue;
      }
      await markRetracted(d.id, res.command.id);
      results.push({ deviceId: d.deviceId, status: 'retracted', via: 'command', commandId: res.command.id });
    } catch (err) {
      console.error('[endpoint-messages] retract queue threw', { deviceId: d.deviceId, error: err instanceof Error ? err.message : String(err) });
      results.push({ deviceId: d.deviceId, status: 'failed', errorCode: 'queue_failed' });
    }
  }

  return {
    kind: 'ok',
    id: message.id,
    orgId: message.orgId,
    retractedAt: retractedAt.toISOString(),
    alreadyRetracted,
    results,
  };
}
