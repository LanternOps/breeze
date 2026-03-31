/**
 * AI Backup VM Restore Tools
 *
 * 3 VM-specific tools extracted from aiToolsBackup.ts:
 * restore_as_vm, instant_boot_vm, get_vm_restore_estimate
 */

import { db } from '../db';
import {
  backupSnapshots,
  restoreJobs,
  devices,
} from '../db/schema';
import { eq, and, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { CommandTypes, queueCommandForExecution } from './commandQueue';

type BackupHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof sql.raw> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

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

async function markRestoreJobFailed(restoreJobId: string, error: string): Promise<void> {
  const now = new Date();
  await db
    .update(restoreJobs)
    .set({
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object('error', ${error})`,
    })
    .where(eq(restoreJobs.id, restoreJobId));
}

export function registerBackupVmTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // restore_as_vm — Restore snapshot as VM
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
            enum: ['hyperv'],
            description: 'Target hypervisor platform',
          },
          vmName: { type: 'string', description: 'Name of the restored VM (required)' },
          switchName: { type: 'string', description: 'Optional Hyper-V switch name' },
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
      const switchName = typeof input.switchName === 'string' ? input.switchName : undefined;
      if (!snapshotId || !targetDeviceId || !hypervisor || !vmName) {
        return JSON.stringify({ error: 'snapshotId, targetDeviceId, hypervisor, and vmName are required' });
      }
      if (hypervisor !== 'hyperv') {
        return JSON.stringify({ error: 'Only Hyper-V VM restore is currently supported' });
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
            switchName: switchName ?? null,
            vmSpecs,
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
          vmName,
          memoryMb: vmSpecs.memoryMb,
          cpuCount: vmSpecs.cpuCount,
          diskSizeGb: vmSpecs.diskSizeGb,
          switchName,
        },
        { userId: auth.user?.id }
      );

      if (error) {
        await markRestoreJobFailed(restoreJob!.id, error);
        return JSON.stringify({ error });
      }

      if (!command?.id) {
        const commandError = 'Restore command was queued without a command ID';
        await markRestoreJobFailed(restoreJob!.id, commandError);
        return JSON.stringify({ error: commandError });
      }

      await db
        .update(restoreJobs)
        .set({
          commandId: command.id,
          updatedAt: new Date(),
        })
        .where(eq(restoreJobs.id, restoreJob!.id));

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
  // instant_boot_vm — Instant boot a snapshot
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
            vmSpecs,
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
          memoryMb: vmSpecs.memoryMb,
          cpuCount: vmSpecs.cpuCount,
          diskSizeGb: vmSpecs.diskSizeGb,
        },
        { userId: auth.user?.id }
      );

      if (error) {
        await markRestoreJobFailed(restoreJob!.id, error);
        return JSON.stringify({ error });
      }

      if (!command?.id) {
        const commandError = 'Instant boot command was queued without a command ID';
        await markRestoreJobFailed(restoreJob!.id, commandError);
        return JSON.stringify({ error: commandError });
      }

      await db
        .update(restoreJobs)
        .set({
          commandId: command.id,
          updatedAt: new Date(),
        })
        .where(eq(restoreJobs.id, restoreJob!.id));

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
  // get_vm_restore_estimate — Estimate VM resources
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
