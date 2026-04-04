import { z } from 'zod';

export const queueActorMetaSchema = z.object({
  actorType: z.enum(['system', 'agent', 'user', 'service']),
  actorId: z.string().min(1).nullable().optional(),
  source: z.string().min(1),
}).strict();

const queueMetaEnvelopeSchema = z.object({
  meta: queueActorMetaSchema.optional(),
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
  firstSeen: z.string().optional(),
  lastSeen: z.string().optional(),
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

export type BackupQueueJobData = z.infer<typeof backupQueueJobDataSchema>;
export type DiscoveryQueueJobData = z.infer<typeof discoveryQueueJobDataSchema>;
export type MonitorQueueJobData = z.infer<typeof monitorQueueJobDataSchema>;
export type DrExecutionQueueJobData = z.infer<typeof drExecutionQueueJobDataSchema>;
export type RecoveryMediaQueueJobData = z.infer<typeof recoveryMediaQueueJobDataSchema>;
export type RecoveryBootMediaQueueJobData = z.infer<typeof recoveryBootMediaQueueJobDataSchema>;
export type QueueActorMeta = z.infer<typeof queueActorMetaSchema>;

export function withQueueMeta<T extends z.infer<typeof queueMetaEnvelopeSchema>>(
  payload: T,
  meta: QueueActorMeta
): T {
  return {
    ...payload,
    meta,
  };
}
