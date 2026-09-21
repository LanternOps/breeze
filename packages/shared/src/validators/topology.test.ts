import { describe, expect, it } from 'vitest';
import {
  COLLECTION_OUTCOMES,
  CONFIDENCE_LEVELS,
  DIAGNOSTIC_STATES,
  DIRECTNESS_VALUES,
  EVIDENCE_CLASSES,
  FRESHNESS_VALUES,
  HEALTH_COVERAGE_VALUES,
  HEALTH_STATUSES,
  LAYOUT_PATCH_BODY_MAX_BYTES,
  LIFECYCLE_VALUES,
  NODE_KINDS,
  OBSERVATION_METHODS,
  POSITION_SOURCES,
  RELATIONSHIP_KINDS,
  REPORT_KINDS,
  TOPOLOGY_VIEWS,
  collectionOutcomeSchema,
  confidenceSchema,
  diagnosticStateSchema,
  directnessSchema,
  evidenceClassSchema,
  freshnessSchema,
  graphQuerySchema,
  graphResponseSchema,
  healthCoverageSchema,
  healthStatusSchema,
  isLayoutPatchBodySizeAllowed,
  layoutPatchSchema,
  layoutWriteResultSchema,
  lifecycleSchema,
  nodeKindSchema,
  observationMethodSchema,
  positionSourceSchema,
  presentationEdgeSchema,
  presentationNodeSchema,
  relationshipKindSchema,
  reportKindSchema,
  topologyViewSchema,
} from './topology';

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const NODE_2_ID = '33333333-3333-4333-8333-333333333333';
const RELATIONSHIP_ID = '44444444-4444-4444-8444-444444444444';
const BINDING_ID = '55555555-5555-4555-8555-555555555555';
const RESULT_ID = '66666666-6666-4666-8666-666666666666';
const PRESENTATION_ID = 'presentation:overview:site-1111:gateway';

const ENUM_CASES = [
  ['nodeKindSchema', nodeKindSchema, NODE_KINDS],
  ['relationshipKindSchema', relationshipKindSchema, RELATIONSHIP_KINDS],
  ['evidenceClassSchema', evidenceClassSchema, EVIDENCE_CLASSES],
  ['confidenceSchema', confidenceSchema, CONFIDENCE_LEVELS],
  ['freshnessSchema', freshnessSchema, FRESHNESS_VALUES],
  ['lifecycleSchema', lifecycleSchema, LIFECYCLE_VALUES],
  ['collectionOutcomeSchema', collectionOutcomeSchema, COLLECTION_OUTCOMES],
  ['healthStatusSchema', healthStatusSchema, HEALTH_STATUSES],
  ['healthCoverageSchema', healthCoverageSchema, HEALTH_COVERAGE_VALUES],
  ['topologyViewSchema', topologyViewSchema, TOPOLOGY_VIEWS],
  ['directnessSchema', directnessSchema, DIRECTNESS_VALUES],
  ['diagnosticStateSchema', diagnosticStateSchema, DIAGNOSTIC_STATES],
  ['reportKindSchema', reportKindSchema, REPORT_KINDS],
  ['observationMethodSchema', observationMethodSchema, OBSERVATION_METHODS],
  ['positionSourceSchema', positionSourceSchema, POSITION_SOURCES],
] as const;

describe.each(ENUM_CASES)('%s', (_name, schema, values) => {
  it('accepts every canonical value', () => {
    for (const value of values) expect(schema.safeParse(value).success).toBe(true);
  });

  it('rejects an unknown value', () => {
    expect(schema.safeParse('future_value').success).toBe(false);
  });
});

const health = {
  status: 'healthy',
  coverage: 'monitored',
  scope: 'node',
  originNodeId: NODE_ID,
  resultId: RESULT_ID,
  reasons: [],
  freshness: 'fresh',
} as const;

const evidence = {
  classes: ['observed'],
  methods: ['lldp'],
  count: '1',
  lastObservedAt: '2026-09-15T12:00:00.000Z',
} as const;

const node = {
  id: NODE_ID,
  kind: 'endpoint',
  role: 'workstation',
  label: 'Desk 01',
  bindings: [{ id: BINDING_ID, type: 'device', referenceId: RESULT_ID }],
  lifecycle: 'active',
  freshness: 'fresh',
  evidence,
  health,
  availableActions: ['diagnose'],
} as const;

const relationship = {
  id: RELATIONSHIP_ID,
  kind: 'physical_link',
  directionality: 'undirected',
  sourceNodeId: NODE_ID,
  targetNodeId: NODE_2_ID,
  sourceInterfaceId: null,
  targetInterfaceId: null,
  meaning: 'physical',
  directness: 'direct',
  evidence,
  confidence: 'high',
  lifecycle: 'active',
  freshness: 'fresh',
  health,
  excluded: false,
  availableActions: ['diagnose'],
} as const;

const position = {
  nodeId: NODE_ID,
  x: 12.5,
  y: -9,
  pinned: true,
  source: 'user',
  rowRevision: '9007199254740993',
} as const;

const graphResponse = {
  schemaVersion: 1,
  siteId: SITE_ID,
  view: 'overview',
  asOf: '2026-09-15T12:00:00.000Z',
  revisions: { graph: '9007199254740993', health: '7', layout: '11' },
  nodes: [node],
  relationships: [relationship],
  presentation: {
    nodes: [{
      id: PRESENTATION_ID,
      view: 'overview',
      role: 'gateway',
      label: 'Other gateways',
      memberCount: 3,
      frontierToken: 'opaque-frontier-token',
      authority: false,
    }],
    edges: [{
      id: 'presentation:overview:site-1111:gateway-edge',
      sourceNodeId: NODE_ID,
      targetNodeId: PRESENTATION_ID,
      relationshipKind: null,
      presentationOnly: true,
      meaning: 'aggregate',
      contributingRelationshipIds: [RELATIONSHIP_ID],
      memberCount: 3,
      frontierToken: 'opaque-frontier-token',
      authority: false,
    }],
  },
  layout: { algorithm: 'elk', version: 1, positions: [position] },
  counts: {
    totalNodes: 4, totalRelationships: 3, visibleNodes: 2, visibleRelationships: 1,
    omittedNodes: 2, omittedRelationships: 2,
  },
  coverage: { state: 'limited', reasons: [{ code: 'projection_limit', message: 'Projection is bounded' }] },
  frontier: [{ token: 'opaque-frontier-token', label: 'More gateways', memberCount: 3 }],
  permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: false },
} as const;

describe('graphQuerySchema', () => {
  it('defaults the graph view, health option and node limit', () => {
    expect(graphQuerySchema.parse({})).toEqual({
      view: 'overview', hops: 1, includeHealth: false, limit: 500,
    });
  });

  it('accepts bounded query-string values', () => {
    expect(graphQuerySchema.parse({
      view: 'logical', focusNodeId: NODE_ID, hops: '2', includeHealth: 'true', limit: '1',
    })).toEqual({ view: 'logical', focusNodeId: NODE_ID, hops: 2, includeHealth: true, limit: 1 });
  });

  it('accepts the maximum graph limit and rejects values above it', () => {
    expect(graphQuerySchema.parse({ limit: 1000 }).limit).toBe(1000);
    expect(graphQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
  });

  it('rejects malformed IDs and out-of-range hops', () => {
    expect(graphQuerySchema.safeParse({ focusNodeId: PRESENTATION_ID }).success).toBe(false);
    expect(graphQuerySchema.safeParse({ hops: 3 }).success).toBe(false);
  });

  it('rejects unknown query keys instead of stripping them', () => {
    expect(graphQuerySchema.safeParse({ siteId: SITE_ID }).success).toBe(false);
  });
});

describe('layoutPatchSchema', () => {
  it('accepts an empty or bounded canonical batch and preserves revision precision', () => {
    expect(layoutPatchSchema.parse({ expectedRevision: '9007199254740993', positions: [] }))
      .toEqual({ expectedRevision: '9007199254740993', positions: [] });
    expect(layoutPatchSchema.safeParse({
      expectedRevision: '0', positions: [{ nodeId: NODE_ID, x: -1_000_000, y: 1_000_000, pinned: false }],
    }).success).toBe(true);
  });

  it('rejects non-canonical layout IDs and non-finite coordinates', () => {
    expect(layoutPatchSchema.safeParse({ expectedRevision: '1', positions: [
      { nodeId: 'presentation:overview:scope:gateway', x: 1, y: 2, pinned: false },
    ] }).success).toBe(false);
    expect(layoutPatchSchema.safeParse({ expectedRevision: '1', positions: [
      { nodeId: SITE_ID, x: Infinity, y: 2, pinned: false },
    ] }).success).toBe(false);
    expect(graphQuerySchema.parse({}).limit).toBe(500);
  });

  it('rejects malformed revisions, coordinates outside the bound and missing fields', () => {
    for (const expectedRevision of ['', '-1', '+1', '01', '1.0', 1]) {
      expect(layoutPatchSchema.safeParse({ expectedRevision, positions: [] }).success).toBe(false);
    }
    expect(layoutPatchSchema.safeParse({ expectedRevision: '1', positions: [
      { nodeId: NODE_ID, x: 1_000_001, y: 0, pinned: false },
    ] }).success).toBe(false);
    expect(layoutPatchSchema.safeParse({ expectedRevision: '1' }).success).toBe(false);
  });

  it('rejects unknown keys and batches larger than 1,000 positions', () => {
    expect(layoutPatchSchema.safeParse({ expectedRevision: '1', positions: [], ignored: true }).success).toBe(false);
    const item = { nodeId: NODE_ID, x: 0, y: 0, pinned: false };
    expect(layoutPatchSchema.safeParse({ expectedRevision: '1', positions: Array(1001).fill(item) }).success).toBe(false);
  });

  it('exposes the pre-parse 256 KiB byte limit', () => {
    expect(LAYOUT_PATCH_BODY_MAX_BYTES).toBe(256 * 1024);
    expect(isLayoutPatchBodySizeAllowed(LAYOUT_PATCH_BODY_MAX_BYTES)).toBe(true);
    expect(isLayoutPatchBodySizeAllowed(LAYOUT_PATCH_BODY_MAX_BYTES + 1)).toBe(false);
    expect(isLayoutPatchBodySizeAllowed(-1)).toBe(false);
    expect(isLayoutPatchBodySizeAllowed(1.5)).toBe(false);
  });
});

describe('presentation schemas', () => {
  it('accepts presentation namespace IDs without granting authority', () => {
    expect(presentationNodeSchema.safeParse(graphResponse.presentation.nodes[0]).success).toBe(true);
    expect(presentationNodeSchema.safeParse({ ...graphResponse.presentation.nodes[0], authority: true }).success).toBe(false);
    expect(presentationNodeSchema.safeParse({ ...graphResponse.presentation.nodes[0], id: NODE_ID }).success).toBe(false);
  });

  it('requires null relationship kind and presentation-only semantics', () => {
    const edge = graphResponse.presentation.edges[0];
    expect(presentationEdgeSchema.safeParse(edge).success).toBe(true);
    expect(presentationEdgeSchema.safeParse({ ...edge, relationshipKind: 'attachment' }).success).toBe(false);
    expect(presentationEdgeSchema.safeParse({ ...edge, presentationOnly: false }).success).toBe(false);
  });

  it('keeps schematic edges free of invented contributing authority', () => {
    const schematic = {
      id: 'presentation:physical:scope:cable', sourceNodeId: NODE_ID, targetNodeId: NODE_2_ID,
      relationshipKind: null, presentationOnly: true, meaning: 'schematic',
      contributingRelationshipIds: [], authority: false,
    };
    expect(presentationEdgeSchema.safeParse(schematic).success).toBe(true);
    expect(presentationEdgeSchema.safeParse({ ...schematic, contributingRelationshipIds: [RELATIONSHIP_ID] }).success).toBe(false);
  });
});

describe('graphResponseSchema', () => {
  it('validates the complete graph, layout and permission envelope', () => {
    const parsed = graphResponseSchema.parse(graphResponse);
    expect(parsed.revisions.graph).toBe('9007199254740993');
    expect(parsed.layout.positions[0]?.rowRevision).toBe('9007199254740993');
  });

  it('rejects unknown schema versions and keys', () => {
    expect(graphResponseSchema.safeParse({ ...graphResponse, schemaVersion: 2 }).success).toBe(false);
    expect(graphResponseSchema.safeParse({ ...graphResponse, extra: true }).success).toBe(false);
  });

  it('requires UTC timestamps rather than offset-local timestamps', () => {
    expect(graphResponseSchema.safeParse({ ...graphResponse, asOf: '2026-09-15T06:00:00-06:00' }).success).toBe(false);
  });

  it('rejects missing envelope sections and string-valued bounded counts', () => {
    const { permissions: _permissions, ...missingPermissions } = graphResponse;
    expect(graphResponseSchema.safeParse(missingPermissions).success).toBe(false);
    expect(graphResponseSchema.safeParse({
      ...graphResponse, counts: { ...graphResponse.counts, totalNodes: '4' },
    }).success).toBe(false);
  });

  it('requires an explanation when health status or freshness is unknown', () => {
    expect(graphResponseSchema.safeParse({
      ...graphResponse,
      nodes: [{ ...node, health: { ...health, status: 'unknown', reasons: [] } }],
    }).success).toBe(false);
    expect(graphResponseSchema.safeParse({
      ...graphResponse,
      nodes: [{ ...node, health: { ...health, freshness: 'unknown', reasons: [] } }],
    }).success).toBe(false);
    expect(graphResponseSchema.safeParse({
      ...graphResponse,
      nodes: [{
        ...node,
        health: {
          ...health,
          status: 'unknown',
          freshness: 'unknown',
          reasons: [{ code: 'not_evaluated', message: 'No health result has been evaluated' }],
        },
      }],
    }).success).toBe(true);
  });

  it('requires an explanation for limited or unknown graph coverage', () => {
    expect(graphResponseSchema.safeParse({
      ...graphResponse, coverage: { state: 'limited', reasons: [] },
    }).success).toBe(false);
    expect(graphResponseSchema.safeParse({
      ...graphResponse, coverage: { state: 'unknown', reasons: [] },
    }).success).toBe(false);
    expect(graphResponseSchema.safeParse({
      ...graphResponse, coverage: { state: 'complete', reasons: [] },
    }).success).toBe(true);
  });

  it('enforces the 1,000-node and 2,000-relationship response bounds', () => {
    expect(graphResponseSchema.safeParse({
      ...graphResponse, nodes: Array(1001).fill(node),
    }).success).toBe(false);
    expect(graphResponseSchema.safeParse({
      ...graphResponse, relationships: Array(2001).fill(relationship),
    }).success).toBe(false);
  });
});

describe('layoutWriteResultSchema', () => {
  it('validates the accepted-batch-only response shape', () => {
    const result = { siteId: SITE_ID, view: 'overview', layoutRevision: '9007199254740993', positions: [position] };
    expect(layoutWriteResultSchema.parse(result)).toEqual(result);
  });

  it('requires server-owned position fields and rejects unknown keys', () => {
    const { source: _source, ...positionWithoutSource } = position;
    expect(layoutWriteResultSchema.safeParse({
      siteId: SITE_ID, view: 'overview', layoutRevision: '1', positions: [positionWithoutSource],
    }).success).toBe(false);
    expect(layoutWriteResultSchema.safeParse({
      siteId: SITE_ID, view: 'overview', layoutRevision: '1', positions: [], actorId: RESULT_ID,
    }).success).toBe(false);
  });
});
