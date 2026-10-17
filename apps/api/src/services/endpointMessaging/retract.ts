/**
 * Retract an endpoint message (#8742 W02).
 *
 * Per live delivery of the message:
 *   - no notify_user command yet (the send is still working through its
 *     devices): mark it `retracted`; the send loop sees that when it attaches
 *     its command and withdraws it (routes/endpointMessages/send.ts);
 *   - its notify_user command is still `pending` (never left the API): cancel
 *     the command (payload erased like any terminal row) -> `retracted`;
 *   - otherwise the card may be on screen: queue `retract_message` (a
 *     lifecycle command carrying only the message id, so a restricted partner
 *     can still take content down) -> `retracted`. An agent below the retract
 *     gate is reported `agent_unsupported` and its delivery is left as is. A
 *     retract the agent then fails is recorded as `retract_failed`
 *     (commandResults.ts);
 *   - a delivery already past its expiry needs no command: the agent dropped
 *     the card at expiry -> `retracted`.
 * Terminal deliveries are untouched. Retract is idempotent: a second call
 * reports what is still live (normally nothing).
 *
 * Runs in the request's RLS context. A site-restricted caller may retract
 * only a message whose live deliveries are all on their sites; otherwise the
 * message is left untouched (`forbidden`), so a partial retract can never
 * mark the whole message retracted.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AiOriginRef } from '@breeze/shared';
import { db } from '../../db';
import { deviceCommands, devices, endpointMessageDeliveries, endpointMessages } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { queueCommandForExecution } from '../commandQueue';
import { CommandTypes } from '../commandTypes';
import { deliveryTtlMs } from '../commandOfflinePolicy';
import { agentSupportsRetract } from '../commandMinVersion';
import { terminalPayloadErasureSet } from '../sensitiveCommandPayload';
import { canAccessSite, type UserPermissions } from '../permissions';
import { messageReachesAllowedSites } from './history';
import { transitionTimestamps, transitionWhere } from './deliveryState';

export type WithdrawFailureCode = 'agent_unsupported' | 'no_permission' | 'queue_failed' | 'offline_rejected';

export type RetractDeviceResult =
  | { deviceId: string; status: 'retracted'; via: 'not_sent' | 'cancelled' | 'command' | 'expired'; commandId?: string }
  | { deviceId: string; status: 'failed'; errorCode: WithdrawFailureCode };

export type RetractOutcome =
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; id: string; orgId: string; retractedAt: string; alreadyRetracted: boolean; results: RetractDeviceResult[] };

const LIVE: Array<'queued' | 'delivered' | 'displayed'> = ['queued', 'delivered', 'displayed'];

export type WithdrawOutcome =
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'command'; commandId: string }
  | { kind: 'failed'; errorCode: WithdrawFailureCode };

/**
 * Take one device's notify_user back: cancel it while still pending, else
 * queue retract_message (gated, capped at the message's remaining lifetime).
 * Shared by the retract route and the send loop's retract-race handling.
 */
export async function withdrawCommand(args: {
  deviceId: string;
  orgId: string;
  commandId: string | null;
  clientMessageId: string;
  expiresAt: Date;
  agentVersion: string | null;
  userId: string;
  aiOrigin?: AiOriginRef;
  now?: Date;
}): Promise<WithdrawOutcome> {
  const now = args.now ?? new Date();
  if (args.commandId) {
    const cancelled = await db.update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: now,
        result: { status: 'cancelled', reason: 'endpoint_message_retracted', cancelledBy: args.userId },
        ...terminalPayloadErasureSet(),
      })
      .where(and(
        eq(deviceCommands.id, args.commandId),
        eq(deviceCommands.deviceId, args.deviceId),
        eq(deviceCommands.status, 'pending'),
      ))
      .returning({ id: deviceCommands.id });
    if (cancelled.length > 0) return { kind: 'cancelled' };
  }

  const remainingMs = args.expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) return { kind: 'expired' };
  if (!agentSupportsRetract(args.agentVersion)) return { kind: 'failed', errorCode: 'agent_unsupported' };

  try {
    const res = await queueCommandForExecution(
      args.deviceId,
      CommandTypes.RETRACT_MESSAGE,
      { messageId: args.clientMessageId },
      {
        userId: args.userId,
        expectedOrgId: args.orgId,
        offlinePolicy: { kind: 'queue', deliverWithinMs: Math.min(Math.max(remainingMs, 1000), deliveryTtlMs('standard')) },
        aiOrigin: args.aiOrigin,
      },
    );
    if (res.error || !res.command) {
      console.error('[endpoint-messages] retract queue refused', { deviceId: args.deviceId, error: res.error });
      return {
        kind: 'failed',
        errorCode: res.trust ? 'no_permission' : res.error && /offline/i.test(res.error) ? 'offline_rejected' : 'queue_failed',
      };
    }
    return { kind: 'command', commandId: res.command.id };
  } catch (err) {
    console.error('[endpoint-messages] retract queue threw', { deviceId: args.deviceId, error: err instanceof Error ? err.message : String(err) });
    return { kind: 'failed', errorCode: 'queue_failed' };
  }
}

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
  // A message with no delivery in the caller's sites is invisible to them (same
  // rule as the list/detail). Without this, a message whose deliveries are all
  // out of scope and terminal passes the live-device check below vacuously.
  if (!(await messageReachesAllowedSites(message.id, permissions))) return { kind: 'not_found' };

  const live = await db
    .select({
      id: endpointMessageDeliveries.id,
      deviceId: endpointMessageDeliveries.deviceId,
      orgId: endpointMessageDeliveries.orgId,
      status: endpointMessageDeliveries.status,
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

  if (permissions && live.some((d) => !canAccessSite(permissions as UserPermissions, d.siteId))) {
    return { kind: 'forbidden' };
  }

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

  const markRetracted = async (deliveryId: string, retractCommandId: string | null) => {
    await db.update(endpointMessageDeliveries)
      .set({ status: 'retracted', retractCommandId, updatedAt: now, ...transitionTimestamps('retracted', now) })
      .where(transitionWhere('retracted', eq(endpointMessageDeliveries.id, deliveryId)));
  };

  const results: RetractDeviceResult[] = [];
  for (const d of live) {
    // The send has not queued this device yet: nothing can be on screen. The
    // send loop withdraws the command it is about to queue (send.ts).
    if (d.status === 'queued' && d.commandId === null) {
      await markRetracted(d.id, null);
      results.push({ deviceId: d.deviceId, status: 'retracted', via: 'not_sent' });
      continue;
    }

    const outcome = await withdrawCommand({
      deviceId: d.deviceId,
      orgId: d.orgId,
      commandId: d.commandId,
      clientMessageId: message.clientMessageId,
      expiresAt: message.expiresAt,
      agentVersion: d.agentVersion,
      userId: auth.user.id,
      aiOrigin: auth.aiOrigin,
      now,
    });
    if (outcome.kind === 'failed') {
      results.push({ deviceId: d.deviceId, status: 'failed', errorCode: outcome.errorCode });
      continue;
    }
    // Bookkeeping after the command decision, outside any catch: a throw here
    // surfaces as a 500 and a retry is safe (retract is idempotent).
    const commandId = outcome.kind === 'command' ? outcome.commandId : null;
    await markRetracted(d.id, commandId);
    results.push(commandId
      ? { deviceId: d.deviceId, status: 'retracted', via: 'command', commandId }
      : { deviceId: d.deviceId, status: 'retracted', via: outcome.kind as 'cancelled' | 'expired' });
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
