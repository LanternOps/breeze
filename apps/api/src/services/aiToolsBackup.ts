/**
 * AI Backup & Disaster Recovery Tools
 *
 * 5 backup/DR tools for querying backup configs, checking health,
 * browsing snapshots, triggering on-demand backups, and restoring.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  configPolicyFeatureLinks,
  configurationPolicies,
  configPolicyBackupSettings,
  restoreJobs,
  devices,
} from '../db/schema';
import { eq, and, desc, sql, gte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { CommandTypes, queueCommandForExecution } from './commandQueue';

type BackupHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof sql.raw> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: BackupHandler): BackupHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[backup:${toolName}]`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

// ============================================
// Register all backup tools into the aiTools Map
// ============================================

export function registerBackupTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_backups — List configs, jobs, policies
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_backups',
      description: 'List backup configurations, jobs, and storage status for the organization.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_configs', 'list_jobs', 'list_policies'],
            description: 'The query action to perform',
          },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'partial'],
            description: 'Filter jobs by status',
          },
          deviceId: { type: 'string', description: 'Filter by device UUID' },
          configId: { type: 'string', description: 'Filter by backup config UUID' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('query_backups', async (input, auth) => {
      const action = input.action as string;
      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

      if (action === 'list_configs') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, backupConfigs.orgId);
        if (oc) conditions.push(oc);

        const rows = await db.select({
          id: backupConfigs.id,
          name: backupConfigs.name,
          type: backupConfigs.type,
          provider: backupConfigs.provider,
          isActive: backupConfigs.isActive,
          createdAt: backupConfigs.createdAt,
        }).from(backupConfigs)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(backupConfigs.createdAt))
          .limit(limit);

        return JSON.stringify({ configs: rows, showing: rows.length });
      }

      if (action === 'list_jobs') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, backupJobs.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.status === 'string') conditions.push(eq(backupJobs.status, input.status as any));
        if (typeof input.deviceId === 'string') conditions.push(eq(backupJobs.deviceId, input.deviceId as string));
        if (typeof input.configId === 'string') conditions.push(eq(backupJobs.configId, input.configId as string));

        const rows = await db.select({
          id: backupJobs.id,
          configId: backupJobs.configId,
          configName: backupConfigs.name,
          deviceId: backupJobs.deviceId,
          hostname: devices.hostname,
          status: backupJobs.status,
          type: backupJobs.type,
          startedAt: backupJobs.startedAt,
          completedAt: backupJobs.completedAt,
          totalSize: backupJobs.totalSize,
          transferredSize: backupJobs.transferredSize,
          fileCount: backupJobs.fileCount,
          errorCount: backupJobs.errorCount,
        }).from(backupJobs)
          .leftJoin(devices, eq(backupJobs.deviceId, devices.id))
          .leftJoin(backupConfigs, eq(backupJobs.configId, backupConfigs.id))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(backupJobs.startedAt))
          .limit(limit);

        return JSON.stringify({ jobs: rows, showing: rows.length });
      }

      if (action === 'list_policies') {
        const orgId = getOrgId(auth);
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const links = await db
          .select({
            featureLinkId: configPolicyFeatureLinks.id,
            configId: configPolicyFeatureLinks.featurePolicyId,
            policyName: configurationPolicies.name,
            schedule: configPolicyBackupSettings.schedule,
            retention: configPolicyBackupSettings.retention,
          })
          .from(configPolicyFeatureLinks)
          .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
          .leftJoin(configPolicyBackupSettings, eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id))
          .where(
            and(
              eq(configPolicyFeatureLinks.featureType, 'backup'),
              eq(configurationPolicies.orgId, orgId),
              eq(configurationPolicies.status, 'active')
            )
          )
          .limit(limit);

        const policies = links.map((link) => ({
          featureLinkId: link.featureLinkId,
          configId: link.configId,
          name: link.policyName,
          schedule: link.schedule,
          retention: link.retention,
        }));

        return JSON.stringify({ policies, showing: policies.length });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 2. get_backup_status — Health summary
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_backup_status',
      description: 'Get backup health summary for a device or the entire organization.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (omit for org-level summary)' },
        },
        required: [],
      },
    },
    handler: safeHandler('get_backup_status', async (input, auth) => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      if (typeof input.deviceId === 'string') {
        const deviceId = input.deviceId as string;

        // Verify device access
        const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
        const dc = orgWhere(auth, devices.orgId);
        if (dc) deviceConditions.push(dc);
        const [device] = await db.select({ id: devices.id }).from(devices)
          .where(and(...deviceConditions)).limit(1);
        if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

        // Latest backup job for device
        const [latestJob] = await db.select({
          id: backupJobs.id,
          status: backupJobs.status,
          startedAt: backupJobs.startedAt,
          completedAt: backupJobs.completedAt,
          totalSize: backupJobs.totalSize,
          errorCount: backupJobs.errorCount,
        }).from(backupJobs)
          .where(eq(backupJobs.deviceId, deviceId))
          .orderBy(desc(backupJobs.startedAt))
          .limit(1);

        // Last successful backup time
        const [lastSuccess] = await db.select({
          completedAt: backupJobs.completedAt,
        }).from(backupJobs)
          .where(and(
            eq(backupJobs.deviceId, deviceId),
            eq(backupJobs.status, 'completed'),
          ))
          .orderBy(desc(backupJobs.completedAt))
          .limit(1);

        // Total snapshot count and size
        const [snapshotStats] = await db.select({
          count: sql<number>`count(*)`,
          totalSize: sql<number>`coalesce(sum(${backupSnapshots.size}), 0)`,
        }).from(backupSnapshots)
          .where(eq(backupSnapshots.deviceId, deviceId));

        return JSON.stringify({
          deviceId,
          latestJob: latestJob ?? null,
          lastSuccessfulBackup: lastSuccess?.completedAt ?? null,
          snapshotCount: snapshotStats?.count ?? 0,
          totalBackupSize: snapshotStats?.totalSize ?? 0,
        });
      }

      // Org-level summary
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, backupConfigs.orgId);
      if (oc) conditions.push(oc);

      // Total and active configs
      const [configStats] = await db.select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where ${backupConfigs.isActive} = true)`,
      }).from(backupConfigs)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      // Jobs by status in last 7 days
      const jobConditions: SQL[] = [gte(backupJobs.createdAt, sevenDaysAgo)];
      const jc = orgWhere(auth, backupJobs.orgId);
      if (jc) jobConditions.push(jc);

      const [jobStats] = await db.select({
        total: sql<number>`count(*)`,
        pending: sql<number>`count(*) filter (where ${backupJobs.status} = 'pending')`,
        running: sql<number>`count(*) filter (where ${backupJobs.status} = 'running')`,
        completed: sql<number>`count(*) filter (where ${backupJobs.status} = 'completed')`,
        failed: sql<number>`count(*) filter (where ${backupJobs.status} = 'failed')`,
        cancelled: sql<number>`count(*) filter (where ${backupJobs.status} = 'cancelled')`,
        partial: sql<number>`count(*) filter (where ${backupJobs.status} = 'partial')`,
      }).from(backupJobs)
        .where(and(...jobConditions));

      // Total snapshot storage
      const snapshotConditions: SQL[] = [];
      const sc = orgWhere(auth, backupSnapshots.orgId);
      if (sc) snapshotConditions.push(sc);

      const [storageStats] = await db.select({
        snapshotCount: sql<number>`count(*)`,
        totalStorage: sql<number>`coalesce(sum(${backupSnapshots.size}), 0)`,
      }).from(backupSnapshots)
        .where(snapshotConditions.length > 0 ? and(...snapshotConditions) : undefined);

      return JSON.stringify({
        configs: {
          total: configStats?.total ?? 0,
          active: configStats?.active ?? 0,
        },
        jobsLast7Days: jobStats ?? {},
        storage: {
          snapshotCount: storageStats?.snapshotCount ?? 0,
          totalBytes: storageStats?.totalStorage ?? 0,
        },
      });
    }),
  });

  // ============================================
  // 3. browse_snapshots — List snapshots for a device
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'browse_snapshots',
      description: 'Browse available backup snapshots for a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (required)' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: ['deviceId'],
      },
    },
    handler: safeHandler('browse_snapshots', async (input, auth) => {
      const deviceId = input.deviceId as string;
      if (!deviceId) return JSON.stringify({ error: 'deviceId is required' });

      // Verify device access
      const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [device] = await db.select({ id: devices.id, hostname: devices.hostname })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);
      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

      const rows = await db.select({
        id: backupSnapshots.id,
        jobId: backupSnapshots.jobId,
        snapshotId: backupSnapshots.snapshotId,
        label: backupSnapshots.label,
        timestamp: backupSnapshots.timestamp,
        size: backupSnapshots.size,
        fileCount: backupSnapshots.fileCount,
        isIncremental: backupSnapshots.isIncremental,
        parentSnapshotId: backupSnapshots.parentSnapshotId,
        expiresAt: backupSnapshots.expiresAt,
        metadata: backupSnapshots.metadata,
        jobStatus: backupJobs.status,
      }).from(backupSnapshots)
        .leftJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
        .where(eq(backupSnapshots.deviceId, deviceId))
        .orderBy(desc(backupSnapshots.timestamp))
        .limit(limit);

      return JSON.stringify({
        deviceId,
        hostname: device.hostname,
        snapshots: rows,
        showing: rows.length,
      });
    }),
  });

  // ============================================
  // 4. trigger_backup — On-demand backup
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'trigger_backup',
      description: 'Initiate an on-demand backup job for a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (required)' },
          configId: { type: 'string', description: 'Backup config UUID (required)' },
        },
        required: ['deviceId', 'configId'],
      },
    },
    handler: safeHandler('trigger_backup', async (input, auth) => {
      const deviceId = input.deviceId as string;
      const configId = input.configId as string;
      if (!deviceId || !configId) return JSON.stringify({ error: 'deviceId and configId are required' });

      const orgId = getOrgId(auth);
      if (!orgId) return JSON.stringify({ error: 'Organization context required' });

      // Verify device access
      const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [device] = await db.select({ id: devices.id }).from(devices)
        .where(and(...deviceConditions)).limit(1);
      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      // Verify config belongs to org
      const configConditions: SQL[] = [eq(backupConfigs.id, configId)];
      const cc = orgWhere(auth, backupConfigs.orgId);
      if (cc) configConditions.push(cc);
      const [config] = await db.select({ id: backupConfigs.id, name: backupConfigs.name })
        .from(backupConfigs)
        .where(and(...configConditions))
        .limit(1);
      if (!config) return JSON.stringify({ error: 'Backup config not found or access denied' });

      // Insert new backup job
      const [job] = await db.insert(backupJobs).values({
        orgId,
        configId,
        deviceId,
        status: 'pending',
        type: 'manual',
      }).returning({ id: backupJobs.id, status: backupJobs.status, createdAt: backupJobs.createdAt });

      return JSON.stringify({
        success: true,
        jobId: job?.id,
        status: job?.status,
        configName: config.name,
        deviceId,
        message: `On-demand backup job created for config "${config.name}"`,
      });
    }),
  });

  // ============================================
  // 5. restore_snapshot — Restore from snapshot
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'restore_snapshot',
      description: 'Restore a backup snapshot to a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          snapshotId: { type: 'string', description: 'Snapshot UUID (required)' },
          deviceId: { type: 'string', description: 'Target device UUID (required)' },
          targetPath: { type: 'string', description: 'Destination path for restore (optional)' },
          selectedPaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific paths to restore (optional, omit for full restore)',
          },
        },
        required: ['snapshotId', 'deviceId'],
      },
    },
    handler: safeHandler('restore_snapshot', async (input, auth) => {
      const snapshotId = input.snapshotId as string;
      const deviceId = input.deviceId as string;
      if (!snapshotId || !deviceId) return JSON.stringify({ error: 'snapshotId and deviceId are required' });

      const orgId = getOrgId(auth);
      if (!orgId) return JSON.stringify({ error: 'Organization context required' });

      // Verify device access
      const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [device] = await db.select({ id: devices.id }).from(devices)
        .where(and(...deviceConditions)).limit(1);
      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      // Verify snapshot exists and belongs to org (via orgId on snapshots table)
      const snapshotConditions: SQL[] = [eq(backupSnapshots.id, snapshotId)];
      const sc = orgWhere(auth, backupSnapshots.orgId);
      if (sc) snapshotConditions.push(sc);
      const [snapshot] = await db.select({
        id: backupSnapshots.id,
        snapshotId: backupSnapshots.snapshotId,
        deviceId: backupSnapshots.deviceId,
      }).from(backupSnapshots)
        .where(and(...snapshotConditions))
        .limit(1);
      if (!snapshot) return JSON.stringify({ error: 'Snapshot not found or access denied' });

      // Determine restore type based on selectedPaths
      const selectedPaths = Array.isArray(input.selectedPaths) ? input.selectedPaths as string[] : undefined;
      const restoreType = selectedPaths && selectedPaths.length > 0 ? 'selective' : 'full';

      // Insert restore job
      const [restoreJob] = await db.insert(restoreJobs).values({
        orgId,
        snapshotId,
        deviceId,
        restoreType,
        targetPath: (input.targetPath as string) ?? null,
        selectedPaths: selectedPaths ?? [],
        status: 'pending',
        initiatedBy: auth.user.id,
      }).returning({ id: restoreJobs.id, status: restoreJobs.status, createdAt: restoreJobs.createdAt });

      return JSON.stringify({
        success: true,
        restoreJobId: restoreJob?.id,
        status: restoreJob?.status,
        restoreType,
        snapshotId: snapshot.snapshotId,
        deviceId,
        message: `Restore job created (${restoreType} restore from snapshot ${snapshot.snapshotId})`,
      });
    }),
  });

  // ============================================
  // 6. restore_as_vm — Restore snapshot as VM
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'restore_as_vm',
      description: 'Restore a backup snapshot as a virtual machine on a target device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          snapshotId: { type: 'string', description: 'Snapshot UUID (required)' },
          targetDeviceId: { type: 'string', description: 'Target device UUID (required)' },
          hypervisor: {
            type: 'string',
            enum: ['hyperv', 'vmware'],
            description: 'Target hypervisor platform',
          },
          vmName: { type: 'string', description: 'Name of the restored VM (required)' },
          vmSpecs: {
            type: 'object',
            properties: {
              memoryMb: { type: 'number' },
              cpuCount: { type: 'number' },
              diskSizeGb: { type: 'number' },
            },
            description: 'Optional VM resource overrides',
          },
        },
        required: ['snapshotId', 'targetDeviceId', 'hypervisor', 'vmName'],
      },
    },
    handler: safeHandler('restore_as_vm', async (input, auth) => {
      const snapshotId = input.snapshotId as string;
      const targetDeviceId = input.targetDeviceId as string;
      const hypervisor = input.hypervisor as string;
      const vmName = input.vmName as string;
      if (!snapshotId || !targetDeviceId || !hypervisor || !vmName) {
        return JSON.stringify({ error: 'snapshotId, targetDeviceId, hypervisor, and vmName are required' });
      }

      const snapshotConditions: SQL[] = [eq(backupSnapshots.id, snapshotId)];
      const sc = orgWhere(auth, backupSnapshots.orgId);
      if (sc) snapshotConditions.push(sc);
      const [snapshot] = await db
        .select({
          id: backupSnapshots.id,
          orgId: backupSnapshots.orgId,
          snapshotId: backupSnapshots.snapshotId,
        })
        .from(backupSnapshots)
        .where(and(...snapshotConditions))
        .limit(1);
      if (!snapshot) return JSON.stringify({ error: 'Snapshot not found or access denied' });

      const deviceConditions: SQL[] = [eq(devices.id, targetDeviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [targetDevice] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);
      if (!targetDevice) return JSON.stringify({ error: 'Target device not found or access denied' });

      const vmSpecs =
        input.vmSpecs && typeof input.vmSpecs === 'object'
          ? input.vmSpecs as Record<string, unknown>
          : {};

      const [restoreJob] = await db
        .insert(restoreJobs)
        .values({
          orgId: snapshot.orgId,
          snapshotId: snapshot.id,
          deviceId: targetDeviceId,
          restoreType: 'full',
          status: 'pending',
          targetConfig: {
            hypervisor,
            vmName,
            ...vmSpecs,
          },
          initiatedBy: auth.user?.id ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: restoreJobs.id, status: restoreJobs.status, createdAt: restoreJobs.createdAt });

      const { command, error } = await queueCommandForExecution(
        targetDeviceId,
        CommandTypes.VM_RESTORE_FROM_BACKUP,
        {
          restoreJobId: restoreJob?.id,
          snapshotId: snapshot.snapshotId,
          hypervisor,
          vmName,
          ...vmSpecs,
        },
        { userId: auth.user?.id }
      );

      if (error) {
        await db
          .update(restoreJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(restoreJobs.id, restoreJob!.id));
        return JSON.stringify({ error });
      }

      return JSON.stringify({
        success: true,
        restoreJobId: restoreJob?.id,
        commandId: command?.id,
        status: restoreJob?.status,
        targetDeviceId,
        hypervisor,
        vmName,
      });
    }),
  });

  // ============================================
  // 7. instant_boot_vm — Instant boot a snapshot
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'instant_boot_vm',
      description: 'Instant boot a backup snapshot as a VM on a target device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          snapshotId: { type: 'string', description: 'Snapshot UUID (required)' },
          targetDeviceId: { type: 'string', description: 'Target device UUID (required)' },
          vmName: { type: 'string', description: 'Name of the instant boot VM (required)' },
          vmSpecs: {
            type: 'object',
            properties: {
              memoryMb: { type: 'number' },
              cpuCount: { type: 'number' },
              diskSizeGb: { type: 'number' },
            },
            description: 'Optional VM resource overrides',
          },
        },
        required: ['snapshotId', 'targetDeviceId', 'vmName'],
      },
    },
    handler: safeHandler('instant_boot_vm', async (input, auth) => {
      const snapshotId = input.snapshotId as string;
      const targetDeviceId = input.targetDeviceId as string;
      const vmName = input.vmName as string;
      if (!snapshotId || !targetDeviceId || !vmName) {
        return JSON.stringify({ error: 'snapshotId, targetDeviceId, and vmName are required' });
      }

      const snapshotConditions: SQL[] = [eq(backupSnapshots.id, snapshotId)];
      const sc = orgWhere(auth, backupSnapshots.orgId);
      if (sc) snapshotConditions.push(sc);
      const [snapshot] = await db
        .select({
          id: backupSnapshots.id,
          orgId: backupSnapshots.orgId,
          snapshotId: backupSnapshots.snapshotId,
        })
        .from(backupSnapshots)
        .where(and(...snapshotConditions))
        .limit(1);
      if (!snapshot) return JSON.stringify({ error: 'Snapshot not found or access denied' });

      const deviceConditions: SQL[] = [eq(devices.id, targetDeviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [targetDevice] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);
      if (!targetDevice) return JSON.stringify({ error: 'Target device not found or access denied' });

      const vmSpecs =
        input.vmSpecs && typeof input.vmSpecs === 'object'
          ? input.vmSpecs as Record<string, unknown>
          : {};

      const [restoreJob] = await db
        .insert(restoreJobs)
        .values({
          orgId: snapshot.orgId,
          snapshotId: snapshot.id,
          deviceId: targetDeviceId,
          restoreType: 'full',
          status: 'pending',
          targetConfig: {
            mode: 'instant_boot',
            vmName,
            ...vmSpecs,
          },
          initiatedBy: auth.user?.id ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: restoreJobs.id, status: restoreJobs.status, createdAt: restoreJobs.createdAt });

      const { command, error } = await queueCommandForExecution(
        targetDeviceId,
        CommandTypes.VM_INSTANT_BOOT,
        {
          restoreJobId: restoreJob?.id,
          snapshotId: snapshot.snapshotId,
          vmName,
          ...vmSpecs,
        },
        { userId: auth.user?.id }
      );

      if (error) {
        await db
          .update(restoreJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(restoreJobs.id, restoreJob!.id));
        return JSON.stringify({ error });
      }

      return JSON.stringify({
        success: true,
        restoreJobId: restoreJob?.id,
        commandId: command?.id,
        status: restoreJob?.status,
        targetDeviceId,
        vmName,
      });
    }),
  });

  // ============================================
  // 8. get_vm_restore_estimate — Estimate VM resources
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_vm_restore_estimate',
      description: 'Get a resource estimate for restoring a snapshot as a virtual machine.',
      input_schema: {
        type: 'object' as const,
        properties: {
          snapshotId: { type: 'string', description: 'Snapshot UUID (required)' },
        },
        required: ['snapshotId'],
      },
    },
    handler: safeHandler('get_vm_restore_estimate', async (input, auth) => {
      const snapshotId = input.snapshotId as string;
      if (!snapshotId) return JSON.stringify({ error: 'snapshotId is required' });

      const snapshotConditions: SQL[] = [eq(backupSnapshots.id, snapshotId)];
      const sc = orgWhere(auth, backupSnapshots.orgId);
      if (sc) snapshotConditions.push(sc);
      const [snapshot] = await db
        .select({
          id: backupSnapshots.id,
          size: backupSnapshots.size,
          metadata: backupSnapshots.metadata,
          hardwareProfile: backupSnapshots.hardwareProfile,
        })
        .from(backupSnapshots)
        .where(and(...snapshotConditions))
        .limit(1);
      if (!snapshot) return JSON.stringify({ error: 'Snapshot not found or access denied' });

      const hardwareProfile = snapshot.hardwareProfile as {
        cpuCores?: number;
        totalMemoryMB?: number;
        disks?: Array<{ sizeBytes?: number }>;
      } | null;
      const metadata = snapshot.metadata as { platform?: string; osVersion?: string } | null;
      const snapshotSizeGb = Math.ceil(Number(snapshot.size ?? 0) / (1024 * 1024 * 1024));

      const estimate = {
        recommendedMemoryMb: hardwareProfile?.totalMemoryMB ?? Math.max(2048, snapshotSizeGb * 2),
        recommendedCpu: hardwareProfile?.cpuCores ?? 2,
        requiredDiskGb: Math.max(
          snapshotSizeGb * 2,
          hardwareProfile?.disks?.reduce(
            (sum, disk) => sum + Math.ceil(Number(disk.sizeBytes ?? 0) / (1024 * 1024 * 1024)),
            0
          ) ?? 40
        ),
        platform: metadata?.platform ?? 'unknown',
        osVersion: metadata?.osVersion ?? 'unknown',
      };

      return JSON.stringify(estimate);
    }),
  });
}
