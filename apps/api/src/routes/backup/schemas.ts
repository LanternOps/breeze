import { z } from 'zod';

const queryBoolean = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return value;
}, z.boolean());

export const configSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['s3', 'local']),
  enabled: z.boolean().optional(),
  details: z.record(z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional()
});

export const configUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  details: z.record(z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional()
});

export const policyTargetsSchema = z.object({
  deviceIds: z.array(z.string()).optional(),
  siteIds: z.array(z.string()).optional(),
  groupIds: z.array(z.string()).optional()
});

export const policyScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional()
});

export const policyRetentionSchema = z.object({
  keepDaily: z.number().int().min(1).optional(),
  keepWeekly: z.number().int().min(1).optional(),
  keepMonthly: z.number().int().min(1).optional()
});

export const policySchema = z.object({
  name: z.string().min(1),
  configId: z.string().min(1),
  enabled: z.boolean().optional(),
  targets: policyTargetsSchema.optional(),
  schedule: policyScheduleSchema,
  retention: policyRetentionSchema.optional()
});

export const policyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  configId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  targets: policyTargetsSchema.partial().optional(),
  schedule: policyScheduleSchema.partial().optional(),
  retention: policyRetentionSchema.partial().optional()
});

export const jobListSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
  device: z.string().optional(),
  deviceId: z.string().optional(),
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

export const snapshotListSchema = z.object({
  deviceId: z.string().optional(),
  configId: z.string().optional()
});

export const usageHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(3).max(90).optional()
});

export const restoreSchema = z.object({
  snapshotId: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  targetPath: z.string().optional(),
  selectedPaths: z.array(z.string()).optional(),
});

export const verificationRunSchema = z.object({
  deviceId: z.string().min(1),
  backupJobId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  verificationType: z.enum(['integrity', 'test_restore', 'full_recovery']).optional(),
  highImpactApproved: z.boolean().optional()
});

export const verificationListSchema = z.object({
  deviceId: z.string().optional(),
  backupJobId: z.string().optional(),
  verificationType: z.enum(['integrity', 'test_restore', 'full_recovery']).optional(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'partial']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

export const backupHealthQuerySchema = z.object({
  refresh: queryBoolean.optional()
});

export const recoveryReadinessQuerySchema = z.object({
  refresh: queryBoolean.optional(),
  deviceId: z.string().optional()
});

// ── Encryption key schemas ───────────────────────────────────────────────────

export const createEncryptionKeySchema = z.object({
  name: z.string().min(1).max(200),
  keyType: z.enum(['aes_256', 'rsa_2048']).default('aes_256'),
  publicKeyPem: z.string().optional(),
  keyHash: z.string().min(16).max(128),
});

export const rotateEncryptionKeySchema = z.object({
  newKeyHash: z.string().min(16).max(128),
  newPublicKeyPem: z.string().optional(),
});

// ── Extended policy schemas (GFS, legal hold, bandwidth) ─────────────────────

export const gfsConfigSchema = z.object({
  daily: z.number().int().min(1).max(365).optional(),
  weekly: z.number().int().min(1).max(52).optional(),
  monthly: z.number().int().min(1).max(120).optional(),
  yearly: z.number().int().min(1).max(10).optional(),
  weeklyDay: z.number().int().min(0).max(6).optional(),
});

export const extendedPolicySchema = policySchema.extend({
  gfsConfig: gfsConfigSchema.optional(),
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().max(500).optional(),
  bandwidthLimitMbps: z.number().int().min(1).max(10000).optional(),
  backupWindowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  backupWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  priority: z.number().int().min(1).max(100).optional(),
});

export const extendedPolicyUpdateSchema = policyUpdateSchema.extend({
  gfsConfig: gfsConfigSchema.optional(),
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().max(500).optional(),
  bandwidthLimitMbps: z.number().int().min(1).max(10000).optional(),
  backupWindowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  backupWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  priority: z.number().int().min(1).max(100).optional(),
});

// ── BMR / Recovery Token schemas ────────────────────────────────────

export const bmrCreateTokenSchema = z.object({
  snapshotId: z.string().uuid(),
  restoreType: z.enum(['full', 'selective', 'bare_metal']),
  targetConfig: z
    .record(z.any())
    .refine((val) => JSON.stringify(val).length <= 65536, {
      message: 'targetConfig too large (max 64KB)',
    })
    .optional(),
  expiresInHours: z.number().int().min(1).max(168).default(24),
});

export const bmrAuthenticateSchema = z.object({
  token: z.string().min(1),
});

export const bmrCompleteSchema = z.object({
  token: z.string().min(1),
  result: z.object({
    status: z.enum(['completed', 'failed', 'partial']),
    filesRestored: z.number().int().optional(),
    bytesRestored: z.number().int().optional(),
    stateApplied: z.boolean().optional(),
    driversInjected: z.number().int().optional(),
    validated: z.boolean().optional(),
    warnings: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
});

export const bmrVmRestoreSchema = z.object({
  snapshotId: z.string().uuid(),
  targetDeviceId: z.string().uuid(),
  hypervisor: z.enum(['hyperv', 'vmware']),
  vmName: z.string().min(1).max(200),
  vmSpecs: z
    .object({
      memoryMb: z.number().int().min(512).optional(),
      cpuCount: z.number().int().min(1).optional(),
      diskSizeGb: z.number().int().min(1).optional(),
    })
    .optional(),
});

export const instantBootSchema = z.object({
  snapshotId: z.string().uuid(),
  targetDeviceId: z.string().uuid(),
  vmName: z.string().min(1).max(200),
  vmSpecs: z
    .object({
      memoryMb: z.number().int().min(512).optional(),
      cpuCount: z.number().int().min(1).optional(),
      diskSizeGb: z.number().int().min(10).optional(),
    })
    .optional(),
});

// ── Hyper-V VM backup schemas ─────────────────────────────────────────

export const hypervBackupSchema = z.object({
  deviceId: z.string().uuid(),
  vmName: z.string().min(1).max(256),
  exportPath: z.string().min(1).max(1024),
  consistencyType: z.enum(['application', 'crash']).default('application'),
});

export const hypervRestoreSchema = z.object({
  deviceId: z.string().uuid(),
  exportPath: z.string().min(1).max(1024),
  vmName: z.string().min(1).max(256).optional(),
  generateNewId: z.boolean().default(true),
});

export const hypervCheckpointSchema = z.object({
  action: z.enum(['create', 'delete', 'apply']),
  checkpointName: z.string().max(256).optional(),
});

export const hypervVmStateSchema = z.object({
  state: z.enum(['start', 'stop', 'force_stop', 'pause', 'resume', 'save']),
});

export const hypervVmListSchema = z.object({
  deviceId: z.string().uuid().optional(),
  state: z.string().optional(),
});

// ── SLA config schemas ─────────────────────────────────────────────────────

export const slaConfigCreateSchema = z.object({
  name: z.string().min(1).max(200),
  rpoTargetMinutes: z.number().int().min(1),
  rtoTargetMinutes: z.number().int().min(1),
  targetDevices: z.array(z.string().uuid()).optional(),
  targetGroups: z.array(z.string().uuid()).optional(),
  alertOnBreach: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const slaConfigUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  rpoTargetMinutes: z.number().int().min(1).optional(),
  rtoTargetMinutes: z.number().int().min(1).optional(),
  targetDevices: z.array(z.string().uuid()).optional(),
  targetGroups: z.array(z.string().uuid()).optional(),
  alertOnBreach: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const slaEventsQuerySchema = z.object({
  configId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  eventType: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ── DR plan schemas ────────────────────────────────────────────────────────

export const drPlanCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  rpoTargetMinutes: z.number().int().min(1).optional(),
  rtoTargetMinutes: z.number().int().min(1).optional(),
});

export const drPlanUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  rpoTargetMinutes: z.number().int().min(1).optional(),
  rtoTargetMinutes: z.number().int().min(1).optional(),
});

export const drGroupCreateSchema = z.object({
  name: z.string().min(1).max(200),
  sequence: z.number().int().min(0).optional(),
  dependsOnGroupId: z.string().uuid().optional(),
  devices: z.array(z.string().uuid()).optional(),
  restoreConfig: z.record(z.any()).optional(),
  estimatedDurationMinutes: z.number().int().min(0).optional(),
});

export const drGroupUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sequence: z.number().int().min(0).optional(),
  dependsOnGroupId: z.string().uuid().nullable().optional(),
  devices: z.array(z.string().uuid()).optional(),
  restoreConfig: z.record(z.any()).optional(),
  estimatedDurationMinutes: z.number().int().min(0).nullable().optional(),
});

export const drExecutionTriggerSchema = z.object({
  executionType: z.enum(['rehearsal', 'failover', 'failback']),
});

export const drExecutionsQuerySchema = z.object({
  planId: z.string().uuid().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ── Local vault schemas ─────────────────────────────────────────────────────

export const vaultCreateSchema = z.object({
  deviceId: z.string().uuid(),
  vaultPath: z.string().min(1).max(1024)
    .refine(val => !val.includes('..'), { message: 'Path traversal not allowed' })
    .refine(val => !val.includes('\0'), { message: 'Null bytes not allowed in path' }),
  vaultType: z.enum(['local', 'smb', 'usb']).default('local'),
  retentionCount: z.number().int().min(1).max(100).default(3),
});

export const vaultUpdateSchema = z.object({
  vaultPath: z.string().min(1).max(1024).optional(),
  vaultType: z.enum(['local', 'smb', 'usb']).optional(),
  retentionCount: z.number().int().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const vaultListSchema = z.object({
  deviceId: z.string().uuid().optional(),
});

export const vaultSyncSchema = z.object({
  snapshotId: z.string().min(1).max(200).optional(),
});
