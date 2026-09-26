import './topologyZod';
import { z } from 'zod';
import { topologyRevisionSchema } from './topology';
import { topologyReasonSchema, topologyTimestampSchema } from './topologyPrimitives';

/**
 * Incident impact and change-history contracts (M3 Task 10).
 *
 * Impact is an EXPLANATION, never an action: it separates fresh measured
 * failures from entities that only possibly depend on the subject, cites the
 * evidence behind every entry and labels its uncertainty. Nothing on this wire
 * suppresses, acknowledges, closes, downgrades or re-evaluates an alert, and no
 * read dispatches a probe or poll. A possible dependency is never a certain
 * downstream claim: every entry states whether an alternative path is known
 * (and that its availability is unverified) or not known.
 */
export const TOPOLOGY_IMPACT_LIMITS = {
  maxNodes: 10_000,
  maxRelationships: 20_000,
  deadlineMs: 2_000,
  maxMeasuredFailures: 200,
  maxPotentiallyAffected: 500,
  maxAlternatives: 100,
  maxPathRelationships: 32,
  maxRoutedPaths: 10,
  maxEvidence: 2_000,
} as const;
export const TOPOLOGY_IMPACT_WINDOW_MINUTES = { min: 1, max: 30, default: 5 } as const;
export const TOPOLOGY_IMPACT_SUBJECT_KINDS = ['node', 'relationship'] as const;
export const TOPOLOGY_IMPACT_EVIDENCE_KINDS = ['relationship', 'monitor_result', 'interface_measurement', 'diagnostic_run'] as const;
/** Every potentially-affected entry carries exactly this kind of availability statement. */
export const TOPOLOGY_IMPACT_PATH_REASONS = ['alternative_path_unverified', 'no_known_alternative_path', 'group_member_possible'] as const;

const time = topologyTimestampSchema;
const reasons = (max: number) => z.array(topologyReasonSchema).max(max);
const evidenceId = z.string().min(1).max(128);
const subjectKind = z.enum(TOPOLOGY_IMPACT_SUBJECT_KINDS);

export const topologyImpactQuerySchema = z.object({
  subjectKind,
  subjectId: z.uuid(),
  /** When present the analysis is pinned to it: a different current revision is a 409, never a silent re-read. */
  graphRevision: topologyRevisionSchema.optional(),
  windowMinutes: z.number().int().min(TOPOLOGY_IMPACT_WINDOW_MINUTES.min).max(TOPOLOGY_IMPACT_WINDOW_MINUTES.max).default(TOPOLOGY_IMPACT_WINDOW_MINUTES.default),
}).strict();

const measuredFailure = z.object({
  kind: subjectKind,
  id: z.uuid(),
  status: z.enum(['failed_check', 'degraded']),
  evidenceIds: z.array(evidenceId).min(1).max(16),
  reasons: reasons(16),
}).strict();

const potentiallyAffected = z.object({
  kind: z.literal('node'),
  id: z.uuid(),
  label: z.string().max(255),
  /** `group_membership` is a possible group only — a membership edge never proves a cable dependency. */
  basis: z.enum(['dependency_path', 'group_membership']),
  /** Relationships between the failed subject and this entity on the cited dependency path. */
  hops: z.number().int().min(0).max(TOPOLOGY_IMPACT_LIMITS.maxNodes),
  reasons: reasons(24),
  /** The cited relationship path from the subject (bounded; truncation is a reason). */
  evidenceIds: z.array(evidenceId).max(TOPOLOGY_IMPACT_LIMITS.maxPathRelationships),
}).strict().refine(
  entry => entry.reasons.filter(code => (TOPOLOGY_IMPACT_PATH_REASONS as readonly string[]).includes(code)).length === 1,
  'A potentially affected entity must state exactly one path-availability reason',
);

const alternative = z.object({
  nodeId: z.uuid(),
  relationshipIds: z.array(z.uuid()).max(TOPOLOGY_IMPACT_LIMITS.maxPathRelationships),
  /** Forwarding/HA state is not observed: an alternative path exists, availability unverified. */
  state: z.literal('unverified'),
  reasons: reasons(8),
}).strict();

const routedPath = z.object({
  runId: z.uuid(),
  stepId: z.uuid(),
  /** A trace is an observed routed path, never a topology relationship path. */
  kind: z.literal('observed_routed_path'),
  destinationReached: z.boolean(),
  respondingHops: z.number().int().min(0).max(64),
  gapHops: z.number().int().min(0).max(64),
  truncated: z.boolean(),
  finishedAt: time.nullable(),
}).strict();

export const topologyImpactResponseSchema = z.object({
  siteId: z.uuid(),
  graphRevision: topologyRevisionSchema,
  healthRevision: topologyRevisionSchema,
  /** `measured` = the subject itself has fresh failure evidence; otherwise the analysis is hypothetical. */
  subject: z.object({ kind: subjectKind, id: z.uuid(), measured: z.boolean() }).strict(),
  window: z.object({
    minutes: z.number().int().min(TOPOLOGY_IMPACT_WINDOW_MINUTES.min).max(TOPOLOGY_IMPACT_WINDOW_MINUTES.max),
    from: time, to: time,
  }).strict(),
  measuredFailures: z.array(measuredFailure).max(TOPOLOGY_IMPACT_LIMITS.maxMeasuredFailures),
  potentiallyAffected: z.array(potentiallyAffected).max(TOPOLOGY_IMPACT_LIMITS.maxPotentiallyAffected),
  alternatives: z.array(alternative).max(TOPOLOGY_IMPACT_LIMITS.maxAlternatives),
  routedPaths: z.array(routedPath).max(TOPOLOGY_IMPACT_LIMITS.maxRoutedPaths),
  /** A cause is only ever `possible`, and only with fresh corroborating failures. */
  causeSuggestion: z.object({
    state: z.enum(['possible', 'not_suggested']),
    corroboratingIds: z.array(z.uuid()).max(16),
    reasons: reasons(8),
  }).strict(),
  assumptions: reasons(32),
  coverage: z.enum(['complete', 'partial']),
  reasons: reasons(64),
  counts: z.object({
    nodes: z.number().int().min(0), relationships: z.number().int().min(0),
    potentiallyAffected: z.number().int().min(0), omittedPotentiallyAffected: z.number().int().min(0),
  }).strict(),
  evidence: z.array(z.object({ id: evidenceId, kind: z.enum(TOPOLOGY_IMPACT_EVIDENCE_KINDS) }).strict()).max(TOPOLOGY_IMPACT_LIMITS.maxEvidence),
  asOf: time,
}).strict();

// ---- Recent change history ----
export const TOPOLOGY_CHANGES_LIMITS = { maxWindowMs: 24 * 60 * 60_000, defaultLimit: 50, maxLimit: 200 } as const;
export const TOPOLOGY_CHANGE_KINDS = [
  'relationship_observed', 'relationship_withdrawn', 'relationship_asserted', 'relationship_removed',
  'source_epoch_changed', 'source_revoked', 'collection_gap', 'measurement_result', 'configuration_change',
] as const;
export const TOPOLOGY_CHANGE_CATEGORIES = [
  'attachment', 'physical_link', 'route', 'membership', 'source', 'collection', 'measurement', 'configuration',
] as const;

export const topologyChangesQuerySchema = z.object({
  since: time,
  until: time,
  limit: z.number().int().min(1).max(TOPOLOGY_CHANGES_LIMITS.maxLimit).default(TOPOLOGY_CHANGES_LIMITS.defaultLimit),
  cursor: z.string().min(1).max(2048).optional(),
}).strict().superRefine((query, ctx) => {
  const span = Date.parse(query.until) - Date.parse(query.since);
  if (!(span > 0)) ctx.addIssue({ code: 'custom', path: ['until'], message: 'until must be after since' });
  else if (span > TOPOLOGY_CHANGES_LIMITS.maxWindowMs) ctx.addIssue({ code: 'custom', path: ['until'], message: 'Window exceeds 24 hours' });
});

const bounded = (max: number) => z.string().max(max).nullable().optional();
export const topologyChangeSchema = z.object({
  /** Stable, unique per page stream: `<kind>:<row identity>`. */
  id: z.string().min(1).max(200),
  at: time,
  kind: z.enum(TOPOLOGY_CHANGE_KINDS),
  category: z.enum(TOPOLOGY_CHANGE_CATEGORIES),
  subject: z.object({ kind: z.enum(['node', 'relationship', 'source', 'diagnostic_run', 'configuration']), id: z.uuid() }).strict(),
  evidenceIds: z.array(evidenceId).max(8),
  /** `expired`: the change is known from retained support/summary rows but its detailed observation aged out. */
  detail: z.enum(['available', 'expired', 'not_applicable']),
  attributes: z.object({
    relationshipKind: bounded(24), method: bounded(32), evidenceClass: bounded(16), producerKind: bounded(24), protocol: bounded(32),
    outcome: bounded(24), recipeId: bounded(32), state: bounded(24), assessment: bounded(16), settingsRevision: bounded(32),
    sourceNodeId: z.uuid().nullable().optional(), targetNodeId: z.uuid().nullable().optional(), originNodeId: z.uuid().nullable().optional(),
    observedRoutedPath: z.boolean().optional(),
  }).strict(),
}).strict();

export const topologyChangePageSchema = z.object({
  siteId: z.uuid(),
  graphRevision: topologyRevisionSchema,
  window: z.object({ since: time, until: time }).strict(),
  changes: z.array(topologyChangeSchema).max(TOPOLOGY_CHANGES_LIMITS.maxLimit),
  cursor: z.string().max(2048).nullable(),
  reasons: reasons(16),
  asOf: time,
}).strict();
