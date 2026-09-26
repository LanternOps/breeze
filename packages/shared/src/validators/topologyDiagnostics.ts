import './topologyZod';
import { z } from 'zod';
import { diagnosticStateSchema, healthCoverageSchema, healthStatusSchema, topologyRevisionSchema, topologyScopeSchema } from './topology';
import { topologyRecipeIdSchema, topologyTargetDefinitionSchema } from './topologyConfiguration';
import { topologyDigestSchema, topologyFamilySchema, topologyIpSchema, topologyJsonBytes, topologyPortSchema, topologyReasonSchema, topologySequenceSchema, topologyTimestampSchema, topologyUtf8KeySchema } from './topologyPrimitives';
const id = z.uuid();
const key = topologyUtf8KeySchema;
const time = topologyTimestampSchema;
export const topologyDiagnosticSubjectSchema = z.object({ kind: z.enum(['node', 'relationship', 'destination']), id }).strict();
/**
 * Routed-trace bounds (M3 global constraints). The hop timeout and the 60 s
 * execution ceiling are server-pinned; only hop and probe counts are requestable.
 */
export const TOPOLOGY_TRACE_LIMITS = Object.freeze({ defaultMaxHops: 16, maxHops: 30, defaultProbesPerHop: 1, maxProbesPerHop: 2, hopTimeoutMs: 1000, executionTimeoutSeconds: 60 });
const traceMaxHopsSchema = z.number().int().min(1).max(TOPOLOGY_TRACE_LIMITS.maxHops);
const traceProbesSchema = z.number().int().min(1).max(TOPOLOGY_TRACE_LIMITS.maxProbesPerHop);
export const topologyTraceRequestOptionsSchema = z.object({ maxHops: traceMaxHopsSchema, probesPerHop: traceProbesSchema }).strict();
export const createTopologyDiagnosticSchema = z.object({ recipeId: topologyRecipeIdSchema, recipeVersion: z.literal(1), subject: topologyDiagnosticSubjectSchema, graphRevision: topologyRevisionSchema, originDeviceId: id.optional(), contextKey: key.optional(), family: topologyFamilySchema.optional(), trace: topologyTraceRequestOptionsSchema.optional() }).strict()
  .refine(v => v.trace === undefined || v.recipeId === 'trace_route', { message: 'Trace options apply only to trace_route', path: ['trace'] });
export const topologyDiagnosticMethodSchema = z.enum(['route_lookup', 'neighbor_lookup', 'icmp', 'dns', 'tcp', 'tls', 'http', 'trace']);
export const topologyDiagnosticStepStateSchema = z.enum(['pending', 'running', 'succeeded', 'failed_check', 'timeout', 'unsupported', 'skipped', 'cancelled', 'execution_error']);
export const topologyDiagnosticLimitsSchema = z.object({
  maxConcurrentSteps: z.number().int().min(1).max(2), maxTargetAddresses: z.number().int().min(0).max(4), maxResolvers: z.number().int().min(0).max(2),
  queueTimeoutSeconds: z.number().int().min(1).max(30), executionTimeoutSeconds: z.number().int().min(1).max(90), lifetimeSeconds: z.number().int().min(1).max(120),
}).strict();
export const topologyDiagnosticOriginSchema = z.object({ deviceId: id, agentId: key, nodeId: id, bindingId: id, siteId: id, contextKey: key, interfaceId: id.nullable(), interfaceEpoch: key.nullable(), interfaceKey: key.nullable(), sourceId: id, producerEpoch: key, sequence: topologySequenceSchema }).strict().refine(v => (v.interfaceId === null) === (v.interfaceEpoch === null) && (v.interfaceId === null) === (v.interfaceKey === null), 'Interface ID/epoch must occur together');
export const topologyDiagnosticDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observed_gateway'), address: topologyIpSchema, zone: key.nullable(), interfaceId: id, evidenceId: id }).strict(),
  z.object({ kind: z.literal('observed_resolver'), address: topologyIpSchema, zone: key.nullable(), port: topologyPortSchema, localStub: z.boolean(), evidenceId: id }).strict(),
  z.object({ kind: z.literal('configured_target'), targetId: id, targetRevision: topologyRevisionSchema, definition: topologyTargetDefinitionSchema }).strict(),
]);
const stepBase = { id, required: z.boolean(), destinationId: id.nullable() };
export const topologyDiagnosticPlanStepSchema = z.discriminatedUnion('method', [
  z.object({ ...stepBase, method: z.literal('route_lookup') }).strict(),
  z.object({ ...stepBase, method: z.literal('neighbor_lookup') }).strict(),
  z.object({ ...stepBase, method: z.literal('icmp'), packetCount: z.number().int().min(1).max(5), timeoutMs: z.number().int().min(1).max(2000), payloadBytes: z.number().int().min(0).max(1024) }).strict(),
  z.object({ ...stepBase, method: z.literal('dns'), timeoutMs: z.number().int().min(1).max(2000), retries: z.number().int().min(0).max(1), queryType: z.enum(['A', 'AAAA']), resolverDestinationIds: z.array(id).max(2) }).strict(),
  z.object({ ...stepBase, method: z.literal('tcp'), timeoutMs: z.number().int().min(1).max(5000) }).strict(),
  z.object({ ...stepBase, method: z.literal('tls'), timeoutMs: z.number().int().min(1).max(5000) }).strict(),
  z.object({ ...stepBase, method: z.literal('http'), timeoutMs: z.number().int().min(1).max(5000), responseLimitBytes: z.number().int().min(1).max(65536) }).strict(),
  z.object({ ...stepBase, method: z.literal('trace'), maxHops: traceMaxHopsSchema, probesPerHop: traceProbesSchema, hopTimeoutMs: z.number().int().min(1).max(TOPOLOGY_TRACE_LIMITS.hopTimeoutMs) }).strict(),
]);
/** The only steps a trace_route plan may carry: resolve, attribute the route, trace. */
const TRACE_ROUTE_METHODS = new Set(['dns', 'route_lookup', 'trace']);
export const topologyDiagnosticPlanSchema = z.object({
  version: z.literal(1), recipeId: topologyRecipeIdSchema, recipeVersion: z.literal(1), scope: topologyScopeSchema, subject: topologyDiagnosticSubjectSchema,
  origin: topologyDiagnosticOriginSchema, family: topologyFamilySchema, graphRevision: topologyRevisionSchema, settingsRevision: topologyRevisionSchema, contextRevision: topologyRevisionSchema,
  templateVersions: z.object({ partner: id.nullable(), org: id.nullable(), defaults: z.number().int().positive(), resolver: z.number().int().positive() }).strict(),
  destinations: z.array(z.object({ id, target: topologyDiagnosticDestinationSchema }).strict()).max(8), steps: z.array(topologyDiagnosticPlanStepSchema).max(12), limits: topologyDiagnosticLimitsSchema,
  acceptedAt: time, queueDeadline: time, deadline: time, digest: topologyDigestSchema, reasons: z.array(topologyReasonSchema).max(64),
}).strict().superRefine((v, ctx) => {
  if (v.origin.siteId !== v.scope.siteId) ctx.addIssue({ code: 'custom', message: 'Origin site differs from scope' });
  const ids = new Set(v.destinations.map(d => d.id));
  if (ids.size !== v.destinations.length || new Set(v.steps.map(s => s.id)).size !== v.steps.length) ctx.addIssue({ code: 'custom', message: 'Duplicate plan identity' });
  for (const s of v.steps) {
    if (s.destinationId !== null && !ids.has(s.destinationId)) ctx.addIssue({ code: 'custom', message: 'Unknown step destination' });
    if (s.method === 'dns') for (const resolverId of s.resolverDestinationIds) if (v.destinations.find(d => d.id === resolverId)?.target.kind !== 'observed_resolver') ctx.addIssue({ code: 'custom', message: 'DNS resolver must reference observed resolver' });
    if (!['route_lookup', 'neighbor_lookup'].includes(s.method) && s.destinationId === null) ctx.addIssue({ code: 'custom', message: 'Probe needs destination' });
    if ((s.method === 'trace') !== (v.recipeId === 'trace_route') && (s.method === 'trace' || !TRACE_ROUTE_METHODS.has(s.method))) ctx.addIssue({ code: 'custom', message: 'Trace steps belong only to trace_route plans' });
  }
  if (v.recipeId === 'trace_route' && v.limits.executionTimeoutSeconds > TOPOLOGY_TRACE_LIMITS.executionTimeoutSeconds) ctx.addIssue({ code: 'custom', message: 'Trace execution exceeds 60 seconds' });
  const accepted = Date.parse(v.acceptedAt), queued = Date.parse(v.queueDeadline), end = Date.parse(v.deadline);
  if (!(queued > accepted && queued - accepted <= v.limits.queueTimeoutSeconds * 1000 && end >= queued && end - accepted <= v.limits.lifetimeSeconds * 1000)) ctx.addIssue({ code: 'custom', message: 'Invalid plan deadlines' });
});
export const topologyHealthSummarySchema = z.object({ status: healthStatusSchema, coverage: healthCoverageSchema, reasons: z.array(topologyReasonSchema).max(64), evidenceRefs: z.array(id).max(128) }).strict();
export const topologyDiagnosticAttributionSchema = z.object({
  originDeviceId: id, originAgentId: key, requestedMethod: topologyDiagnosticMethodSchema, actualMethod: topologyDiagnosticMethodSchema.nullable(), destinationId: id.nullable(), resolvedIp: topologyIpSchema.nullable(), family: topologyFamilySchema.nullable(), port: topologyPortSchema.nullable(), interfaceId: id.nullable(), localAddress: topologyIpSchema.nullable(), contextKey: key.nullable(), tableKey: key.nullable(), nextHop: topologyIpSchema.nullable(), proxyUsed: z.boolean().nullable(), quality: z.enum(['observed', 'requested_unverified', 'unknown']), routeChanged: z.boolean(), evidenceRefs: z.array(id).max(64),
}).strict();
/**
 * One probe at one TTL. An unanswered probe is a null address with its reason
 * (`timeout`/`unsupported`), never an invented responder; a reply always names
 * the responder it observed. `unreachable` may carry the reporting router.
 */
export const topologyTraceHopSchema = z.object({
  ttl: traceMaxHopsSchema, attempt: traceProbesSchema, address: topologyIpSchema.nullable(), rttMs: z.number().finite().nonnegative().max(60_000).nullable(),
  outcome: z.enum(['reply', 'timeout', 'unreachable', 'unsupported']), attributionQuality: z.enum(['observed', 'requested_unverified', 'unknown']),
}).strict().superRefine((v, ctx) => {
  if (v.outcome === 'reply' && (v.address === null || v.rttMs === null)) ctx.addIssue({ code: 'custom', message: 'A reply names its responder and round trip' });
  if ((v.outcome === 'timeout' || v.outcome === 'unsupported') && (v.address !== null || v.rttMs !== null)) ctx.addIssue({ code: 'custom', message: 'An unanswered probe has no responder' });
});
export const topologyTraceDetailsSchema = z.object({
  protocol: z.enum(['icmp_echo']), destinationReached: z.boolean(), maxHops: traceMaxHopsSchema, probesPerHop: traceProbesSchema,
  hopsOmitted: z.number().int().min(0).max(TOPOLOGY_TRACE_LIMITS.maxHops * TOPOLOGY_TRACE_LIMITS.maxProbesPerHop),
  hops: z.array(topologyTraceHopSchema).max(TOPOLOGY_TRACE_LIMITS.maxHops * TOPOLOGY_TRACE_LIMITS.maxProbesPerHop),
}).strict().superRefine((v, ctx) => {
  for (let i = 0; i < v.hops.length; i++) {
    const hop = v.hops[i]!, previous = v.hops[i - 1];
    if (hop.ttl > v.maxHops || hop.attempt > v.probesPerHop) ctx.addIssue({ code: 'custom', message: 'Hop outside the traced bounds' });
    if (previous && (hop.ttl < previous.ttl || (hop.ttl === previous.ttl && hop.attempt <= previous.attempt))) ctx.addIssue({ code: 'custom', message: 'Hops must be unique and ordered by TTL and attempt' });
  }
});
export const topologyDiagnosticStepSchema = z.object({
  id, state: topologyDiagnosticStepStateSchema, reason: topologyReasonSchema.nullable(), attribution: topologyDiagnosticAttributionSchema,
  startedAt: time.nullable(), finishedAt: time.nullable(), receivedAt: time.nullable(), truncated: z.boolean(),
  details: z.object({ latencyMs: z.number().finite().nonnegative().nullable().optional(), packetsSent: z.number().int().min(0).max(5).optional(), packetsReceived: z.number().int().min(0).max(5).optional(), statusCode: z.number().int().min(100).max(599).optional(), resolvedAddresses: z.array(topologyIpSchema).max(4).optional(), errorCode: topologyReasonSchema.optional(), trace: topologyTraceDetailsSchema.optional() }).strict().refine(v => topologyJsonBytes(v) <= 8192, 'Step details exceed 8 KiB'),
}).strict();
export const topologyDiagnosticResultSchema = z.object({ version: z.literal(1), runId: id, attemptId: id, commandId: id, planDigest: topologyDigestSchema, steps: z.array(topologyDiagnosticStepSchema).max(12), truncated: z.boolean() }).strict().refine(v => topologyJsonBytes(v) <= 128 * 1024, 'Result exceeds 128 KiB').refine(v => new Set(v.steps.map(s => s.id)).size === v.steps.length, 'Duplicate step result');
export const topologyDiagnosticRunSchema = z.object({ id, attemptId: id, commandId: id.nullable(), state: diagnosticStateSchema, plan: topologyDiagnosticPlanSchema, assessment: healthStatusSchema, coverage: z.enum(['complete', 'partial', 'none']), reasons: z.array(topologyReasonSchema).max(64), steps: z.array(topologyDiagnosticStepSchema).max(12), queuedAt: time, startedAt: time.nullable(), deadline: time, finishedAt: time.nullable(), cancelRequestedAt: time.nullable(), failureReason: topologyReasonSchema.nullable() }).strict();
export const topologyDiagnosticCommandSchema = z.object({ type: z.literal('network_diagnostic'), version: z.literal(1), runId: id, attemptId: id, commandId: id, plan: topologyDiagnosticPlanSchema, planDigest: topologyDigestSchema, expiresAt: time }).strict().refine(v => v.planDigest === v.plan.digest && v.expiresAt === v.plan.deadline, 'Command must bind accepted plan and expiry');

export const topologyOriginEligibilitySchema = z.object({ origin: topologyDiagnosticOriginSchema, eligible: z.boolean(), reasons: z.array(topologyReasonSchema).max(64), families: z.array(topologyFamilySchema).min(1).max(2), rank: z.number().int().nonnegative() }).strict();
export const topologyCollectorsResponseSchema = z.object({ items: z.array(topologyOriginEligibilitySchema).max(100), nextCursor: z.string().min(1).max(2048).nullable() }).strict();
export const topologyCollectorsQuerySchema = z.object({ recipe: topologyRecipeIdSchema, subjectKind: z.enum(['node', 'relationship', 'destination']), subjectId: id, graphRevision: topologyRevisionSchema, contextKey: key.optional(), family: topologyFamilySchema.optional() }).strict();
