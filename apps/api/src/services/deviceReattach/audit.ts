/**
 * Audit rows of the reattach lifecycle (#8318 spec §6.4 "Records", §6.3
 * "Signal"). A reattach touches two orgs — the target's and the source's
 * (a customer org, or the partner's holding org for a parked source) — so
 * every event is written in BOTH, with the same details, the requester as
 * actor where there is one. One row when both devices share an org.
 *
 * Written after the transaction commits (audit rows always go through their
 * own system transaction, services/auditService.ts), durable and bounded:
 * each row goes through createAuditLogAsync, whose bounded retry queue owns a
 * failed write, and the caller waits at most AUDIT_WAIT_MS for the first
 * attempts before answering (an agent's response must not hang on a slow
 * audit insert; the write carries on in the background).
 */
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLogAsync } from '../auditService';

/** How long a caller waits for the audit writes before answering anyway. */
export const AUDIT_WAIT_MS = 3_000;

export type ReattachAuditAction =
  | 'device.reinstall.requested'
  | 'device.reinstall.staged'
  | 'device.reinstall.cancelled'
  | 'device.reinstall.expired'
  | 'device.reinstall.reattached';

export interface ReattachAuditEvent {
  action: ReattachAuditAction;
  /** The requester (or the admin who cancelled); null = the system. */
  actorUserId: string | null;
  /** Set when the event is written for the agent's own call (phase 1). */
  actorAgentId?: string | null;
  targetOrgId: string;
  sourceOrgId: string;
  targetDeviceId: string;
  targetHostname?: string | null;
  result?: 'success' | 'denied';
  details: Record<string, unknown>;
  initiatedBy?: 'manual' | 'agent' | 'schedule';
}

export async function writeReattachAudit(
  event: ReattachAuditEvent,
  options: { waitMs?: number } = {},
): Promise<void> {
  const orgIds = [...new Set([event.targetOrgId, event.sourceOrgId])];
  // audit_logs.actor_id is a uuid: an agent id (64 hex) goes into the details,
  // with the anonymous actor id, as writeAuditEvent does for any non-uuid actor.
  const agentActor = !event.actorUserId && event.actorAgentId ? event.actorAgentId : null;
  const writes = Promise.all(orgIds.map((orgId) => createAuditLogAsync({
    orgId,
    actorType: event.actorUserId ? 'user' : agentActor ? 'agent' : 'system',
    actorId: event.actorUserId ?? ANONYMOUS_ACTOR_ID,
    action: event.action,
    resourceType: 'device',
    resourceId: event.targetDeviceId,
    ...(event.targetHostname ? { resourceName: event.targetHostname } : {}),
    details: {
      ...event.details,
      ...(agentActor ? { actorAgentId: agentActor } : {}),
      auditOrgRole: orgId === event.targetOrgId ? 'target' : 'source',
    },
    result: event.result ?? 'success',
    initiatedBy: event.initiatedBy ?? (event.actorUserId ? 'manual' : 'schedule'),
  })));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    writes.then(() => 'written' as const),
    new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), options.waitMs ?? AUDIT_WAIT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  if (waited === 'timeout') {
    console.warn(`[deviceReattach] audit ${event.action} still being written after ${options.waitMs ?? AUDIT_WAIT_MS} ms; answering without waiting (the retry queue owns it)`);
  }
}
