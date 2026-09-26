import { sql } from 'drizzle-orm';
import { TOPOLOGY_COVERAGE_REASON_CODES, type CoverageReason, type CoverageReasonCode, type GraphResponse, type TopologyScope, type TopologyView } from '@breeze/shared';
import type { db } from '../../db';
import { scoped } from './graphRead';
import { TOPOLOGY_TELEMETRY_PROTOCOL } from './interfaceMetricTypes';

/**
 * Physical graph coverage (M2 D11). Computed from AUTHORIZED EXPECTED scopes —
 * recent discovery dispatch snapshots and UniFi controller sites mapped to this
 * site — plus the collection sources they produced, so a scope that never
 * reported still shows. Every failure mode keeps its own reason; a
 * complete-empty scope is never whole-site completeness. Read-only.
 */
type Coverage = GraphResponse['coverage'];
type ReadTx = Pick<typeof db, 'execute'>;

export type CoverageSourceRow = {
  producerKind: 'discovery' | 'unifi' | 'snmp'; producerId: string; protocol: string; contextKey: string;
  lastOutcome: string; reasonCode: string | null; rowCount: number | null;
  freshUntil: string | null; lastReceivedAt: string | null;
};
export type CoverageDispatchRow = { jobId: string; deviceId: string; dispatchedAt: string; deadline: string };
export type CoverageMappingRow = { controllerSiteId: string; collectorIds: string[] };
export type PhysicalCoverageInput = {
  physicalExposed: boolean;
  dispatches: CoverageDispatchRow[];
  sources: CoverageSourceRow[];
  mappings: CoverageMappingRow[];
  controllerNotes: { reason: string }[];
  unresolvedCount: number;
  now: Date;
};

const MESSAGES: Record<CoverageReasonCode, string> = {
  topology_preparing: 'No topology snapshot has been published.',
  legacy_evidence_only: 'This snapshot contains inventory and legacy assertions; discovery coverage and health have not been established.',
  projection_bounded: 'Some canonical nodes or connections are outside this bounded projection.',
  physical_disabled: 'Physical topology is turned off for this organization.',
  no_collector: 'No collector is configured to report physical connections for this site.',
  collection_pending: 'A physical collection is in progress and has not reported yet.',
  collection_not_received: 'An authorized physical collection did not report before its deadline.',
  collection_complete_empty: 'A collection completed but found no neighbors; this does not mean the whole site is covered.',
  collection_unsupported: 'A device does not support a requested physical protocol.',
  collection_timeout: 'A physical collection timed out.',
  collection_failed: 'A physical collection failed.',
  collection_partial_limit: 'A physical collection hit its row limit; some rows were omitted.',
  collection_partial: 'A physical collection returned only part of its tables.',
  collection_not_attempted: 'A requested physical scope was not attempted.',
  collection_stale: 'Physical evidence has not been confirmed recently.',
  credentials_missing: 'No usable SNMP credentials are configured for a target.',
  credentials_rejected: 'A target rejected the configured SNMP credentials.',
  interface_unresolved: 'Some connections were reported on ports that could not be identified.',
  controller_site_unmapped: 'A UniFi controller site is not mapped to a Breeze site.',
  controller_site_other_org: 'A UniFi controller site is mapped to another organization.',
};
const ORDER = new Map(TOPOLOGY_COVERAGE_REASON_CODES.map((code, index) => [code, index]));
export function coverageReason(code: CoverageReasonCode, count?: number): CoverageReason {
  return { code, message: MESSAGES[code], ...(count === undefined ? {} : { count }) };
}
export const legacyCoverage = (): Coverage => ({ state: 'limited', reasons: [coverageReason('legacy_evidence_only')] });

/** Section outcome + collector reason → one distinct coverage reason, or null when the scope is covered. */
function sourceReason(row: CoverageSourceRow, now: Date): CoverageReasonCode | null {
  const reason = row.reasonCode ?? '';
  switch (row.lastOutcome) {
    case 'complete':
      if (!row.rowCount) return 'collection_complete_empty';
      return row.freshUntil && Date.parse(row.freshUntil) <= now.getTime() ? 'collection_stale' : null;
    case 'partial':
      return reason === 'limit_exceeded' ? 'collection_partial_limit' : 'collection_partial';
    case 'unsupported': return 'collection_unsupported';
    case 'not_attempted': return 'collection_not_attempted';
    case 'failed':
      if (reason === 'timeout') return 'collection_timeout';
      if (reason === 'no_usable_credentials') return 'credentials_missing';
      if (reason === 'authentication' || reason === 'access_denied') return 'credentials_rejected';
      return 'collection_failed';
    default: return 'collection_failed';
  }
}

export function summarizePhysicalCoverage(input: PhysicalCoverageInput): Coverage {
  if (!input.physicalExposed) return { state: 'unknown', reasons: [coverageReason('physical_disabled')] };
  const counts = new Map<CoverageReasonCode, number>();
  const add = (code: CoverageReasonCode, n = 1) => counts.set(code, (counts.get(code) ?? 0) + n);
  const received = (row: CoverageSourceRow) => row.lastReceivedAt ? Date.parse(row.lastReceivedAt) : -Infinity;
  for (const dispatch of input.dispatches) {
    const reported = input.sources.some((row) => row.producerKind === 'discovery' && row.producerId === dispatch.deviceId && received(row) >= Date.parse(dispatch.dispatchedAt));
    if (!reported) add(Date.parse(dispatch.deadline) > input.now.getTime() ? 'collection_pending' : 'collection_not_received');
  }
  for (const mapping of input.mappings) {
    if (!mapping.collectorIds.length) { add('no_collector'); continue; }
    for (const collectorId of mapping.collectorIds) {
      const key = `${collectorId}:${mapping.controllerSiteId}`;
      if (!input.sources.some((row) => row.producerKind === 'unifi' && row.contextKey === key)) add('collection_not_received');
    }
  }
  for (const row of input.sources) { const code = sourceReason(row, input.now); if (code) add(code); }
  for (const note of input.controllerNotes) add(note.reason === 'controller_site_other_org' ? 'controller_site_other_org' : 'controller_site_unmapped');
  if (input.unresolvedCount > 0) add('interface_unresolved', input.unresolvedCount);
  const expected = input.dispatches.length + input.mappings.length + input.sources.length + input.controllerNotes.length;
  if (!expected) return { state: 'unknown', reasons: [coverageReason('no_collector')] };
  const reasons = [...counts].sort(([a], [b]) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0)).map(([code, count]) => coverageReason(code, count));
  if (!reasons.length) return { state: 'complete', reasons: [] };
  return { state: reasons.every((r) => r.code === 'no_collector') ? 'unknown' : 'limited', reasons };
}

const iso = (value: string | Date | null) => value === null ? null : new Date(value).toISOString();

/** Scoped, bounded reads of the expected physical scopes. SELECT only. */
async function readPhysicalCoverageInput(tx: ReadTx, scope: TopologyScope, now: Date): Promise<PhysicalCoverageInput> {
  const dispatches = await tx.execute<{ jobId: string; deviceId: string; dispatchedAt: string; deadline: string | Date }>(sql`
    SELECT DISTINCT ON (j.profile_id) j.id AS "jobId", j.topology_dispatch->>'deviceId' AS "deviceId",
      j.topology_dispatch->>'dispatchedAt' AS "dispatchedAt", j.topology_deadline_at AS deadline
    FROM discovery_jobs j WHERE j.org_id = ${scope.orgId}::uuid AND j.site_id = ${scope.siteId}::uuid
      AND j.topology_dispatch IS NOT NULL AND j.topology_deadline_at > now() - interval '7 days'
    ORDER BY j.profile_id, j.topology_deadline_at DESC LIMIT 100`);
  const sources = await tx.execute<Omit<CoverageSourceRow, 'rowCount' | 'freshUntil' | 'lastReceivedAt'> & { rowCount: string | null; freshUntil: string | Date | null; lastReceivedAt: string | Date | null }>(sql`
    SELECT cs.producer_kind AS "producerKind", cs.producer_id::text AS "producerId", cs.protocol, cs.context_key AS "contextKey",
      cs.last_outcome AS "lastOutcome", cs.current_baseline->'section'->>'reasonCode' AS "reasonCode",
      cs.current_baseline->'section'->>'rowCount' AS "rowCount", cs.fresh_until AS "freshUntil", cs.last_received_at AS "lastReceivedAt"
    FROM topology_collection_sources cs WHERE ${scoped(scope, 'cs')}
      AND cs.producer_kind IN ('discovery','unifi','snmp') AND cs.protocol <> ${TOPOLOGY_TELEMETRY_PROTOCOL} AND cs.revoked_at IS NULL
    ORDER BY cs.id LIMIT 2000`);
  const mappings = await tx.execute<{ controllerSiteId: string; collectorIds: string[] | null }>(sql`
    SELECT m.unifi_site_id AS "controllerSiteId",
      (SELECT array_agg(c.id::text ORDER BY c.id) FROM unifi_collectors c WHERE c.integration_id = m.integration_id AND c.org_id = m.org_id
        AND c.is_enabled AND (c.unifi_host_id = m.unifi_host_id OR (c.unifi_host_id IS NULL AND c.id::text = m.unifi_host_id))) AS "collectorIds"
    FROM unifi_site_mappings m WHERE m.org_id = ${scope.orgId}::uuid AND m.site_id = ${scope.siteId}::uuid
    ORDER BY m.id LIMIT 200`);
  // Controller sites seen by collectors installed at this site that produced no topology here.
  const controllerNotes = await tx.execute<{ reason: string }>(sql`
    SELECT cs.topology_coverage_reason AS reason FROM unifi_controller_sites cs JOIN unifi_collectors c ON c.id = cs.collector_id AND c.org_id = cs.org_id
    WHERE cs.org_id = ${scope.orgId}::uuid AND c.site_id = ${scope.siteId}::uuid AND cs.topology_coverage_reason IS NOT NULL
    ORDER BY cs.id LIMIT 200`);
  const [unresolved] = await tx.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM topology_relationships r WHERE ${scoped(scope, 'r')} AND r.deleted_at IS NULL AND r.lifecycle = 'active'
      AND r.kind IN ('physical_link','attachment') AND r.attributes->'physical'->>'resolution' = 'unresolved'`);
  return {
    physicalExposed: true, now,
    dispatches: dispatches.filter((d) => d.deviceId && d.dispatchedAt).map((d) => ({ ...d, deadline: iso(d.deadline)! })),
    sources: sources.map((row) => ({ ...row, rowCount: row.rowCount === null ? null : Number(row.rowCount), freshUntil: iso(row.freshUntil), lastReceivedAt: iso(row.lastReceivedAt) })),
    mappings: mappings.map((m) => ({ controllerSiteId: m.controllerSiteId, collectorIds: m.collectorIds ?? [] })),
    controllerNotes: [...controllerNotes],
    unresolvedCount: Number(unresolved?.count ?? 0),
  };
}

/** Coverage for one view. Logical (and overview with physical off) keep the M0/M1 explanation. */
export async function readGraphCoverage(tx: ReadTx, scope: TopologyScope, view: TopologyView, physicalExposed: boolean, now = new Date()): Promise<Coverage> {
  if (view === 'logical') return legacyCoverage();
  if (!physicalExposed) return view === 'physical' ? summarizePhysicalCoverage({ physicalExposed: false, dispatches: [], sources: [], mappings: [], controllerNotes: [], unresolvedCount: 0, now }) : legacyCoverage();
  const coverage = summarizePhysicalCoverage(await readPhysicalCoverageInput(tx, scope, now));
  // Overview also carries inventory and logical relationships whose coverage
  // physical collection does not establish: never claim it complete.
  if (view === 'overview' && coverage.state === 'complete') return legacyCoverage();
  return coverage;
}
