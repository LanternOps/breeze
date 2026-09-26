import { describe, expect, it } from 'vitest';
import {
  TOPOLOGY_CHANGES_LIMITS,
  TOPOLOGY_IMPACT_LIMITS,
  topologyChangePageSchema,
  topologyChangesQuerySchema,
  topologyImpactQuerySchema,
  topologyImpactResponseSchema,
} from './topologyInvestigation';
import * as barrel from './index';

const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const RUN = '50000000-0000-4000-8000-000000000001';
const at = '2026-09-26T10:00:00.000Z';

const impact = () => ({
  siteId: SITE, graphRevision: '7', healthRevision: '3',
  subject: { kind: 'relationship', id: REL, measured: true },
  window: { minutes: 5, from: '2026-09-26T09:55:00.000Z', to: at },
  measuredFailures: [{ kind: 'relationship', id: REL, status: 'failed_check', evidenceIds: [`interface:${NODE}`], reasons: [] }],
  potentiallyAffected: [{ kind: 'node', id: NODE, label: 'switch-1', basis: 'dependency_path', hops: 1,
    reasons: ['no_known_alternative_path', 'path_via_attachment'], evidenceIds: [REL] }],
  alternatives: [],
  routedPaths: [{ runId: RUN, stepId: RUN, kind: 'observed_routed_path', destinationReached: false, respondingHops: 2, gapHops: 1, truncated: false, finishedAt: at }],
  causeSuggestion: { state: 'not_suggested', corroboratingIds: [], reasons: ['no_corroborating_failures'] },
  assumptions: ['shortest_path_dependency_model'],
  coverage: 'complete', reasons: [],
  counts: { nodes: 3, relationships: 2, potentiallyAffected: 1, omittedPotentiallyAffected: 0 },
  evidence: [{ id: REL, kind: 'relationship' }, { id: `interface:${NODE}`, kind: 'interface_measurement' }],
  asOf: at,
});

describe('topology impact contract', () => {
  it('defaults the correlation window to five minutes and bounds it to 1-30', () => {
    expect(topologyImpactQuerySchema.parse({ subjectKind: 'node', subjectId: NODE })).toEqual({ subjectKind: 'node', subjectId: NODE, windowMinutes: 5 });
    expect(topologyImpactQuerySchema.safeParse({ subjectKind: 'node', subjectId: NODE, windowMinutes: 0 }).success).toBe(false);
    expect(topologyImpactQuerySchema.safeParse({ subjectKind: 'node', subjectId: NODE, windowMinutes: 31 }).success).toBe(false);
    expect(topologyImpactQuerySchema.safeParse({ subjectKind: 'group', subjectId: NODE }).success).toBe(false);
    expect(topologyImpactQuerySchema.safeParse({ subjectKind: 'node', subjectId: NODE, graphRevision: '-1' }).success).toBe(false);
    expect(topologyImpactQuerySchema.safeParse({ subjectKind: 'node', subjectId: NODE, suppress: true }).success).toBe(false);
  });

  it('accepts a cited, bounded impact response and publishes the traversal bounds', () => {
    expect(topologyImpactResponseSchema.parse(impact())).toBeTruthy();
    expect(TOPOLOGY_IMPACT_LIMITS).toMatchObject({ maxNodes: 10_000, maxRelationships: 20_000, deadlineMs: 2_000 });
  });

  it('never lets a possible dependency masquerade as a measured failure or a certain claim', () => {
    const body = impact();
    // A potentially-affected entry must state its uncertainty: one of the path-availability reasons is required.
    expect(topologyImpactResponseSchema.safeParse({ ...body, potentiallyAffected: [{ ...body.potentiallyAffected[0], reasons: ['path_via_attachment'] }] }).success).toBe(false);
    // A measured failure is a failure status only.
    expect(topologyImpactResponseSchema.safeParse({ ...body, measuredFailures: [{ ...body.measuredFailures[0], status: 'healthy' }] }).success).toBe(false);
    // Alternatives are never presented as verified.
    expect(topologyImpactResponseSchema.safeParse({ ...body, alternatives: [{ nodeId: NODE, relationshipIds: [REL], state: 'verified', reasons: [] }] }).success).toBe(false);
    // No suppression/closure verbs exist on the wire.
    expect(topologyImpactResponseSchema.safeParse({ ...body, suppressedAlertIds: [] }).success).toBe(false);
  });

  it('rejects an unbounded result', () => {
    const body = impact();
    const many = Array.from({ length: TOPOLOGY_IMPACT_LIMITS.maxPotentiallyAffected + 1 }, () => body.potentiallyAffected[0]);
    expect(topologyImpactResponseSchema.safeParse({ ...body, potentiallyAffected: many }).success).toBe(false);
    expect(topologyImpactResponseSchema.safeParse({ ...body, potentiallyAffected: [{ ...body.potentiallyAffected[0], evidenceIds: Array(33).fill(REL) }] }).success).toBe(false);
  });

  it('is exported through the validator barrel', () => {
    expect(barrel.topologyImpactResponseSchema).toBe(topologyImpactResponseSchema);
    expect(barrel.topologyChangePageSchema).toBe(topologyChangePageSchema);
  });
});

describe('topology change history contract', () => {
  const window = { since: '2026-09-26T00:00:00Z', until: '2026-09-26T12:00:00Z' };
  it('defaults to 50 rows, caps at 200 and bounds the window to 24 hours', () => {
    expect(topologyChangesQuerySchema.parse(window)).toEqual({ ...window, limit: 50 });
    expect(topologyChangesQuerySchema.safeParse({ ...window, limit: TOPOLOGY_CHANGES_LIMITS.maxLimit + 1 }).success).toBe(false);
    expect(topologyChangesQuerySchema.safeParse({ since: '2026-09-25T00:00:00Z', until: '2026-09-26T00:00:01Z' }).success).toBe(false);
    expect(topologyChangesQuerySchema.safeParse({ since: window.until, until: window.since }).success).toBe(false);
    expect(topologyChangesQuerySchema.safeParse({ ...window, cursor: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('accepts a typed change page with evidence and expired-detail markers', () => {
    const page = {
      siteId: SITE, graphRevision: '7', window, cursor: null, reasons: [], asOf: at,
      changes: [{ id: `relationship_observed:${REL}:${RUN}`, at, kind: 'relationship_observed', category: 'attachment',
        subject: { kind: 'relationship', id: REL }, evidenceIds: [REL, RUN], detail: 'expired',
        attributes: { relationshipKind: 'attachment', method: 'fdb', evidenceClass: 'inferred', producerKind: 'discovery', protocol: 'fdb' } }],
    };
    expect(topologyChangePageSchema.parse(page)).toBeTruthy();
    expect(topologyChangePageSchema.safeParse({ ...page, changes: [{ ...page.changes[0], kind: 'health_refresh' }] }).success).toBe(false);
    expect(topologyChangePageSchema.safeParse({ ...page, changes: [{ ...page.changes[0], attributes: { payload: {} } }] }).success).toBe(false);
  });
});
