import { z } from 'zod';
import { EVENT_SUBSCRIBER_IDS } from '../services/eventSubscriberIds';

export const desktopSessionFinalizationJobDataSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  finalizationId: z.string().uuid(),
}).strict();

export const queueActorMetaSchema = z.object({
  actorType: z.enum(['system', 'agent', 'user', 'service']),
  actorId: z.string().min(1).nullable().optional(),
  source: z.string().min(1),
}).strict();

const backupSnapshotFileSchema = z.object({
  sourcePath: z.string().min(1),
  backupPath: z.string().min(1),
  size: z.number().nonnegative().optional(),
  modTime: z.string().min(1).optional(),
}).strict();

const backupSnapshotSummarySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1).optional(),
  size: z.number().nonnegative().optional(),
  files: z.array(backupSnapshotFileSchema).optional(),
}).strict();

export const backupProcessResultSchema = z.object({
  status: z.string().min(1),
  // The AGENT's own terminal status, as opposed to `status` above which is the
  // outer command-result status (completed/failed, derived from a success
  // bool). Kept as a separate key precisely because the two collide by name:
  // `partial` can only ever arrive on this one (#3000).
  agentStatus: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  filesBackedUp: z.number().int().nonnegative().optional(),
  bytesBackedUp: z.number().nonnegative().optional(),
  warning: z.string().min(1).optional(),
  errorCount: z.number().int().nonnegative().optional(),
  referencedFiles: z.number().int().nonnegative().optional(),
  referencedBytes: z.number().nonnegative().optional(),
  // system_image (system-state) backups carry the OS-artifact manifest and a
  // derived backup type; forwarded through the queue so persistence can label
  // the snapshot and BMR restore can read the manifest. Manifest typed as an
  // open z.record (arbitrary keys allowed) so an unmodeled field never fails
  // the job. NOTE: this schema itself is .strict(), so new *top-level* fields
  // still must be declared here or the whole job fails validation.
  backupType: z.enum(['file', 'system_image', 'database', 'application']).optional(),
  systemStateManifest: z.record(z.string(), z.unknown()).nullish(),
  // Windows VSS diagnostics (#3027), forwarded so persistence can write
  // backup_jobs.vss_metadata. `z.unknown()` rather than a record for the same
  // reason as the ingress schema (routes/backup/resultSchemas.ts): this parse
  // runs inside enqueueBackupResults and THROWS BEFORE queue.add, so a shape
  // assertion here would discard the entire terminal result — snapshot id,
  // counters and all — over a diagnostics blob. Validation and bounding happen
  // in sanitizeVssMetadata at the write. Note the .strict() rule still applies:
  // the TOP-LEVEL key has to be declared right here or the job dead-letters.
  vssMetadata: z.unknown().optional(),
  snapshot: backupSnapshotSummarySchema.optional(),
  error: z.string().min(1).optional(),
}).strict();

export const backupQueueJobDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('check-schedules'),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('expire-recovery-tokens'),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('cleanup-expired-snapshots'),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('dispatch-backup'),
    jobId: z.string().min(1),
    configId: z.string().min(1),
    orgId: z.string().min(1),
    deviceId: z.string().min(1),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('process-results'),
    jobId: z.string().min(1),
    orgId: z.string().min(1),
    deviceId: z.string().min(1),
    result: backupProcessResultSchema,
    meta: queueActorMetaSchema.optional(),
  }).strict(),
]);

const discoveredOpenPortSchema = z.object({
  port: z.number().int().nonnegative(),
  service: z.string(),
}).strict();

export const discoveredHostResultSchema = z.object({
  ip: z.string().min(1),
  mac: z.string().min(1).optional(),
  hostname: z.string().min(1).optional(),
  netbiosName: z.string().min(1).optional(),
  assetType: z.string().min(1),
  manufacturer: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  openPorts: z.array(discoveredOpenPortSchema).optional(),
  osFingerprint: z.string().min(1).optional(),
  snmpData: z.object({
    sysDescr: z.string().optional(),
    sysObjectId: z.string().optional(),
    sysName: z.string().optional(),
  }).strict().optional(),
  responseTimeMs: z.number().nonnegative().optional(),
  methods: z.array(z.string().min(1)),
  firstSeen: z.string().datetime({ offset: true }).optional(),
  lastSeen: z.string().datetime({ offset: true }).optional(),
}).strict();

const lldpNeighborSchema = z.object({
  localPort: z.string(),
  localIfName: z.string().optional(),
  remoteChassisId: z.string(),
  remotePortId: z.string(),
  remoteSysName: z.string().optional(),
}).strict();
const cdpNeighborSchema = z.object({
  localPort: z.string(),
  remoteDeviceId: z.string(),
  remotePortId: z.string(),
  remoteAddress: z.string().optional(),
}).strict();
export const fdbEntrySchema = z.object({
  mac: z.string().min(1),
  bridgePort: z.number().int().nonnegative(),
  ifName: z.string().min(1).optional(),
  vlan: z.number().int().positive().optional(),
}).strict();
export const deviceAdjacencySchema = z.object({
  sourceDeviceIp: z.string(),
  sourceChassisId: z.string().optional(),
  lldp: z.array(lldpNeighborSchema),
  cdp: z.array(cdpNeighborSchema),
  fdb: z.array(fdbEntrySchema).default([]),
}).strict();

export const discoveryQueueJobDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('schedule-profiles'),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('dispatch-scan'),
    jobId: z.string().min(1),
    profileId: z.string().min(1),
    orgId: z.string().min(1),
    siteId: z.string().min(1),
    agentId: z.string().min(1).nullable().optional(),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('process-results'),
    jobId: z.string().min(1),
    profileId: z.string().min(1).optional(),
    orgId: z.string().min(1),
    siteId: z.string().min(1),
    hosts: z.array(discoveredHostResultSchema),
    hostsScanned: z.number().int().nonnegative(),
    hostsDiscovered: z.number().int().nonnegative(),
    adjacency: z.array(deviceAdjacencySchema).optional(),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
]);

export const monitorCheckResultSchema = z.object({
  monitorId: z.string().min(1),
  checkId: z.string().min(1).optional(),
  status: z.enum(['online', 'offline', 'degraded']),
  responseMs: z.number().nonnegative(),
  statusCode: z.number().int().nonnegative().optional(),
  error: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const monitorQueueJobDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('check-monitor'),
    monitorId: z.string().min(1),
    orgId: z.string().min(1),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('process-check-result'),
    monitorId: z.string().min(1),
    result: monitorCheckResultSchema,
    meta: queueActorMetaSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('monitor-scheduler'),
    meta: queueActorMetaSchema.optional(),
  }).strict(),
]);

// Closed set of assignment levels resolveDeviceIdsForAssignment() understands.
// An unknown level used to be silently warned-and-skipped at runtime; constrain
// it here so a malformed level is dead-lettered at the dequeue boundary instead.
export const automationAssignmentLevelSchema = z.enum([
  'device',
  'device_group',
  'site',
  'organization',
  'partner',
]);

const automationAssignmentTargetSchema = z.object({
  level: automationAssignmentLevelSchema,
  targetId: z.string().min(1),
}).strict();

/**
 * AI agents wave 3d (#3824): what event bound this run, carried from
 * processTriggerEvent to the runtime. `.optional()` on purpose — jobs enqueued
 * before this deploy carry no triggerContext and MUST still parse.
 * Parity with services/automationRuntime.ts `AutomationTriggerContext` is
 * enforced by the compiler at automationWorker's two call sites (enqueue writes
 * the runtime type into this shape; processExecuteRun reads this shape back into
 * the runtime type), so no duplicated type assertion is needed here.
 */
export const automationTriggerContextSchema = z.object({
  alertId: z.string().nullable(),
  eventId: z.string().nullable(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).nullable(),
  ruleId: z.string().nullable(),
}).strict();

export const automationQueueJobDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scan-schedules'),
    scanAt: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('trigger-schedule'),
    automationId: z.string().min(1),
    slotKey: z.string().min(1),
    scanAt: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('trigger-event'),
    automationId: z.string().min(1),
    eventType: z.string().min(1),
    eventId: z.string().min(1).optional(),
    eventPayload: z.record(z.string(), z.unknown()).optional(),
    eventTimestamp: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('execute-run'),
    runId: z.string().min(1),
    targetDeviceIds: z.array(z.string().min(1)).optional(),
    triggerContext: automationTriggerContextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('trigger-config-policy-schedule'),
    configPolicyAutomationId: z.string().min(1),
    configPolicyAutomationName: z.string().min(1),
    assignmentTargets: z.array(automationAssignmentTargetSchema).optional(),
    // Backward compatibility with already-enqueued (pre-deploy) jobs that carry
    // a single legacy assignment target rather than the assignmentTargets[] array.
    assignmentLevel: automationAssignmentLevelSchema.optional(),
    assignmentTargetId: z.string().min(1).optional(),
    policyId: z.string().min(1),
    policyName: z.string().min(1),
    slotKey: z.string().min(1),
    scanAt: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('execute-config-policy-run'),
    configPolicyAutomationId: z.string().min(1),
    targetDeviceIds: z.array(z.string().min(1)),
    triggeredBy: z.string().min(1),
  }).strict(),
]);

/**
 * AI agents wave 3c: the `ai-agent` queue's only payload.
 *
 * Deliberately carries the run id and NOTHING else — org, device, mode and the
 * policy snapshot all live on the `ai_agent_runs` row the admission gate
 * (`services/aiAgents/runService.ts`) already committed. A job that carried its
 * own copy of the authority could be replayed against a run whose policy has
 * since changed; re-reading the row makes the DB the single source of truth for
 * what the run is allowed to do.
 */
export const aiAgentQueueJobDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('execute-agent-run'),
    runId: z.string().min(1),
  }).strict(),
]);

/**
 * The `agent-notify-retry` queue's only payload (AI agents wave 4a, Task 6,
 * #3826). Carries the run id and nothing else — same reasoning as the
 * `ai-agent` queue above: `deliverRunFinishedNotifications` re-reads the run,
 * agent, and policy snapshot fresh from the DB, so a stale copy in the job
 * payload can never drift from what actually got committed.
 */
export const agentNotifyRetryQueueJobDataSchema = z.object({
  runId: z.string().min(1),
}).strict();

/**
 * The `fix-watch` queue's payload (AI agents wave 6 PR 2, Task 3, #3828).
 * `phase` discriminates the two delayed checks a watch goes through — the
 * job body re-reads the watch (and the alert it references) fresh from the
 * DB by id, so the payload carries nothing beyond identity, same reasoning
 * as `agentNotifyRetryQueueJobDataSchema` above.
 */
export const fixWatchQueueJobDataSchema = z.object({
  phase: z.enum(['phase1', 'phase2']),
  watchId: z.string().min(1),
}).strict();

export const sensitiveDataQueueJobDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dispatch-scan'),
    scanId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('schedule-policies'),
    scanAt: z.string().min(1),
  }).strict(),
]);

export const drExecutionQueueJobDataSchema = z.object({
  type: z.literal('reconcile-execution'),
  executionId: z.string().min(1),
  meta: queueActorMetaSchema.optional(),
}).strict();

export const recoveryMediaQueueJobDataSchema = z.object({
  type: z.literal('build-media'),
  artifactId: z.string().min(1),
  meta: queueActorMetaSchema.optional(),
}).strict();

export const recoveryBootMediaQueueJobDataSchema = z.object({
  type: z.literal('build-boot-media'),
  artifactId: z.string().min(1),
  meta: queueActorMetaSchema.optional(),
}).strict();

export const vulnSourceSyncSchema = z.object({
  source: z.enum(['msrc', 'nvd', 'sofa', 'kev_epss']),
  month: z.string().optional(),
}).strict();

/**
 * Wave 3.5c dispatch queue (#4085): the envelope for a `BreezeEvent` as it
 * rides a job payload. Mirrors `BreezeEvent`'s own field set exactly (see
 * services/eventBus.ts) rather than the full EventType union — `type` stays
 * `z.string()` so adding a new event type never requires a matching edit
 * here. `payload` and `metadata.correlationId/causationId/userId` stay open
 * (the publisher already owns their shape); only the envelope itself is
 * `.strict()` so a genuinely new top-level BreezeEvent field is caught here.
 */
const breezeEventMetadataJobSchema = z.object({
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  userId: z.string().optional(),
  timestamp: z.string().min(1),
}).strict();

const breezeEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  orgId: z.string().min(1),
  audienceUserId: z.string().min(1).optional(),
  siteId: z.string().min(1).optional(),
  source: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  payload: z.record(z.string(), z.unknown()),
  metadata: breezeEventMetadataJobSchema,
}).strict();

const eventSubscriberIdSchema = z.enum(EVENT_SUBSCRIBER_IDS);

/**
 * `event-dispatch` queue, `route-event` job (services/eventDispatchQueue.ts).
 * Snapshots the PUBLISHER's routing plan verbatim — the router (task 6) trusts
 * `matchedSubscriberIds`/`queueSubscriberIds` as-is and never recomputes them.
 */
export const routeEventJobDataSchema = z.object({
  v: z.literal(1),
  mode: z.enum(['shadow', 'enforce']),
  event: breezeEventEnvelopeSchema,
  matchedSubscriberIds: z.array(eventSubscriberIdSchema),
  queueSubscriberIds: z.array(eventSubscriberIdSchema),
}).strict();

/**
 * `event-dispatch` queue, `deliver-event` job — one durable delivery to ONE
 * subscriber (produced by the router from a route-event job's
 * `queueSubscriberIds`; consumed by the per-subscriber delivery worker).
 */
export const deliverEventJobDataSchema = z.object({
  v: z.literal(1),
  subscriberId: eventSubscriberIdSchema,
  event: breezeEventEnvelopeSchema,
}).strict();

export type BackupQueueJobData = z.infer<typeof backupQueueJobDataSchema>;
export type DiscoveryQueueJobData = z.infer<typeof discoveryQueueJobDataSchema>;
export type FdbEntry = z.infer<typeof fdbEntrySchema>;
export type MonitorQueueJobData = z.infer<typeof monitorQueueJobDataSchema>;
export type AutomationQueueJobData = z.infer<typeof automationQueueJobDataSchema>;
export type AutomationAssignmentLevel = z.infer<typeof automationAssignmentLevelSchema>;
export type SensitiveDataQueueJobData = z.infer<typeof sensitiveDataQueueJobDataSchema>;
export type AiAgentQueueJobData = z.infer<typeof aiAgentQueueJobDataSchema>;
export type AgentNotifyRetryQueueJobData = z.infer<typeof agentNotifyRetryQueueJobDataSchema>;
export type FixWatchQueueJobData = z.infer<typeof fixWatchQueueJobDataSchema>;
export type DrExecutionQueueJobData = z.infer<typeof drExecutionQueueJobDataSchema>;
export type RecoveryMediaQueueJobData = z.infer<typeof recoveryMediaQueueJobDataSchema>;
export type RecoveryBootMediaQueueJobData = z.infer<typeof recoveryBootMediaQueueJobDataSchema>;
export type VulnSourceSyncJobData = z.infer<typeof vulnSourceSyncSchema>;
export type QueueActorMeta = z.infer<typeof queueActorMetaSchema>;
// Note: NOT named RouteEventJobData/DeliverEventJobData — those canonical
// interfaces are hand-written in services/eventDispatchQueue.ts (the
// Task 6 contract surface); these are this file's schema-inferred shapes,
// used for defensive parsing at the dequeue boundary.
export type RouteEventQueueJobData = z.infer<typeof routeEventJobDataSchema>;
export type DeliverEventQueueJobData = z.infer<typeof deliverEventJobDataSchema>;

export function withQueueMeta<T extends Record<string, unknown>>(
  payload: T,
  meta: QueueActorMeta
): T & { meta: QueueActorMeta } {
  return {
    ...payload,
    meta,
  };
}
