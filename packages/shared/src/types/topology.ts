import type { z } from 'zod';
import type {
  collectionOutcomeSchema,
  confidenceSchema,
  diagnosticStateSchema,
  directnessSchema,
  evidenceClassSchema,
  freshnessSchema,
  graphNodeSchema,
  graphQuerySchema,
  graphRelationshipSchema,
  graphResponseSchema,
  healthCoverageSchema,
  healthStatusSchema,
  layoutPatchSchema,
  layoutWriteResultSchema,
  lifecycleSchema,
  nodeKindSchema,
  observationMethodSchema,
  positionSchema,
  presentationEdgeSchema,
  presentationNodeSchema,
  relationshipKindSchema,
  reportKindSchema,
  topologyScopeSchema,
  topologyViewSchema,
} from '../validators/topology';

export type NodeKind = z.infer<typeof nodeKindSchema>;
export type RelationshipKind = z.infer<typeof relationshipKindSchema>;
export type EvidenceClass = z.infer<typeof evidenceClassSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type Freshness = z.infer<typeof freshnessSchema>;
export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type CollectionOutcome = z.infer<typeof collectionOutcomeSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type HealthCoverage = z.infer<typeof healthCoverageSchema>;
export type TopologyView = z.infer<typeof topologyViewSchema>;
export type Directness = z.infer<typeof directnessSchema>;
export type DiagnosticState = z.infer<typeof diagnosticStateSchema>;
export type ReportKind = z.infer<typeof reportKindSchema>;
export type ObservationMethod = z.infer<typeof observationMethodSchema>;

export type TopologyScope = z.infer<typeof topologyScopeSchema>;
export type GraphQuery = z.infer<typeof graphQuerySchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphRelationship = z.infer<typeof graphRelationshipSchema>;
export type PresentationNode = z.infer<typeof presentationNodeSchema>;
export type PresentationEdge = z.infer<typeof presentationEdgeSchema>;
export type Position = z.infer<typeof positionSchema>;
export type LayoutPatch = z.infer<typeof layoutPatchSchema>;
export type LayoutWriteResult = z.infer<typeof layoutWriteResultSchema>;
export type GraphResponse = z.infer<typeof graphResponseSchema>;
