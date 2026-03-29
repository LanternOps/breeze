import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupSnapshots,
  restoreJobs,
  devices,
} from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { queueCommandForExecution, CommandTypes } from '../../services/commandQueue';
import { resolveScopedOrgId } from './helpers';
import {
  bmrVmRestoreSchema,
  instantBootSchema,
} from './schemas';

export const vmRestoreRoutes = new Hono();

// ── POST /backup/restore/as-vm — Trigger VM restore ────────────────

vmRestoreRoutes.post(
  '/backup/restore/as-vm',
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
        targetConfig: {
          hypervisor: payload.hypervisor,
          vmName: payload.vmName,
          ...(payload.vmSpecs ?? {}),
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
      hypervisor: payload.hypervisor,
      vmName: payload.vmName,
      ...(payload.vmSpecs ?? {}),
    };

    try {
      await queueCommandForExecution(
        payload.targetDeviceId,
        CommandTypes.VM_RESTORE_FROM_BACKUP,
        commandPayload,
        { userId: auth.user?.id }
      );
    } catch (err) {
      console.error('[BMR] Failed to dispatch VM restore command:', err);
      await db.update(restoreJobs).set({
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(restoreJobs.id, restoreJob.id));
      return c.json({ error: 'Failed to dispatch restore command to agent' }, 502);
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
        targetConfig: {
          mode: 'instant_boot',
          vmName: payload.vmName,
          ...(payload.vmSpecs ?? {}),
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
      ...(payload.vmSpecs ?? {}),
    };

    try {
      await queueCommandForExecution(
        payload.targetDeviceId,
        CommandTypes.VM_INSTANT_BOOT,
        commandPayload,
        { userId: auth.user?.id }
      );
    } catch (err) {
      console.error('[BMR] Failed to dispatch instant boot command:', err);
      await db.update(restoreJobs).set({
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(restoreJobs.id, restoreJob.id));
      return c.json({ error: 'Failed to dispatch instant boot command to agent' }, 502);
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

// ── GET /backup/restore/as-vm/estimate/:snapshotId — VM estimate ────

vmRestoreRoutes.get('/backup/restore/as-vm/estimate/:snapshotId', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const snapshotId = c.req.param('snapshotId');
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
    recommendedMemoryMb: hw?.totalMemoryMB ?? Math.max(2048, snapshotSizeGB * 2),
    recommendedCpu: hw?.cpuCores ?? 2,
    requiredDiskGb: Math.max(
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
