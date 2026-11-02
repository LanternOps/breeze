import { and, eq, sql } from 'drizzle-orm';
import { isTerminalIsolationState, isUnresolvedTerminalIsolationState } from '@breeze/shared';
import { runAfterDbContextCommit } from '../../db';
import { alerts, incidentActions, incidents, type DeviceNetworkIsolation } from '../../db/schema';
import type { IncidentTimelineEntry } from '../../db/schema/incidentResponse';
import { ALLOWED_STATUS_TRANSITIONS } from '../../routes/incidents.validation';
import { captureException } from '../sentry';
import type { EpisodeTx } from './episodeStore';
import type { EpisodeSnapshot } from './stateMachine';

/** Project a winning episode transition onto its incident. Heartbeats and command results share this. */
export async function synchronizeEpisodeOutcome(
  tx: EpisodeTx, row: DeviceNetworkIsolation, prev: EpisodeSnapshot, next: EpisodeSnapshot, at: Date,
): Promise<void> {
  if (prev.state !== next.state && isUnresolvedTerminalIsolationState(next.state)) {
    await tx.insert(alerts).values({ orgId: row.orgId, ownerKind: 'device', deviceId: row.deviceId, severity: 'critical', title: 'Network isolation released locally', message: 'Acknowledge the local release before starting a new isolation.', context: { isolationId: row.id, state: next.state }, triggeredAt: at });
  }
  if (prev.state === next.state || !row.incidentId || !row.incidentActionId) return;
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
