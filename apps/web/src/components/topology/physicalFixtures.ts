import type { GraphRelationship, RelationshipDetailResponse, RelationshipEvidenceResponse } from '@breeze/shared';
import { NODE, SITE } from './topologyFixtures';

export const HOST = '44444444-4444-4444-8444-444444444444', FDB = '55555555-5555-4555-8555-555555555555', ALT = '66666666-6666-4666-8666-666666666666';
export const PORT = '77777777-7777-4777-8777-777777777777', EXCLUSION = '88888888-8888-4888-8888-888888888888';

/** Inferred/medium FDB attachment: directness unknown, one timestamped source, no metric series, unmonitored health. */
export const fdbRelationship = (): GraphRelationship => ({
  id: FDB, kind: 'attachment', directionality: 'directed', sourceNodeId: NODE, targetNodeId: HOST, sourceInterfaceId: PORT, targetInterfaceId: null,
  meaning: 'attachment', directness: 'unknown', evidence: { classes: ['inferred'], methods: ['fdb'], count: '1', lastObservedAt: '2026-09-26T10:00:00.000Z' },
  confidence: 'medium', lifecycle: 'active', freshness: 'fresh',
  health: { status: 'unknown', coverage: 'unmonitored', scope: 'relationship', originNodeId: null, resultId: null, freshness: 'unknown', reasons: [{ code: 'monitoring_unavailable', message: 'Not monitored' }] },
  excluded: false, availableActions: [],
});

export const fdbDetail = (): RelationshipDetailResponse => ({
  siteId: SITE, graphRevision: '3', relationship: fdbRelationship(),
  endpoints: {
    source: { nodeId: NODE, label: 'Core switch', port: { interfaceId: PORT, name: 'port-24', alias: 'Desk drop', key: 'if:24', retired: false }, reportedPort: null },
    target: { nodeId: HOST, label: 'Desk 12', port: null, reportedPort: null },
  },
  physical: { method: 'fdb', resolution: 'resolved', portRole: 'learned', association: null, fdbSelection: 'selected' },
  alternatives: [], exclusions: [], detailCoverage: { state: 'complete', reason: null },
});

export const fdbEvidence = (): RelationshipEvidenceResponse => ({
  siteId: SITE, graphRevision: '3', relationshipId: FDB, cursor: null,
  observations: [{ id: EXCLUSION, method: 'fdb', evidenceClass: 'inferred', producerKind: 'discovery', protocol: 'fdb', observedAt: '2026-09-26T10:00:00.000Z',
    effectiveAt: '2026-09-26T10:00:00.000Z', receivedAt: '2026-09-26T10:00:01.000Z', freshUntil: '2026-09-26T11:00:00.000Z', status: 'expired' }],
  confirmations: [{ sourceId: ALT, producerKind: 'discovery', protocol: 'fdb', firstPositiveAt: '2026-09-25T10:00:00.000Z', lastPositiveAt: '2026-09-26T10:00:00.000Z',
    freshUntil: '2026-09-26T13:00:00.000Z', lifecycle: 'active', completeMissCount: 0 }],
  summary: fdbRelationship().evidence, details: { state: 'available', reason: null },
});
