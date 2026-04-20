import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import {
  backupSnapshots,
  restoreJobs,
  devices,
} from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { recordBackupDispatchFailure } from '../../services/backupMetrics';
import { queueCommandForExecution, CommandTypes } from '../../services/commandQueue';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import {
  bmrVmRestoreSchema,
  instantBootSchema,
} from './schemas';

export const vmRestoreRoutes = new Hono();

function runInOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
      fn
    )
  );
}

type VmRestoreDispatchOptions = {
  restoreJobId: string;
  orgId: string;
  deviceId: string;
  commandType: typeof CommandTypes.VM_RESTORE_FROM_BACKUP | typeof CommandTypes.VM_INSTANT_BOOT;
  commandPayload: Record<string, unknown>;
  userId?: string | null;
};

type VmRestoreDispatchResult = {
  commandId?: string;
  error?: string;
  restoreJob?: typeof restoreJobs.$inferSelect;
};

function mapDispatchErrorStatus(error: string): number {
  return error.startsWith('Device is ') ? 409 : 502;
}

function dispatchFailureReason(error: string): string {
  return error.startsWith('Device is ') ? 'device_offline' : 'enqueue_failed';
}

async function markRestoreJobFailed(orgId: string, restoreJobId: string, error: string): Promise<void> {
  const now = new Date();
  await runInOrg(orgId, async () => {
    await db
      .update(restoreJobs)
      .set({
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object('error', ${error})`,
      })
      .where(eq(restoreJobs.id, restoreJobId));
  });
}

async function dispatchVmRestoreCommand(options: VmRestoreDispatchOptions): Promise<VmRestoreDispatchResult> {
  const { restoreJobId, orgId, deviceId, commandType, commandPayload, userId } = options;
  const { command, error } = await runInOrg(orgId, () =>
    queueCommandForExecution(
      deviceId,
      commandType,
      commandPayload,
      { userId: userId ?? undefined },
    )
  );

  if (error) {
    recordBackupDispatchFailure('manual_restore', dispatchFailureReason(error));
    await markRestoreJobFailed(orgId, restoreJobId, error);
    return { error };
  }

  if (!command?.id) {
    const fallbackError = 'Restore command was queued without a command ID';
    recordBackupDispatchFailure('manual_restore', 'missing_command_id');
    await markRestoreJobFailed(orgId, restoreJobId, fallbackError);
    return { error: fallbackError };
  }

  const [updatedRestoreJob] = await runInOrg(orgId, async () =>
    db
      .update(restoreJobs)
      .set({
        commandId: command.id,
        status: command.status === 'sent' ? 'running' : 'pending',
        startedAt: command.status === 'sent' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(restoreJobs.id, restoreJobId))
      .returning()
  );

  return { commandId: command.id, restoreJob: updatedRestoreJob };
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
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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

    if (targetDevice.status !== 'online') {
      recordBackupDispatchFailure('manual_restore', 'device_offline');
      return c.json({ error: `Device is ${targetDevice.status}, cannot execute command` }, 409);
    }

    // Create restore job.
    const [restoreJob] = await runInOrg(orgId, async () =>
      db
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
        .returning()
    );

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

    let responseRow = restoreJob;
    let commandId: string | null = null;

    try {
      const dispatchResult = await dispatchVmRestoreCommand({
        restoreJobId: restoreJob.id,
        orgId,
        deviceId: payload.targetDeviceId,
        commandType: CommandTypes.VM_RESTORE_FROM_BACKUP,
        commandPayload,
        userId: auth.user?.id,
      });

      if (dispatchResult.error) {
        return c.json(
          { error: dispatchResult.error },
          mapDispatchErrorStatus(dispatchResult.error) as any
        );
      }

      commandId = dispatchResult.commandId ?? null;
      if (dispatchResult.restoreJob) {
        responseRow = dispatchResult.restoreJob;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to dispatch restore command to agent';
      console.error('[BMR] Failed to dispatch VM restore command:', err);
      recordBackupDispatchFailure('manual_restore', 'enqueue_failed');
      await markRestoreJobFailed(orgId, restoreJob.id, error);
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
        id: responseRow.id,
        status: responseRow.status,
        snapshotId: responseRow.snapshotId,
        deviceId: responseRow.deviceId,
        commandId: responseRow.commandId ?? commandId,
        createdAt: responseRow.createdAt.toISOString(),
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
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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

    if (targetDevice.status !== 'online') {
      recordBackupDispatchFailure('manual_restore', 'device_offline');
      return c.json({ error: `Device is ${targetDevice.status}, cannot execute command` }, 409);
    }

    // Create restore job.
    const [restoreJob] = await runInOrg(orgId, async () =>
      db
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
        .returning()
    );

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

    let responseRow = restoreJob;
    let commandId: string | null = null;

    try {
      const dispatchResult = await dispatchVmRestoreCommand({
        restoreJobId: restoreJob.id,
        orgId,
        deviceId: payload.targetDeviceId,
        commandType: CommandTypes.VM_INSTANT_BOOT,
        commandPayload,
        userId: auth.user?.id,
      });

      if (dispatchResult.error) {
        return c.json(
          { error: dispatchResult.error },
          mapDispatchErrorStatus(dispatchResult.error) as any
        );
      }

      commandId = dispatchResult.commandId ?? null;
      if (dispatchResult.restoreJob) {
        responseRow = dispatchResult.restoreJob;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to dispatch instant boot command to agent';
      console.error('[BMR] Failed to dispatch instant boot command:', err);
      recordBackupDispatchFailure('manual_restore', 'enqueue_failed');
      await markRestoreJobFailed(orgId, restoreJob.id, error);
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
        id: responseRow.id,
        status: responseRow.status,
        snapshotId: responseRow.snapshotId,
        deviceId: responseRow.deviceId,
        commandId: responseRow.commandId ?? commandId,
        createdAt: responseRow.createdAt.toISOString(),
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
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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
          or(
            sql`${restoreJobs.status} in ('pending', 'running')`,
            sql`${restoreJobs.status} = 'completed' and coalesce(${restoreJobs.targetConfig} -> 'result' ->> 'backgroundSyncActive', 'false') = 'true'`
          )
        )
      );

    return c.json(
      rows.map((row) => {
        const config = (row.targetConfig ?? {}) as {
          vmName?: string;
          result?: { syncProgress?: number | null; backgroundSyncActive?: boolean };
        };
        const backgroundSyncActive = config.result?.backgroundSyncActive === true;
        const status = backgroundSyncActive
          ? 'running'
          : row.status === 'pending'
            ? 'booting'
            : 'running';
        return {
          id: row.id,
          vmName: config.vmName ?? 'Instant Boot VM',
          status,
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
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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
