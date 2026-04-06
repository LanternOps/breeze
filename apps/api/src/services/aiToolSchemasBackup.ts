/**
 * AI Backup & DR Tool Input Schemas
 *
 * Zod schemas for validating backup, MSSQL, Hyper-V, Vault,
 * Cloud-to-Cloud, SLA, and DR plan tool inputs.
 * Extracted from aiToolSchemas.ts to keep file sizes manageable.
 */

import { z } from 'zod';

// Reusable validators (duplicated locally to avoid circular imports)
const uuid = z.string().uuid();
const backupEntityId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const backupPath = z.string().max(4096).refine(
  (path) => !path.includes('\0'),
  { message: 'Path contains null bytes' }
).refine(
  (path) => !path.includes('..'),
  { message: 'Path traversal (..) not allowed' }
);

export const backupToolSchemas: Record<string, z.ZodType> = {
  // Backup & DR tool modules
  query_backups: z.object({
    action: z.enum(['list_configs', 'list_jobs', 'list_policies']),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'partial']).optional(),
    deviceId: uuid.optional(),
    configId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_backup_status: z.object({
    deviceId: uuid.optional(),
  }),

  browse_snapshots: z.object({
    deviceId: uuid,
    limit: z.number().int().min(1).max(100).optional(),
  }),

  trigger_backup: z.object({
    deviceId: uuid,
    configId: uuid,
  }),

  restore_snapshot: z.object({
    snapshotId: uuid,
    deviceId: uuid,
    targetPath: backupPath.optional(),
    selectedPaths: z.array(backupPath).max(1000).optional(),
  }),

  restore_as_vm: z.object({
    snapshotId: uuid,
    targetDeviceId: uuid,
    hypervisor: z.enum(['hyperv', 'vmware']),
    vmName: z.string().min(1).max(200),
    vmSpecs: z.object({
      memoryMb: z.number().int().min(512).optional(),
      cpuCount: z.number().int().min(1).optional(),
      diskSizeGb: z.number().int().min(1).optional(),
    }).optional(),
  }),

  instant_boot_vm: z.object({
    snapshotId: uuid,
    targetDeviceId: uuid,
    vmName: z.string().min(1).max(200),
    vmSpecs: z.object({
      memoryMb: z.number().int().min(512).optional(),
      cpuCount: z.number().int().min(1).optional(),
      diskSizeGb: z.number().int().min(1).optional(),
    }).optional(),
  }),

  get_vm_restore_estimate: z.object({
    snapshotId: uuid,
  }),

  query_mssql_instances: z.object({
    deviceId: uuid.optional(),
    status: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_mssql_backup_status: z.object({
    deviceId: uuid.optional(),
    database: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  trigger_mssql_backup: z.object({
    deviceId: uuid,
    instance: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\-. ]+$/),
    database: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\-. ]+$/),
    backupType: z.enum(['full', 'differential', 'log']).optional(),
  }),

  restore_mssql_database: z.object({
    deviceId: uuid,
    snapshotId: uuid,
    instance: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\-. ]+$/).optional(),
    targetDatabase: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\-. ]+$/),
    noRecovery: z.boolean().optional(),
  }),

  verify_mssql_backup: z.object({
    snapshotId: uuid,
    instance: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\-. ]+$/).optional(),
  }),

  query_hyperv_vms: z.object({
    deviceId: uuid.optional(),
    state: z.string().max(30).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_hyperv_vm_details: z.object({
    vmId: uuid,
  }),

  manage_hyperv_vm: z.object({
    vmId: uuid,
    action: z.enum(['start', 'stop', 'force_stop', 'pause', 'resume', 'save']),
  }),

  trigger_hyperv_backup: z.object({
    vmId: uuid,
    consistencyType: z.enum(['application', 'crash']).optional(),
  }),

  restore_hyperv_vm: z.object({
    deviceId: uuid,
    snapshotId: uuid,
    vmName: z.string().min(1).max(256).optional(),
    generateNewId: z.boolean().optional(),
  }),

  manage_hyperv_checkpoints: z.object({
    vmId: uuid,
    action: z.enum(['create', 'delete', 'apply']),
    checkpointName: z.string().max(256).optional(),
  }),

  query_vaults: z.object({
    deviceId: uuid.optional(),
    isActive: z.boolean().optional(),
    lastSyncStatus: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_vault_status: z.object({
    deviceId: uuid,
  }),

  trigger_vault_sync: z.object({
    vaultId: uuid,
    snapshotId: z.string().min(1).max(200).optional(),
  }),

  configure_vault: z.object({
    action: z.enum(['create', 'update']),
    vaultId: uuid.optional(),
    deviceId: uuid.optional(),
    vaultPath: backupPath.optional(),
    vaultType: z.enum(['local', 'smb', 'usb']).optional(),
    retentionCount: z.number().int().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  }).superRefine((data, ctx) => {
    if (data.action === 'create') {
      if (!data.deviceId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deviceId'], message: 'deviceId is required for create' });
      }
      if (!data.vaultPath) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vaultPath'], message: 'vaultPath is required for create' });
      }
    }
    if (data.action === 'update' && !data.vaultId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vaultId'], message: 'vaultId is required for update' });
    }
  }),

  query_c2c_connections: z.object({
    provider: z.string().max(30).optional(),
    status: z.string().max(30).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  query_c2c_jobs: z.object({
    configId: uuid.optional(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  search_c2c_items: z.object({
    configId: uuid.optional(),
    userEmail: z.string().email().optional(),
    itemType: z.string().max(50).optional(),
    keyword: z.string().max(500).optional(),
    includeDeleted: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(100000).optional(),
  }),

  trigger_c2c_sync: z.object({
    configId: uuid,
  }),

  restore_c2c_items: z.object({
    itemIds: z.array(uuid).min(1).max(1000),
    targetConnectionId: uuid.optional(),
  }),

  query_backup_sla: z.object({
    isActive: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_sla_breaches: z.object({
    configId: uuid.optional(),
    deviceId: uuid.optional(),
    eventType: z.string().max(50).optional(),
    unresolvedOnly: z.boolean().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_sla_compliance_report: z.object({
    daysBack: z.number().int().min(1).max(365).optional(),
  }),

  configure_backup_sla: z.object({
    action: z.enum(['create', 'update']),
    configId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    rpoTargetMinutes: z.number().int().min(1).optional(),
    rtoTargetMinutes: z.number().int().min(1).optional(),
    targetDevices: z.array(uuid).max(5000).optional(),
    targetGroups: z.array(uuid).max(5000).optional(),
    alertOnBreach: z.boolean().optional(),
    isActive: z.boolean().optional(),
  }).superRefine((data, ctx) => {
    if (data.action === 'create') {
      if (!data.name) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'name is required for create' });
      }
      if (!data.rpoTargetMinutes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rpoTargetMinutes'], message: 'rpoTargetMinutes is required for create' });
      }
      if (!data.rtoTargetMinutes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rtoTargetMinutes'], message: 'rtoTargetMinutes is required for create' });
      }
    }
    if (data.action === 'update' && !data.configId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['configId'], message: 'configId is required for update' });
    }
  }),

  query_dr_plans: z.object({
    status: z.enum(['draft', 'active', 'archived']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_dr_plan_details: z.object({
    planId: uuid,
  }),

  get_dr_execution_status: z.object({
    executionId: uuid.optional(),
    planId: uuid.optional(),
    status: z.string().max(30).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  execute_dr_plan: z.object({
    planId: uuid,
    executionType: z.enum(['rehearsal', 'failover', 'failback']),
  }),

  manage_dr_plan: z.object({
    action: z.enum(['create_plan', 'update_plan', 'add_group', 'update_group', 'delete_group']),
    planId: uuid.optional(),
    groupId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    rpoTargetMinutes: z.number().int().min(1).optional(),
    rtoTargetMinutes: z.number().int().min(1).optional(),
    sequence: z.number().int().min(0).optional(),
    dependsOnGroupId: uuid.optional(),
    devices: z.array(uuid).max(5000).optional(),
    restoreConfig: z.record(z.unknown()).optional(),
    estimatedDurationMinutes: z.number().int().min(0).optional(),
  }).superRefine((data, ctx) => {
    if ((data.action === 'update_plan' || data.action === 'add_group' || data.action === 'update_group' || data.action === 'delete_group') && !data.planId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planId'], message: 'planId is required for this action' });
    }
    if ((data.action === 'update_group' || data.action === 'delete_group') && !data.groupId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groupId'], message: 'groupId is required for this action' });
    }
    if (data.action === 'create_plan' && !data.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'name is required for create_plan' });
    }
    if (data.action === 'add_group' && !data.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'name is required for add_group' });
    }
  }),

  get_backup_health: z.object({
    orgId: uuid.optional(),
    deviceId: backupEntityId.optional(),
  }),

  run_backup_verification: z.object({
    orgId: uuid.optional(),
    deviceId: backupEntityId,
    backupJobId: backupEntityId.optional(),
    snapshotId: backupEntityId.optional(),
    verificationType: z.enum(['integrity', 'test_restore']).optional(),
  }),

  get_recovery_readiness: z.object({
    orgId: uuid.optional(),
    deviceId: backupEntityId.optional(),
    includeRiskFactors: z.boolean().optional(),
  }),
};
