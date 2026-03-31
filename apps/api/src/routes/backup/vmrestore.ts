import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupSnapshots,
  restoreJobs,
  devices,
} from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { queueCommandForExecution, CommandTypes } from '../../services/commandQueue';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import {
  bmrVmRestoreSchema,
  instantBootSchema,
} from './schemas';

export const vmRestoreRoutes = new Hono();

type VmRestoreDispatchOptions = {
  restoreJobId: string;
  deviceId: string;
  commandType: typeof CommandTypes.VM_RESTORE_FROM_BACKUP | typeof CommandTypes.VM_INSTANT_BOOT;
  commandPayload: Record<string, unknown>;
  userId?: string | null;
};

function mapDispatchErrorStatus(error: string): number {
  return error.startsWith('Device is ') ? 409 : 502;
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

async function dispatchVmRestoreCommand(options: VmRestoreDispatchOptions): Promise<{ commandId?: string; error?: string }> {
  const { restoreJobId, deviceId, commandType, commandPayload, userId } = options;
  const { command, error } = await queueCommandForExecution(
    deviceId,
    commandType,
    commandPayload,
    { userId: userId ?? undefined },
  );

  if (error) {
    await markRestoreJobFailed(restoreJobId, error);
    return { error };
  }

  if (!command?.id) {
    const fallbackError = 'Restore command was queued without a command ID';
    await markRestoreJobFailed(restoreJobId, fallbackError);
    return { error: fallbackError };
  }

  await db
    .update(restoreJobs)
    .set({
      commandId: command.id,
      updatedAt: new Date(),
    })
    .where(eq(restoreJobs.id, restoreJobId));

  return { commandId: command.id };
}

// ── POST /backup/restore/as-vm — Trigger VM restore ────────────────

vmRestoreRoutes.post(
  '/backup/restore/as-vm',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', bmrVmRestoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    // Verify snapshot.
    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.id, payload.snapshotId),
          eq(backupSnapshots.orgId, orgId)
        )
      )
      .limit(1);

    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    // Verify target device.
    const [targetDevice] = await db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(
        and(eq(devices.id, payload.targetDeviceId), eq(devices.orgId, orgId))
      )
      .limit(1);

    if (!targetDevice) {
      return c.json({ error: 'Target device not found' }, 404);
    }

    // Create restore job.
    const [restoreJob] = await db
      .insert(restoreJobs)
      .values({
        orgId,
        snapshotId: snapshot.id,
        deviceId: payload.targetDeviceId,
        restoreType: 'full',
        status: 'pending',
        initiatedBy: auth.user?.id ?? null,
        targetConfig: {
          hypervisor: payload.hypervisor,
          vmName: payload.vmName,
          switchName: payload.switchName ?? null,
          vmSpecs: payload.vmSpecs ?? {},
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (!restoreJob) {
      return c.json({ error: 'Failed to create restore job' }, 500);
    }

    // Dispatch command to target agent.
    const commandPayload = {
      restoreJobId: restoreJob.id,
      snapshotId: snapshot.snapshotId,
      vmName: payload.vmName,
      memoryMb: payload.vmSpecs?.memoryMb,
      cpuCount: payload.vmSpecs?.cpuCount,
      diskSizeGb: payload.vmSpecs?.diskSizeGb,
      switchName: payload.switchName,
    };

    try {
      const dispatchResult = await dispatchVmRestoreCommand({
        restoreJobId: restoreJob.id,
        deviceId: payload.targetDeviceId,
        commandType: CommandTypes.VM_RESTORE_FROM_BACKUP,
        commandPayload,
        userId: auth.user?.id,
      });

      if (dispatchResult.error) {
        return c.json(
          { error: dispatchResult.error },
          mapDispatchErrorStatus(dispatchResult.error)
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to dispatch restore command to agent';
      console.error('[BMR] Failed to dispatch VM restore command:', err);
      await markRestoreJobFailed(restoreJob.id, error);
      return c.json({ error }, 502);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.vm_restore.create',
      resourceType: 'restore_job',
      resourceId: restoreJob.id,
      details: {
        snapshotId: snapshot.id,
        targetDeviceId: payload.targetDeviceId,
        hypervisor: payload.hypervisor,
        vmName: payload.vmName,
      },
    });

    return c.json(
      {
        id: restoreJob.id,
        status: restoreJob.status,
        snapshotId: restoreJob.snapshotId,
        deviceId: restoreJob.deviceId,
        createdAt: restoreJob.createdAt.toISOString(),
      },
      201
    );
  }
);

// ── POST /backup/restore/instant-boot — Trigger instant boot VM ───────

vmRestoreRoutes.post(
  '/backup/restore/instant-boot',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', instantBootSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    // Verify snapshot.
    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.id, payload.snapshotId),
          eq(backupSnapshots.orgId, orgId)
        )
      )
      .limit(1);

    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    // Verify target device.
    const [targetDevice] = await db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(
        and(eq(devices.id, payload.targetDeviceId), eq(devices.orgId, orgId))
      )
      .limit(1);

    if (!targetDevice) {
      return c.json({ error: 'Target device not found' }, 404);
    }

    // Create restore job.
    const [restoreJob] = await db
      .insert(restoreJobs)
      .values({
        orgId,
        snapshotId: snapshot.id,
        deviceId: payload.targetDeviceId,
        restoreType: 'full',
        status: 'pending',
        initiatedBy: auth.user?.id ?? null,
        targetConfig: {
          mode: 'instant_boot',
          vmName: payload.vmName,
          vmSpecs: payload.vmSpecs ?? {},
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (!restoreJob) {
      return c.json({ error: 'Failed to create restore job' }, 500);
    }

    // Dispatch instant boot command to target agent.
    const commandPayload = {
      restoreJobId: restoreJob.id,
      snapshotId: snapshot.snapshotId,
      vmName: payload.vmName,
      memoryMb: payload.vmSpecs?.memoryMb,
      cpuCount: payload.vmSpecs?.cpuCount,
      diskSizeGb: payload.vmSpecs?.diskSizeGb,
    };

    try {
      const dispatchResult = await dispatchVmRestoreCommand({
        restoreJobId: restoreJob.id,
        deviceId: payload.targetDeviceId,
        commandType: CommandTypes.VM_INSTANT_BOOT,
        commandPayload,
        userId: auth.user?.id,
      });

      if (dispatchResult.error) {
        return c.json(
          { error: dispatchResult.error },
          mapDispatchErrorStatus(dispatchResult.error)
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to dispatch instant boot command to agent';
      console.error('[BMR] Failed to dispatch instant boot command:', err);
      await markRestoreJobFailed(restoreJob.id, error);
      return c.json({ error }, 502);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.instant_boot.create',
      resourceType: 'restore_job',
      resourceId: restoreJob.id,
      details: {
        snapshotId: snapshot.id,
        targetDeviceId: payload.targetDeviceId,
        vmName: payload.vmName,
      },
    });

    return c.json(
      {
        id: restoreJob.id,
        status: restoreJob.status,
        snapshotId: restoreJob.snapshotId,
        deviceId: restoreJob.deviceId,
        createdAt: restoreJob.createdAt.toISOString(),
      },
      201
    );
  }
);

// ── GET /backup/restore/instant-boot/active — Active instant boots ─────────

vmRestoreRoutes.get(
  '/backup/restore/instant-boot/active',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const rows = await db
      .select({
        id: restoreJobs.id,
        status: restoreJobs.status,
        snapshotId: restoreJobs.snapshotId,
        deviceId: restoreJobs.deviceId,
        startedAt: restoreJobs.startedAt,
        completedAt: restoreJobs.completedAt,
        targetConfig: restoreJobs.targetConfig,
        hostDeviceName: devices.hostname,
      })
      .from(restoreJobs)
      .innerJoin(devices, eq(restoreJobs.deviceId, devices.id))
      .where(
        and(
          eq(restoreJobs.orgId, orgId),
          sql`${restoreJobs.targetConfig} ->> 'mode' = 'instant_boot'`,
          sql`${restoreJobs.status} in ('pending', 'running')`
        )
      );

    return c.json(
      rows.map((row) => {
        const config = (row.targetConfig ?? {}) as {
          vmName?: string;
          result?: { syncProgress?: number | null };
        };
        return {
          id: row.id,
          vmName: config.vmName ?? 'Instant Boot VM',
          status: row.status === 'pending' ? 'booting' : 'running',
          hostDeviceId: row.deviceId,
          hostDeviceName: row.hostDeviceName,
          snapshotId: row.snapshotId,
          syncProgress: config.result?.syncProgress ?? null,
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
        };
      })
    );
  }
);

// ── GET /backup/restore/as-vm/estimate/:snapshotId — VM estimate ────

vmRestoreRoutes.get('/backup/restore/as-vm/estimate/:snapshotId', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const snapshotId = c.req.param('snapshotId')!;
  const [snapshot] = await db
    .select()
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.id, snapshotId),
        eq(backupSnapshots.orgId, orgId)
      )
    )
    .limit(1);

  if (!snapshot) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  // Compute estimate from hardware profile or snapshot size.
  const hw = snapshot.hardwareProfile as {
    cpuCores?: number;
    totalMemoryMB?: number;
    disks?: { sizeBytes?: number }[];
  } | null;

  const snapshotSizeGB = Math.ceil((snapshot.size ?? 0) / (1024 * 1024 * 1024));

  const estimate = {
    memoryMb: hw?.totalMemoryMB ?? Math.max(2048, snapshotSizeGB * 2),
    cpuCount: hw?.cpuCores ?? 2,
    diskSizeGb: Math.max(
      snapshotSizeGB * 2,
      hw?.disks?.reduce(
        (sum, d) => sum + Math.ceil((d.sizeBytes ?? 0) / (1024 * 1024 * 1024)),
        0
      ) ?? 40
    ),
    platform: (snapshot.metadata as { platform?: string } | null)?.platform ?? 'unknown',
    osVersion:
      (snapshot.metadata as { osVersion?: string } | null)?.osVersion ?? 'unknown',
  };

  return c.json(estimate);
});
