import { and, asc, isNull } from 'drizzle-orm';
import {
  topologyMonitoringStatusSchema,
  topologyPolicyAlertStateSchema,
  type TopologyMonitoringStatus,
  type TopologyPolicyDefinition,
} from '@breeze/shared';
import { db } from '../../db';
import { topologyMonitoringPolicies } from '../../db/schema';
import { requireTopologySiteAccess, type TopologyRequestContext } from './access';
import { listTopologyTelemetryArms } from './telemetryArms';
import { scopedWrite } from './writes';

/**
 * Bounded, side-effect-free monitoring status for one site (M3-D12 read
 * surface): per-policy arm state, cadence, thresholds and per-context streaks,
 * plus the standing telemetry arms. Never returns the frozen actor, contexts'
 * source bindings or credentials.
 */
export async function getTopologyMonitoringStatus(ctx: TopologyRequestContext): Promise<TopologyMonitoringStatus> {
  const current = await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'read');
  const rows = await db
    .select()
    .from(topologyMonitoringPolicies)
    .where(and(scopedWrite(current.scope, topologyMonitoringPolicies), isNull(topologyMonitoringPolicies.deletedAt)))
    .orderBy(asc(topologyMonitoringPolicies.key))
    .limit(64);
  const telemetryArms = await listTopologyTelemetryArms(current);
  return topologyMonitoringStatusSchema.parse({
    siteId: current.scope.siteId,
    policies: rows.map((row) => {
      const definition = row.definition as TopologyPolicyDefinition;
      const state = topologyPolicyAlertStateSchema.safeParse(row.alertState);
      return {
        policyId: row.id,
        key: row.key,
        recipeId: definition.recipeId,
        enabled: row.enabled,
        activationIntent: row.activationIntent,
        blockedReason: row.blockedReason,
        intervalSeconds: definition.intervalSeconds,
        failureThreshold: definition.failureThreshold,
        recoveryThreshold: definition.recoveryThreshold,
        nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null,
        lastScheduledAt: row.lastScheduledAt?.toISOString() ?? null,
        streaks: state.success
          ? state.data.entries.map((e) => ({
            contextKey: e.contextKey,
            family: e.family,
            consecutiveFailures: e.consecutiveFailures,
            consecutiveSuccesses: e.consecutiveSuccesses,
            activeAlertId: e.activeAlertId,
            lastAppliedScheduledFor: e.lastAppliedScheduledFor,
          }))
          : [],
      };
    }),
    telemetryArms,
  });
}
