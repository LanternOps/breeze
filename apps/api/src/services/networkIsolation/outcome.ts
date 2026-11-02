import { and, eq, sql } from 'drizzle-orm';
import { isTerminalIsolationState, isUnresolvedTerminalIsolationState } from '@breeze/shared';
import { runAfterDbContextCommit } from '../../db';
import { alerts, incidentActions, incidents, type DeviceNetworkIsolation } from '../../db/schema';
import type { IncidentTimelineEntry } from '../../db/schema/incidentResponse';
import { ALLOWED_STATUS_TRANSITIONS } from '../../routes/incidents.validation';
import { captureException } from '../sentry';
import { alertOwnerKey } from '../alertOwner';
import { resolveDeviceSiteId } from '../deviceSiteResolver';
import type { EpisodeTx } from './episodeStore';
import type { EpisodeSnapshot } from './stateMachine';

/** Only called for a winning state change; publish after its transaction commits. */
function publishTransitionAfterCommit(row: DeviceNetworkIsolation, next: EpisodeSnapshot): void {
  if (next.state !== 'verified' && !isTerminalIsolationState(next.state)) return;
  const payload = {
    orgId: row.orgId, deviceId: row.deviceId, isolationId: row.id,
    generation: next.generation, incidentId: row.incidentId, state: next.state,
    ...(next.failureCode ? { failureCode: next.failureCode } : {}),
    ...(isTerminalIsolationState(next.state) && next.state !== 'failed' ? { releaseKind: next.releaseKind } : {}),
  };
  runAfterDbContextCommit('networkIsolation.transition', async () => {
    try {
      const { publishEvent } = await import('../eventBus');
      switch (payload.state) {
        case 'verified':
          await publishEvent('device.isolated', row.orgId, payload, 'network-isolation-result');
          break;
        case 'failed':
          await publishEvent('device.isolation_failed', row.orgId, payload, 'network-isolation-result');
          break;
        case 'self_released':
          await publishEvent('device.isolation_self_released', row.orgId, payload, 'network-isolation-result');
          break;
        case 'released':
        case 'expired':
        case 'released_locally':
        case 'uninstalled':
          await publishEvent('device.isolation_released', row.orgId, payload, 'network-isolation-result');
          break;
      }
    } catch (err) {
      const tags = { phase: 'isolation_outcome_publish', isolationId: payload.isolationId, incidentId: payload.incidentId ?? 'none', state: payload.state };
      console.error('[isolation] transition event publish failed', tags);
      captureException(err, undefined, tags);
    }
  });
}

/** Project a winning episode transition onto its incident. Heartbeats and command results share this. */
export async function synchronizeEpisodeOutcome(
  tx: EpisodeTx, row: DeviceNetworkIsolation, prev: EpisodeSnapshot, next: EpisodeSnapshot, at: Date,
): Promise<void> {
  if (prev.state === next.state) return;
  // The transition transaction is the deduplication boundary: no second writer
  // can win the same state change. Alert insertion rolls back with that change.
  if (next.state === 'failed' || isUnresolvedTerminalIsolationState(next.state)) {
    const failed = next.state === 'failed';
    const selfReleased = next.state === 'self_released';
    const fields = {
      orgId: row.orgId, ownerKind: 'device', deviceId: row.deviceId,
      severity: failed ? 'high' : 'critical',
      title: failed ? 'Network isolation failed' : selfReleased ? 'Network isolation self-released' : 'Network isolation released locally',
      message: failed ? 'Network isolation failed. Review the incident before retrying.'
        : selfReleased ? 'Network isolation released through the dead-man safeguard. Acknowledge the release before starting a new isolation.'
          : 'Acknowledge the local release before starting a new isolation.',
      context: {
        source: 'network_isolation', isolationId: row.id, generation: next.generation, state: next.state,
        ...(next.failureCode ? { failureCode: next.failureCode } : {}),
        ...(next.releaseKind ? { releaseKind: next.releaseKind } : {}),
      },
      triggeredAt: at,
    } satisfies typeof alerts.$inferInsert;
    const [alert] = await tx.insert(alerts).values({ ...fields, ownerKind: 'device', deviceId: row.deviceId }).returning({ id: alerts.id });
    if (!alert) throw new Error('isolation_alert_insert_missing');
    // Resolve under the transition's DB context, before the post-commit callback
    // leaves that context. The resolver preserves fail-closed site attribution.
    const siteId = await resolveDeviceSiteId(row.deviceId);
    const payload = {
      alertId: alert.id, ruleId: null, severity: fields.severity, title: fields.title, message: fields.message,
      ...fields.context, incidentId: row.incidentId, deviceId: row.deviceId,
      monitorId: null, kind: null, owner: null,
      ownerKey: alertOwnerKey({
        ownerKind: 'device', ownerRef: null, deviceId: row.deviceId, topologySiteId: null, topologySourceKey: null,
      }),
    };
    const orgId = row.orgId;
    runAfterDbContextCommit('networkIsolation.alert', async () => {
      try {
        const { publishEvent } = await import('../eventBus');
        await publishEvent('alert.triggered', orgId, payload, 'network-isolation-result', { siteId });
      } catch (err) {
        const tags = { phase: 'isolation_alert_publish', alertId: payload.alertId, orgId, deviceId: payload.deviceId,
          isolationId: payload.isolationId, incidentId: payload.incidentId ?? 'none' };
        console.error('[isolation] alert event publish failed', tags);
        captureException(err, undefined, tags);
      }
    });
  }
  // Independent of incident linkage: detached history still produces events.
  publishTransitionAfterCommit(row, next);
  if (!row.incidentId || !row.incidentActionId) return;
  const verified = next.state === 'verified';
  const failed = next.state === 'failed';
  const released = isTerminalIsolationState(next.state) && !failed;
  if (!verified && !failed && !released) return;
  const status = failed ? 'failed' as const : 'completed' as const;
  const [action] = await tx.update(incidentActions).set({
    status, ...(released ? { reversed: true } : {}),
    result: { commandId: row.commandId, isolationId: row.id, generation: next.generation, state: next.state, ...(next.failureCode ? { errorCode: next.failureCode } : {}) },
  }).where(and(eq(incidentActions.id, row.incidentActionId), eq(incidentActions.orgId, row.orgId), eq(incidentActions.actionType, 'network_isolation')))
    .returning({ id: incidentActions.id, executedBy: incidentActions.executedBy });
  if (!action) {
    const tags = { isolationId: row.id, incidentId: row.incidentId, incidentActionId: row.incidentActionId };
    console.error('[isolation] incident action missing', tags);
    captureException(new Error('isolation_incident_action_missing'), undefined, tags);
    return;
  }
  const [incident] = await tx.select({ id: incidents.id, orgId: incidents.orgId, status: incidents.status })
    .from(incidents).where(and(eq(incidents.id, row.incidentId), eq(incidents.orgId, row.orgId))).limit(1).for('update');
  if (!incident) {
    const tags = { isolationId: row.id, incidentId: row.incidentId, incidentActionId: row.incidentActionId };
    console.error('[isolation] incident missing', tags);
    captureException(new Error('isolation_incident_missing'), undefined, tags);
    return;
  }
  const contains = verified && incident.status !== 'contained' && ALLOWED_STATUS_TRANSITIONS[incident.status].includes('contained');
  const entry: IncidentTimelineEntry = {
    at: at.toISOString(), type: verified ? 'containment_executed' : failed ? 'containment_failed' : 'containment_released',
    actor: action.executedBy, summary: `Network isolation ${next.state}`,
    metadata: { isolationId: row.id, actionId: action.id, generation: next.generation, state: next.state, ...(next.failureCode ? { errorCode: next.failureCode } : {}) },
  };
  await tx.update(incidents).set({
    timeline: sql`coalesce(${incidents.timeline}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`, updatedAt: at,
    ...(contains ? { status: 'contained' as const, containedAt: at } : {}),
  }).where(and(eq(incidents.id, incident.id), eq(incidents.orgId, row.orgId)));
  if (contains) runAfterDbContextCommit('networkIsolation.contained', async () => {
    try {
      const { publishEvent } = await import('../eventBus');
      await publishEvent('incident.contained', row.orgId, { incidentId: incident.id, actionId: action.id, actionType: 'network_isolation', executedBy: action.executedBy, status }, 'network-isolation-result');
    } catch (err) {
      const tags = { phase: 'isolation_outcome_publish', isolationId: row.id, incidentId: incident.id, incidentActionId: action.id };
      console.error('[isolation] incident event publish failed', tags);
      captureException(err, undefined, tags);
    }
  });
}
