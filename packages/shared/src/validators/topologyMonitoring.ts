import './topologyZod';
import { z } from 'zod';
import { topologyDigestSchema, topologyFamilySchema, topologyJsonBytes, topologyReasonSchema, topologyUtf8KeySchema } from './topologyPrimitives';

/**
 * Recurring monitoring contracts (M3 Tasks 7/8, amendments M3-D3/D4/D8/D14).
 *
 * Arming is a separate, human-only act: a policy's portable `definition` only
 * records activation INTENT; a site-local arm pins the routing contexts, the
 * frozen actor and the effect digest. Nothing in a settings write, template
 * application or GET ever arms anything.
 */
const revision = z.string().regex(/^(0|[1-9]\d{0,18})$/);
const uuid = z.uuid();
const time = z.string().datetime({ offset: false });

/** At most two contexts initially; more is an explicit, bounded selection (the M1 context ceiling). */
export const TOPOLOGY_POLICY_DEFAULT_CONTEXTS = 2;
export const TOPOLOGY_POLICY_MAX_CONTEXTS = 128;
export const TOPOLOGY_POLICY_MAX_ALERT_ENTRIES = 256;
export const TOPOLOGY_POLICY_ALERT_STATE_MAX_BYTES = 256 * 1024;
export const TOPOLOGY_POLICY_ROUTING_CONTEXTS_MAX_BYTES = 64 * 1024;
/** M3-D8 defaults for newly authored policies; the stored definition always wins. */
export const TOPOLOGY_POLICY_DEFAULT_THRESHOLDS = { failureThreshold: 3, recoveryThreshold: 2 } as const;

/** A routing context selected for a policy, bound to the source/interface generation observed at arm time (M3-D4). */
export const topologyPolicyRoutingContextSchema = z.object({
  contextKey: topologyUtf8KeySchema,
  family: topologyFamilySchema,
  originDeviceId: uuid,
  originNodeId: uuid,
  sourceId: uuid,
  interfaceId: uuid.nullable(),
  interfaceEpoch: topologyUtf8KeySchema.nullable(),
}).strict().refine(v => (v.interfaceId === null) === (v.interfaceEpoch === null), 'Interface ID/epoch must occur together');
export type TopologyPolicyRoutingContext = z.infer<typeof topologyPolicyRoutingContextSchema>;

export const topologyPolicyRoutingContextsSchema = z.array(topologyPolicyRoutingContextSchema).max(TOPOLOGY_POLICY_MAX_CONTEXTS * 2)
  .refine(v => new Set(v.map(c => `${c.contextKey}\u0000${c.family}`)).size === v.length, 'Duplicate context/family')
  .refine(v => new Set(v.map(c => c.contextKey)).size <= TOPOLOGY_POLICY_MAX_CONTEXTS, 'Too many contexts')
  .refine(v => topologyJsonBytes(v) <= TOPOLOGY_POLICY_ROUTING_CONTEXTS_MAX_BYTES, 'Routing contexts exceed 64 KiB');

const selectedContext = z.object({ contextKey: topologyUtf8KeySchema, family: topologyFamilySchema }).strict();
/** POST /topology/sites/:siteId/policies/:id/arm */
export const topologyPolicyArmRequestSchema = z.object({
  expectedRevision: revision,
  /** Omitted = the first eligible contexts, at most TOPOLOGY_POLICY_DEFAULT_CONTEXTS. */
  contexts: z.array(selectedContext).min(1).max(TOPOLOGY_POLICY_MAX_CONTEXTS * 2).optional()
    .refine(v => !v || new Set(v.map(c => `${c.contextKey}\u0000${c.family}`)).size === v.length, 'Duplicate context/family'),
  /** Explicit consent for more than the default two contexts. */
  extendedContexts: z.boolean().default(false),
  stepUpGrantId: z.string().min(1).max(128).optional(),
}).strict().superRefine((v, ctx) => {
  const keys = new Set((v.contexts ?? []).map(c => c.contextKey));
  if (keys.size > TOPOLOGY_POLICY_DEFAULT_CONTEXTS && !v.extendedContexts) ctx.addIssue({ code: 'custom', path: ['contexts'], message: 'More than two contexts requires explicit extended selection' });
});
export type TopologyPolicyArmRequest = z.infer<typeof topologyPolicyArmRequestSchema>;
export const topologyPolicyDisarmRequestSchema = z.object({ expectedRevision: revision }).strict();

export const topologyPolicyArmStateSchema = z.object({
  policyId: uuid,
  revision,
  enabled: z.boolean(),
  activationIntent: z.boolean(),
  blockedReason: topologyReasonSchema.nullable(),
  armedAt: time.nullable(),
  armedBy: uuid.nullable(),
  authorityDigest: topologyDigestSchema.nullable(),
  contexts: z.array(z.object({ contextKey: topologyUtf8KeySchema, family: topologyFamilySchema }).strict()).max(TOPOLOGY_POLICY_MAX_CONTEXTS * 2),
  nextScheduledAt: time.nullable(),
}).strict();
export type TopologyPolicyArmState = z.infer<typeof topologyPolicyArmStateSchema>;

// ---- Alert/streak runtime state (M3 Task 8); API-internal, validated on every write ----
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const topologyAlertStreakSchema = z.object({
  contextKey: topologyUtf8KeySchema,
  family: topologyFamilySchema,
  policyRevision: revision,
  lastClaimedScheduledFor: time.nullable(),
  lastClaimedOccurrenceKey: hex64.nullable(),
  lastAppliedScheduledFor: time.nullable(),
  lastAppliedOccurrenceKey: hex64.nullable(),
  continuityKey: hex64.nullable(),
  originDeviceId: uuid.nullable(),
  originAgentId: topologyUtf8KeySchema.nullable(),
  consecutiveFailures: counter,
  consecutiveSuccesses: counter,
  activeAlertId: uuid.nullable(),
  lastNotifiedAt: time.nullable(),
}).strict();
export type TopologyAlertStreak = z.infer<typeof topologyAlertStreakSchema>;
export const topologyPolicyAlertStateSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(topologyAlertStreakSchema).max(TOPOLOGY_POLICY_MAX_ALERT_ENTRIES),
}).strict()
  .refine(v => new Set(v.entries.map(e => `${e.contextKey}\u0000${e.family}`)).size === v.entries.length, 'Duplicate context/family entry')
  .refine(v => topologyJsonBytes(v) <= TOPOLOGY_POLICY_ALERT_STATE_MAX_BYTES, 'Alert state exceeds 256 KiB');
export type TopologyPolicyAlertState = z.infer<typeof topologyPolicyAlertStateSchema>;

// ---- Telemetry arms (M3-D2/D3) ----
/** One arm polls at most one transport batch (TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES). */
export const TOPOLOGY_TELEMETRY_ARM_MAX_INTERFACES = 256;
export const TOPOLOGY_TELEMETRY_ARM_MAX_TTL_DAYS = 90;
export const topologyTelemetryArmRequestSchema = z.object({
  /** The SNMP-discovered switch/router node whose ports are polled. */
  targetNodeId: uuid,
  /** The same-site agent that polls. */
  collectorDeviceId: uuid,
  /** Discovery profile whose SNMP credentials the poll uses (never inline secrets). */
  credentialProfileId: uuid,
  interfaceIds: z.array(uuid).min(1).max(TOPOLOGY_TELEMETRY_ARM_MAX_INTERFACES).refine(v => new Set(v).size === v.length, 'Duplicate interface'),
  intervalSeconds: z.number().int().min(30).max(300).default(60),
  ttlDays: z.number().int().min(1).max(TOPOLOGY_TELEMETRY_ARM_MAX_TTL_DAYS).default(30),
  stepUpGrantId: z.string().min(1).max(128).optional(),
}).strict();
export type TopologyTelemetryArmRequest = z.infer<typeof topologyTelemetryArmRequestSchema>;

export const topologyTelemetryArmSchema = z.object({
  id: uuid,
  targetNodeId: uuid,
  collectorDeviceId: uuid,
  authorityKey: topologyUtf8KeySchema,
  interfaceCount: z.number().int().min(0).max(TOPOLOGY_TELEMETRY_ARM_MAX_INTERFACES),
  intervalSeconds: z.number().int().min(30).max(300),
  state: z.enum(['armed', 'revoked', 'blocked']),
  blockedReason: topologyReasonSchema.nullable(),
  generation: revision,
  armedBy: uuid,
  armedAt: time,
  expiresAt: time,
}).strict();
export type TopologyTelemetryArm = z.infer<typeof topologyTelemetryArmSchema>;
export const topologyTelemetryArmListSchema = z.object({ items: z.array(topologyTelemetryArmSchema).max(200) }).strict();

/** GET /topology/sites/:siteId/monitoring — bounded policy status for humans and the MCP read tool. */
export const topologyMonitoringStatusSchema = z.object({
  siteId: uuid,
  policies: z.array(z.object({
    policyId: uuid,
    key: z.string().min(1).max(64),
    recipeId: z.string().min(1).max(32),
    enabled: z.boolean(),
    activationIntent: z.boolean(),
    blockedReason: topologyReasonSchema.nullable(),
    intervalSeconds: z.number().int().min(60).max(3600),
    failureThreshold: z.number().int().min(1).max(100),
    recoveryThreshold: z.number().int().min(1).max(100),
    nextScheduledAt: time.nullable(),
    lastScheduledAt: time.nullable(),
    streaks: z.array(z.object({
      contextKey: topologyUtf8KeySchema, family: topologyFamilySchema,
      consecutiveFailures: counter, consecutiveSuccesses: counter,
      activeAlertId: uuid.nullable(), lastAppliedScheduledFor: time.nullable(),
    }).strict()).max(TOPOLOGY_POLICY_MAX_ALERT_ENTRIES),
  }).strict()).max(64),
  telemetryArms: z.array(topologyTelemetryArmSchema).max(200),
}).strict();
export type TopologyMonitoringStatus = z.infer<typeof topologyMonitoringStatusSchema>;


/** POST /topology/sites/:siteId/policies/:id/monitor-bindings (M3-D5). */
export const topologyMonitorBindingRequestSchema = z.object({
  monitorId: uuid,
  contextKey: topologyUtf8KeySchema,
  family: topologyFamilySchema,
}).strict();
export type TopologyMonitorBindingRequest = z.infer<typeof topologyMonitorBindingRequestSchema>;
