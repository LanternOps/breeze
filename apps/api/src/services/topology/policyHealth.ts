import { sql, type SQL } from 'drizzle-orm';
import type { HealthCoverage, HealthStatus } from '@breeze/shared';
import { OVERLAY_SUBJECT_LIMIT } from './monitorOverlays';
import type { TopologyHealthContribution, TopologyHealthContributor } from './subjectHealth';

/**
 * Recurring-policy health (M3-D10 run/policy branch; Tasks 7/8 scheduled
 * occurrences). A scheduled run measures from its context's origin node, so
 * the graph subject is the RUN's subject. One contribution per policy
 * context/family whose latest settled scheduled run measured a requested
 * subject:
 *  - policy disarmed → `unmonitored` immediately (blocked reason);
 *  - armed, but no settled run at the CURRENT policy revision → pending: a
 *    disarm/re-arm or any revision bump fences older results at read time,
 *    independent of sweeper timing (M3-D13);
 *  - otherwise the run's stored assessment, fresh for max(3 × cadence, 60 s).
 * Read-only and bounded by `subjects`; the run store already carries the plan
 * assessment, so nothing is re-evaluated and no second health store exists.
 */
export type PolicyHealthRow = {
  policyId: string;
  armed: boolean;
  blockedReason: string | null;
  nodeId: string | null;
  relationshipId: string | null;
  intervalSeconds: number | null;
  runId: string | null;
  /** The run belongs to the policy's current revision. */
  current: boolean;
  contextKey: string | null;
  family: string | null;
  state: string | null;
  assessment: string | null;
  coverage: string | null;
  reasons: string[] | null;
  finishedAt: Date | string | null;
  deadline: Date | string | null;
  originNodeId: string | null;
};

/** Freshness of a scheduled result: max(3 × cadence, 60 s) (operations §5, M3-D10). */
export const policyFreshnessWindowMs = (intervalSeconds: number | null) => Math.max(3 * (intervalSeconds ?? 60) * 1000, 60_000);
/** Bounded read: a site holds at most 64 policies, each with a handful of contexts per family. */
const POLICY_HEALTH_ROW_LIMIT = 1_000;
const REASON_CODE = /^[a-z][a-z0-9_]*$/;
const HEALTH_STATUSES = new Set<HealthStatus>(['healthy', 'degraded', 'failed_check']);
const code = (value: string | null | undefined, fallback: string) => (value && value.length <= 64 && REASON_CODE.test(value) ? value : fallback);
const time = (value: Date | string | null) => (value === null ? NaN : new Date(value).getTime());

export function policyHealthContribution(row: PolicyHealthRow, now: Date): TopologyHealthContribution | null {
  const subject = row.relationshipId ? { kind: 'relationship' as const, id: row.relationshipId }
    : row.nodeId ? { kind: 'node' as const, id: row.nodeId } : null;
  if (!subject) return null;
  const contextKey = `policy:${row.policyId}:${row.contextKey}:${row.family}`;
  const base = { subject, source: 'policy' as const, key: contextKey, contextKey, originNodeId: null, resultId: null, freshUntil: null };
  if (!row.armed) {
    return { ...base, status: 'unknown', coverage: 'unmonitored', freshness: 'unknown', reasons: [code(row.blockedReason, 'policy_disabled')] };
  }
  if (!row.current || !row.runId) {
    return { ...base, status: 'unknown', coverage: 'unavailable', freshness: 'unknown', reasons: ['policy_result_pending'] };
  }
  const identity = { ...base, originNodeId: row.originNodeId, resultId: row.runId };
  const finishedAt = time(row.finishedAt);
  const completed = row.state === 'completed' && Number.isFinite(finishedAt) && finishedAt <= time(row.deadline)
    && HEALTH_STATUSES.has(row.assessment as HealthStatus);
  if (!completed) {
    return { ...identity, status: 'unknown', coverage: 'unavailable', freshness: 'stale', reasons: ['policy_run_not_completed'] };
  }
  const freshUntil = finishedAt + policyFreshnessWindowMs(row.intervalSeconds);
  const fresh = now.getTime() < freshUntil;
  const coverage: HealthCoverage = row.coverage === 'complete' ? 'monitored' : row.coverage === 'partial' ? 'partial' : 'unavailable';
  const reasons = (row.reasons ?? []).filter((reason) => typeof reason === 'string' && reason.length <= 64 && REASON_CODE.test(reason)).slice(0, 20);
  return {
    ...identity, status: row.assessment as HealthStatus, coverage, freshness: fresh ? 'fresh' : 'stale',
    reasons: fresh ? reasons : [...reasons, 'policy_result_stale'], freshUntil: fresh ? new Date(freshUntil).toISOString() : null,
  };
}

function uuidArray(values: string[]): SQL {
  if (!values.length) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}::uuid`), sql`, `)}]::uuid[]`;
}

export const policyHealthContributor: TopologyHealthContributor = {
  source: 'policy',
  async read({ executor, ctx, subjects, now }) {
    const nodeIds = [...new Set(subjects.filter((s) => s.kind === 'node').map((s) => s.id))].slice(0, OVERLAY_SUBJECT_LIMIT);
    const relationshipIds = [...new Set(subjects.filter((s) => s.kind === 'relationship').map((s) => s.id))].slice(0, OVERLAY_SUBJECT_LIMIT);
    if (!nodeIds.length && !relationshipIds.length) return [];
    const rows = await executor.execute<PolicyHealthRow>(sql`
      SELECT p.id AS "policyId", (p.enabled AND p.authority_digest IS NOT NULL) AS "armed", p.blocked_reason AS "blockedReason",
             (p.definition->>'intervalSeconds')::int AS "intervalSeconds",
             r.id AS "runId", (r.policy_revision = p.revision) AS "current", r.subject_node_id AS "nodeId", r.subject_relationship_id AS "relationshipId",
             r.scheduled_context_key AS "contextKey", r.scheduled_family AS "family", r.state, r.assessment, r.coverage, r.reasons,
             r.finished_at AS "finishedAt", r.deadline, r.origin_node_id AS "originNodeId"
        FROM topology_monitoring_policies p
        JOIN LATERAL (
          SELECT DISTINCT ON (dr.scheduled_context_key, dr.scheduled_family) dr.*
            FROM topology_diagnostic_runs dr
           WHERE dr.org_id = p.org_id AND dr.site_id = p.site_id AND dr.policy_id = p.id AND dr.scheduled_for IS NOT NULL
             AND dr.state IN ('completed', 'failed', 'cancelled', 'expired')
             AND (dr.subject_node_id = ANY(${uuidArray(nodeIds)}) OR dr.subject_relationship_id = ANY(${uuidArray(relationshipIds)}))
           ORDER BY dr.scheduled_context_key, dr.scheduled_family, (dr.policy_revision = p.revision) DESC, dr.scheduled_for DESC, dr.id
        ) r ON true
       WHERE p.org_id = ${ctx.scope.orgId}::uuid AND p.site_id = ${ctx.scope.siteId}::uuid AND p.deleted_at IS NULL
       ORDER BY p.id, r.scheduled_context_key, r.scheduled_family
       LIMIT ${POLICY_HEALTH_ROW_LIMIT}`);
    return rows.map((row) => policyHealthContribution(row, now)).filter((c): c is TopologyHealthContribution => c !== null);
  },
};
