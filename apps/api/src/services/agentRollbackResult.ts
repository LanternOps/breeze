import { sql } from 'drizzle-orm';
import { db } from '../db';
import type { AgentRollbackPhase, AgentRollbackStatus } from '../db/schema';

export type RollbackObservationPhase = Exclude<AgentRollbackPhase, 'requested'>;

export interface RollbackObservationV1 {
  schemaVersion: 1;
  observationId: string;
  rollbackId: string;
  deviceId: string;
  phase: RollbackObservationPhase;
  currentVersion: string;
  targetVersion: string;
  observedAt: string;
  failureCode?: string;
}

export interface RollbackDirectiveProjection {
  id: string;
  deviceId: string;
  currentVersion: string;
  targetVersion: string;
  componentVersions: Record<string, { current: string; target: string }>;
  status: AgentRollbackStatus;
  latestPhase: AgentRollbackPhase | null;
}

export interface RollbackLiveVersions {
  agent: string;
  watchdog: string | null;
  backup: string | null;
}

export interface RollbackTransitionDecision {
  accepted: boolean;
  advance: boolean;
  status: AgentRollbackStatus;
  rejectionCode: string | null;
}

const PHASE_ORDER: Record<RollbackObservationPhase, number> = {
  received: 1,
  downloaded: 2,
  verified: 3,
  staged: 4,
  swapped: 5,
  restart_requested: 6,
  healthy: 7,
  failed: 7,
  recovered: 7,
};

const TERMINAL_STATUSES = new Set<AgentRollbackStatus>(['completed', 'failed', 'recovered', 'expired']);

function terminalStatus(phase: RollbackObservationPhase): AgentRollbackStatus {
  if (phase === 'healthy') return 'completed';
  if (phase === 'failed') return 'failed';
  if (phase === 'recovered') return 'recovered';
  return 'in_progress';
}

function liveComponentVersion(component: string, live: RollbackLiveVersions): string | null {
  if (component === 'agent') return live.agent;
  if (component === 'watchdog') return live.watchdog;
  if (component === 'backup') return live.backup;
  // The current rollback producer owns only components represented by durable
  // heartbeat columns. Fail closed if that set grows before heartbeat truth does.
  return null;
}

export function evaluateRollbackObservationTransition(input: {
  directive: RollbackDirectiveProjection;
  observation: RollbackObservationV1;
  liveVersions: RollbackLiveVersions;
}): RollbackTransitionDecision {
  const { directive, observation, liveVersions } = input;
  const unchanged = (rejectionCode: string): RollbackTransitionDecision => ({
    accepted: true,
    advance: false,
    status: directive.status,
    rejectionCode,
  });
  if (observation.deviceId !== directive.deviceId || observation.rollbackId !== directive.id) {
    return { ...unchanged('identity_mismatch'), accepted: false };
  }
  if (
    observation.currentVersion !== directive.currentVersion
    || observation.targetVersion !== directive.targetVersion
  ) {
    return { ...unchanged('version_binding_mismatch'), accepted: false };
  }
  if (TERMINAL_STATUSES.has(directive.status)) return unchanged('already_terminal');

  const priorOrder = directive.latestPhase && directive.latestPhase !== 'requested'
    ? PHASE_ORDER[directive.latestPhase]
    : 0;
  if (PHASE_ORDER[observation.phase] <= priorOrder) return unchanged('phase_not_forward');

  if (observation.phase === 'healthy') {
    const complete = Object.entries(directive.componentVersions).every(([component, versions]) =>
      versions.target === directive.targetVersion
      && liveComponentVersion(component, liveVersions) === versions.target);
    if (!complete || liveVersions.agent !== directive.targetVersion) {
      return unchanged('live_component_mismatch');
    }
  }
  return {
    accepted: true,
    advance: true,
    status: terminalStatus(observation.phase),
    rejectionCode: null,
  };
}

interface LockedDeviceRow {
  id: string;
  orgId: string;
  agentVersion: string;
  watchdogVersion: string | null;
  backupVersion: string | null;
}

interface LockedDirectiveRow extends RollbackDirectiveProjection {
  orgId: string;
}

export async function ingestRollbackObservation(
  deviceId: string,
  observation: RollbackObservationV1,
): Promise<{ acknowledgedObservationId: string | null }> {
  return db.transaction(async (tx) => {
    const deviceRows = await tx.execute(sql`
      SELECT id, org_id AS "orgId", agent_version AS "agentVersion",
             watchdog_version AS "watchdogVersion", backup_version AS "backupVersion"
      FROM devices
      WHERE id = ${deviceId}
      FOR KEY SHARE
    `) as unknown as LockedDeviceRow[];
    const device = deviceRows[0];
    if (!device || observation.deviceId !== deviceId) return { acknowledgedObservationId: null };

    const directiveRows = await tx.execute(sql`
      SELECT id, org_id AS "orgId", device_id AS "deviceId",
             current_version AS "currentVersion", target_version AS "targetVersion",
             component_versions AS "componentVersions", status, latest_phase AS "latestPhase"
      FROM agent_rollback_directives
      WHERE id = ${observation.rollbackId} AND device_id = ${deviceId}
      FOR UPDATE
    `) as unknown as LockedDirectiveRow[];
    const directive = directiveRows[0];
    if (!directive) return { acknowledgedObservationId: null };

    const decision = evaluateRollbackObservationTransition({
      directive,
      observation,
      liveVersions: {
        agent: device.agentVersion,
        watchdog: device.watchdogVersion,
        backup: device.backupVersion,
      },
    });
    if (!decision.accepted) return { acknowledgedObservationId: null };

    const liveComponentVersions = Object.fromEntries(
      Object.keys(directive.componentVersions).map((component) => [
        component,
        liveComponentVersion(component, {
          agent: device.agentVersion,
          watchdog: device.watchdogVersion,
          backup: device.backupVersion,
        }),
      ]),
    );
    const inserted = await tx.execute(sql`
      INSERT INTO agent_rollback_events (
        rollback_id, org_id, device_id, phase, observation_id, observed_at,
        current_version, component_versions, error_code, observation
      ) VALUES (
        ${directive.id}, ${directive.orgId}, ${deviceId}, ${observation.phase},
        ${observation.observationId}, ${observation.observedAt}::timestamptz,
        ${observation.currentVersion}, ${JSON.stringify(liveComponentVersions)}::jsonb,
        ${observation.failureCode ?? decision.rejectionCode}, ${JSON.stringify(observation)}::jsonb
      )
      ON CONFLICT (rollback_id, observation_id) DO NOTHING
      RETURNING id
    `) as unknown as Array<{ id: string }>;

    if (inserted.length === 0) {
      const duplicates = await tx.execute(sql`
        SELECT observation = ${JSON.stringify(observation)}::jsonb AS matches
        FROM agent_rollback_events
        WHERE rollback_id = ${directive.id} AND observation_id = ${observation.observationId}
      `) as unknown as Array<{ matches: boolean }>;
      return {
        acknowledgedObservationId: duplicates[0]?.matches ? observation.observationId : null,
      };
    }

    if (decision.advance) {
      await tx.execute(sql`
        UPDATE agent_rollback_directives
        SET latest_phase = ${observation.phase}, status = ${decision.status},
            last_error_code = ${observation.failureCode ?? null}, updated_at = NOW()
        WHERE id = ${directive.id}
          AND status = ${directive.status}
          AND latest_phase IS NOT DISTINCT FROM ${directive.latestPhase}
      `);
    }
    return { acknowledgedObservationId: observation.observationId };
  });
}
