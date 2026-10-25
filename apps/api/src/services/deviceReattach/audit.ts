/**
 * Audit rows of the reattach lifecycle (#8318 spec §6.4 "Records", §6.3
 * "Signal"). A reattach touches two orgs — the target's and the source's
 * (a customer org, or the partner's holding org for a parked source) — so
 * every event is written in BOTH, with the same details, the requester as
 * actor where there is one. One row when both devices share an org.
 *
 * Written after the transaction commits, awaited, each failure isolated: the
 * state change already happened and an audit failure must not undo it.
 */
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLog } from '../auditService';
import { captureException } from '../sentry';

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

export async function writeReattachAudit(event: ReattachAuditEvent): Promise<void> {
  const orgIds = [...new Set([event.targetOrgId, event.sourceOrgId])];
  for (const orgId of orgIds) {
    try {
      await createAuditLog({
        orgId,
        actorType: event.actorUserId ? 'user' : event.actorAgentId ? 'agent' : 'system',
        actorId: event.actorUserId ?? event.actorAgentId ?? ANONYMOUS_ACTOR_ID,
        action: event.action,
        resourceType: 'device',
        resourceId: event.targetDeviceId,
        ...(event.targetHostname ? { resourceName: event.targetHostname } : {}),
        details: {
          ...event.details,
          auditOrgRole: orgId === event.targetOrgId ? 'target' : 'source',
        },
        result: event.result ?? 'success',
        initiatedBy: event.initiatedBy ?? (event.actorUserId ? 'manual' : 'schedule'),
      });
    } catch (err) {
      console.error(`[deviceReattach] audit ${event.action} failed for org ${orgId}:`, err);
      captureException(err);
    }
  }
}
