import { and, eq, sql } from 'drizzle-orm';
import { isResolvedTerminalIsolationState } from '@breeze/shared';
import { runAfterDbContextCommit } from '../../db';
import { alerts, deviceNetworkIsolations, incidentActions, incidents, type DeviceNetworkIsolation } from '../../db/schema';
import type { IncidentTimelineEntry } from '../../db/schema/incidentResponse';
import { ALLOWED_STATUS_TRANSITIONS } from '../../routes/incidents.validation';
import { captureException } from '../sentry';
import type { EpisodeTx } from './episodeStore';
import type { EpisodeSnapshot } from './stateMachine';

/** Project a winning episode transition onto its incident. Heartbeats and command results share this. */
export async function synchronizeEpisodeOutcome(
  tx: EpisodeTx, row: DeviceNetworkIsolation, prev: EpisodeSnapshot, next: EpisodeSnapshot, at: Date,
): Promise<void> {
  if (isResolvedTerminalIsolationState(next.state)) {
    await tx.update(deviceNetworkIsolations).set({ breakGlassSecretEnc: '' }).where(eq(deviceNetworkIsolations.id, row.id));
  }
  if (prev.state !== next.state && ['released_locally', 'self_released'].includes(next.state)) {
    await tx.insert(alerts).values({ orgId: row.orgId, deviceId: row.deviceId, severity: 'critical', title: 'Network isolation released locally', message: 'Acknowledge the local release before starting a new isolation.', context: { isolationId: row.id, state: next.state }, triggeredAt: at });
  }
  if (prev.state === next.state || !row.incidentId || !row.incidentActionId) return;
  const verified = next.state === 'verified';
  const failed = next.state === 'failed';
  const released = ['released', 'expired', 'released_locally', 'self_released', 'uninstalled'].includes(next.state);
  if (!verified && !failed && !released) return;
  const status = failed ? 'failed' as const : 'completed' as const;
  const [action] = await tx.update(incidentActions).set({
    status, ...(released ? { reversed: true } : {}),
    result: { commandId: row.commandId, isolationId: row.id, generation: next.generation, state: next.state, ...(next.failureCode ? { errorCode: next.failureCode } : {}) },
  }).where(and(eq(incidentActions.id, row.incidentActionId), eq(incidentActions.orgId, row.orgId), eq(incidentActions.actionType, 'network_isolation')))
    .returning({ id: incidentActions.id, executedBy: incidentActions.executedBy });
  if (!action) return;
  const [incident] = await tx.select({ id: incidents.id, orgId: incidents.orgId, status: incidents.status })
    .from(incidents).where(and(eq(incidents.id, row.incidentId), eq(incidents.orgId, row.orgId))).limit(1).for('update');
  if (!incident) return;
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
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
