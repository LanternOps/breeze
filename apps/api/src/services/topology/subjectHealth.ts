import type { Freshness, HealthCoverage, HealthStatus } from '@breeze/shared';
import type { db } from '../../db';
import type { TopologyRequestContext } from './access';
import { interfaceMeasurementContributions, readInterfaceEvidenceRelationships, readTopologyInterfaceMeasurements } from './interfaceHealth';
import {
  overlayHealthSummary, readTopologyMonitorOverlays, topologyHealthSummary,
  type TopologyMonitorOverlay, type TopologyOverlaySubject,
} from './monitorOverlays';

/**
 * Current subject health for graph overlays, health reads and link detail
 * (M3 Task 6, amendment M3-D10).
 *
 * Health is assembled from independent CONTRIBUTIONS, each a view of evidence
 * that already exists (a reused monitor's latest result, an interface's latest
 * accepted measurement, and — once Task 7/8 land — a policy/run assessment).
 * Nothing here writes, polls or dispatches. The persisted site health revision
 * still advances only on evidence changes (sinks call
 * `advanceTopologyHealthRevision`); freshness EXPIRY is not a write: it shows
 * up in the projected content (status/freshness/reasons, hence the ETag) and in
 * `freshUntil`, the earliest moment the projection changes on its own, which
 * clients use to revalidate.
 *
 * Multi-context aggregation (replacing "last overlay per subject wins"):
 *  - only FRESH contributions with a status decide status; stale or
 *    unmonitored ones contribute reasons and coverage only;
 *  - within one context (e.g. both endpoints of one link, or one monitor
 *    context) the worst view wins — a port reporting down is not outvoted;
 *  - across contexts, a failure next to a success elsewhere is a potentially
 *    location-specific failure: `degraded` + `mixed_context_results`, never
 *    averaged green and never promoted to a global outage;
 *  - coverage is `monitored` only when every contribution is.
 */
export type TopologyHealthSource = 'monitor' | 'interface' | 'policy';
export type TopologyHealthContribution = {
  subject: TopologyOverlaySubject;
  source: TopologyHealthSource;
  /** Stable per-contribution identity (binding id, interface side, policy/context/family…); deterministic tie-breaks. */
  key: string;
  /** Aggregation context: contributions sharing it are views of one measurement context. */
  contextKey: string;
  status: HealthStatus;
  coverage: HealthCoverage;
  freshness: Freshness;
  reasons: string[];
  originNodeId: string | null;
  resultId: string | null;
  /** When this contribution's freshness lapses without new evidence (null when not fresh). */
  freshUntil: string | null;
};
export type TopologyHealthExposure = { interfaceHealth: boolean };
export type TopologyHealthReadInput = {
  executor: Pick<typeof db, 'execute'>;
  ctx: TopologyRequestContext;
  subjects: TopologyOverlaySubject[];
  now: Date;
  exposure: TopologyHealthExposure;
};
/**
 * A source of current health. Contract: read-only, bounded by `subjects`,
 * scoped to `ctx.scope`, filtered by the reader's permissions BEFORE anything
 * is counted, and never a probe/poll/command/model call.
 */
export type TopologyHealthContributor = {
  source: TopologyHealthSource;
  read(input: TopologyHealthReadInput): Promise<TopologyHealthContribution[]>;
};

export function monitorOverlayContribution(overlay: TopologyMonitorOverlay): TopologyHealthContribution {
  return {
    subject: overlay.subject, source: 'monitor', key: `monitor:${overlay.bindingId}`,
    contextKey: `monitor:${overlay.contextKey}:${overlay.family}:${overlay.metricRole}`,
    status: overlay.status, coverage: overlay.coverage, freshness: overlay.freshness, reasons: overlay.reasons,
    originNodeId: overlay.provenance.originNodeId, resultId: overlay.provenance.resultId, freshUntil: overlay.freshUntil,
  };
}

export const monitorHealthContributor: TopologyHealthContributor = {
  source: 'monitor',
  async read({ executor, ctx, subjects, now }) {
    return (await readTopologyMonitorOverlays(ctx, subjects, { executor, now })).map(monitorOverlayContribution);
  },
};

/** Port measurement health; only when the interface-health capability is exposed (implies physical). */
export const interfaceHealthContributor: TopologyHealthContributor = {
  source: 'interface',
  async read({ executor, ctx, subjects, now, exposure }) {
    if (!exposure.interfaceHealth) return [];
    const relationships = await readInterfaceEvidenceRelationships(executor, ctx.scope, subjects.filter(s => s.kind === 'relationship').map(s => s.id));
    const interfaceIds = relationships.flatMap(rel => [rel.sourceInterfaceId, rel.targetInterfaceId]).filter((id): id is string => !!id);
    const measurements = await readTopologyInterfaceMeasurements(executor, ctx.scope, interfaceIds, now);
    return relationships.flatMap(rel => interfaceMeasurementContributions(rel, measurements));
  },
};

/**
 * EXTENSION POINT (M3-D10 run/policy branch). The policy/run health path
 * (Tasks 7/8: scheduled policy occurrences and their diagnostic run
 * assessments) adds ONE `TopologyHealthContributor` with `source: 'policy'` to
 * this list — `contextKey` per policy context/family, `freshUntil` from the
 * policy cadence (max(3 × cadence, 60 s); five minutes for isolated on-demand),
 * a disabled policy contributing `coverage: 'unmonitored'` immediately. It must
 * not add a second health store or evaluator; aggregation, the graph overlay,
 * `/health`, link health and ETags pick it up unchanged.
 */
export const TOPOLOGY_HEALTH_CONTRIBUTORS: readonly TopologyHealthContributor[] = [monitorHealthContributor, interfaceHealthContributor];

export const subjectHealthKey = (subject: TopologyOverlaySubject) => `${subject.kind}:${subject.id}`;

/** Read every contributor's view, grouped by subject. */
export async function readTopologySubjectHealth(
  input: TopologyHealthReadInput,
  contributors: readonly TopologyHealthContributor[] = TOPOLOGY_HEALTH_CONTRIBUTORS,
): Promise<Map<string, TopologyHealthContribution[]>> {
  const bySubject = new Map<string, TopologyHealthContribution[]>();
  for (const contributor of contributors) {
    for (const entry of await contributor.read(input)) {
      const key = subjectHealthKey(entry.subject);
      bySubject.set(key, [...(bySubject.get(key) ?? []), entry]);
    }
  }
  return bySubject;
}

const RANK: Record<HealthStatus, number> = { unknown: 0, healthy: 1, degraded: 2, failed_check: 3 };
const decides = (c: TopologyHealthContribution) => c.freshness === 'fresh' && c.status !== 'unknown';
const MAX_REASONS = 100;

export type AggregatedSubjectHealth = { health: ReturnType<typeof overlayHealthSummary>; freshUntil: string | null };

/** Aggregate one subject's contributions into the M0 health summary shape. Pure. */
export function aggregateTopologySubjectHealth(
  scope: 'node' | 'relationship', contributions: TopologyHealthContribution[], now: Date,
): AggregatedSubjectHealth {
  const future = contributions.map(c => c.freshUntil).filter((at): at is string => !!at && Date.parse(at) > now.getTime()).sort();
  const freshUntil = future[0] ?? null;
  if (contributions.length <= 1) {
    const only = contributions[0];
    return { health: topologyHealthSummary(scope, only), freshUntil };
  }
  // Worst first, then stable key order, so the deciding contribution is deterministic.
  const ordered = [...contributions].sort((a, b) => Number(decides(b)) - Number(decides(a)) || RANK[b.status] - RANK[a.status] || a.key.localeCompare(b.key));
  const measured = ordered.filter(decides);
  const reasons: string[] = [];
  const push = (code: string) => { if (!reasons.includes(code) && reasons.length < MAX_REASONS) reasons.push(code); };
  let status: HealthStatus = 'unknown';
  if (measured.length) {
    status = measured[0]!.status;
    const contexts = new Map<string, HealthStatus>();
    for (const c of measured) contexts.set(c.contextKey, RANK[c.status] > RANK[contexts.get(c.contextKey) ?? 'unknown'] ? c.status : contexts.get(c.contextKey)!);
    const statuses = [...contexts.values()];
    if (status === 'failed_check' && statuses.includes('healthy')) { status = 'degraded'; push('mixed_context_results'); }
  }
  for (const c of ordered) for (const code of c.reasons) push(code);
  const coverages = contributions.map(c => c.coverage);
  const coverage: HealthCoverage = coverages.every(c => c === 'monitored') ? 'monitored'
    : coverages.some(c => c === 'monitored' || c === 'partial') ? 'partial'
      : coverages.every(c => c === coverages[0]) ? coverages[0]! : 'unmonitored';
  const freshness: Freshness = contributions.some(c => c.freshness === 'fresh') ? 'fresh' : contributions.some(c => c.freshness === 'stale') ? 'stale' : 'unknown';
  const decider = measured[0] ?? ordered[0]!;
  return {
    health: topologyHealthSummary(scope, { status, coverage, freshness, reasons, originNodeId: decider.originNodeId, resultId: decider.resultId }),
    freshUntil,
  };
}
