import { z } from 'zod';

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
  jobId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  filesBackedUp: z.number().int().nonnegative().optional(),
  bytesBackedUp: z.number().nonnegative().optional(),
  warning: z.string().min(1).optional(),
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

export type BackupQueueJobData = z.infer<typeof backupQueueJobDataSchema>;
export type DiscoveryQueueJobData = z.infer<typeof discoveryQueueJobDataSchema>;
export type FdbEntry = z.infer<typeof fdbEntrySchema>;
export type MonitorQueueJobData = z.infer<typeof monitorQueueJobDataSchema>;
export type AutomationQueueJobData = z.infer<typeof automationQueueJobDataSchema>;
export type AutomationAssignmentLevel = z.infer<typeof automationAssignmentLevelSchema>;
export type SensitiveDataQueueJobData = z.infer<typeof sensitiveDataQueueJobDataSchema>;
export type DrExecutionQueueJobData = z.infer<typeof drExecutionQueueJobDataSchema>;
export type RecoveryMediaQueueJobData = z.infer<typeof recoveryMediaQueueJobDataSchema>;
export type RecoveryBootMediaQueueJobData = z.infer<typeof recoveryBootMediaQueueJobDataSchema>;
export type VulnSourceSyncJobData = z.infer<typeof vulnSourceSyncSchema>;
export type QueueActorMeta = z.infer<typeof queueActorMetaSchema>;

export function withQueueMeta<T extends Record<string, unknown>>(
  payload: T,
  meta: QueueActorMeta
): T & { meta: QueueActorMeta } {
  return {
    ...payload,
    meta,
  };
}
