import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { db } from '../../db';
import {
  backupSnapshots,
  restoreJobs,
  devices,
} from '../../db/schema';
import { recoveryTokens } from '../../db/schema/recoveryTokens';
import { writeRouteAudit } from '../../services/auditEvents';
import { queueCommandForExecution, CommandTypes } from '../../services/commandQueue';
import { resolveScopedOrgId } from './helpers';
import {
  bmrCreateTokenSchema,
  bmrAuthenticateSchema,
  bmrCompleteSchema,
  bmrVmRestoreSchema,
} from './schemas';

export const bmrRoutes = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return `brz_rec_${randomBytes(32).toString('hex')}`;
}

// ── POST /bmr/token — Generate recovery token ──────────────────────

bmrRoutes.post(
  '/bmr/token',
  zValidator('json', bmrCreateTokenSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    // Verify snapshot exists and belongs to this org.
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

    const plainToken = generateToken();
    const tokenHash = hashToken(plainToken);
    const expiresAt = new Date(
      Date.now() + payload.expiresInHours * 60 * 60 * 1000
    );

    const [row] = await db
      .insert(recoveryTokens)
      .values({
        orgId,
        deviceId: snapshot.deviceId,
        snapshotId: snapshot.id,
        tokenHash,
        restoreType: payload.restoreType,
        targetConfig: payload.targetConfig ?? null,
        status: 'active',
        createdBy: auth.user?.id ?? null,
        expiresAt,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create recovery token' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.token.create',
      resourceType: 'recovery_token',
      resourceId: row.id,
      details: {
        snapshotId: snapshot.id,
        deviceId: snapshot.deviceId,
        restoreType: payload.restoreType,
      },
    });

    return c.json(
      {
        id: row.id,
        token: plainToken, // Only time the plaintext token is shown
        deviceId: row.deviceId,
        snapshotId: row.snapshotId,
        restoreType: row.restoreType,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      },
      201
    );
  }
);

// ── GET /bmr/token/:id — Get token metadata ────────────────────────

bmrRoutes.get('/bmr/token/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const tokenId = c.req.param('id');
  const [row] = await db
    .select({
      id: recoveryTokens.id,
      deviceId: recoveryTokens.deviceId,
      snapshotId: recoveryTokens.snapshotId,
      restoreType: recoveryTokens.restoreType,
      status: recoveryTokens.status,
      createdAt: recoveryTokens.createdAt,
      expiresAt: recoveryTokens.expiresAt,
      usedAt: recoveryTokens.usedAt,
    })
    .from(recoveryTokens)
    .where(
      and(eq(recoveryTokens.id, tokenId), eq(recoveryTokens.orgId, orgId))
    )
    .limit(1);

  if (!row) {
    return c.json({ error: 'Recovery token not found' }, 404);
  }

  return c.json({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
  });
});

// ── DELETE /bmr/token/:id — Revoke token ────────────────────────────

bmrRoutes.delete('/bmr/token/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const tokenId = c.req.param('id');
  const [row] = await db
    .update(recoveryTokens)
    .set({ status: 'revoked' })
    .where(
      and(eq(recoveryTokens.id, tokenId), eq(recoveryTokens.orgId, orgId))
    )
    .returning({ id: recoveryTokens.id });

  if (!row) {
    return c.json({ error: 'Recovery token not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'bmr.token.revoke',
    resourceType: 'recovery_token',
    resourceId: row.id,
  });

  return c.json({ id: row.id, status: 'revoked' });
});

// ── POST /bmr/recover/authenticate — Recovery agent auth ────────────

bmrRoutes.post(
  '/bmr/recover/authenticate',
  zValidator('json', bmrAuthenticateSchema),
  async (c) => {
    const { token } = c.req.valid('json');
    const tokenHash = hashToken(token);

    const [row] = await db
      .select()
      .from(recoveryTokens)
      .where(eq(recoveryTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      return c.json({ error: 'Invalid recovery token' }, 401);
    }

    if (row.status !== 'active') {
      return c.json({ error: `Token is ${row.status}` }, 401);
    }

    if (row.expiresAt < new Date()) {
      await db
        .update(recoveryTokens)
        .set({ status: 'expired' })
        .where(eq(recoveryTokens.id, row.id));
      return c.json({ error: 'Token has expired' }, 401);
    }

    // Fetch snapshot and device info for the recovery agent.
    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(eq(backupSnapshots.id, row.snapshotId))
      .limit(1);

    const [device] = await db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        osType: devices.osType,
      })
      .from(devices)
      .where(eq(devices.id, row.deviceId))
      .limit(1);

    // Mark token as used.
    await db
      .update(recoveryTokens)
      .set({ status: 'used', usedAt: new Date() })
      .where(eq(recoveryTokens.id, row.id));

    return c.json({
      tokenId: row.id,
      deviceId: row.deviceId,
      snapshotId: row.snapshotId,
      restoreType: row.restoreType,
      targetConfig: row.targetConfig,
      device: device
        ? {
            id: device.id,
            hostname: device.hostname,
            osType: device.osType,
          }
        : null,
      snapshot: snapshot
        ? {
            id: snapshot.id,
            snapshotId: snapshot.snapshotId,
            size: snapshot.size,
            fileCount: snapshot.fileCount,
            hardwareProfile: snapshot.hardwareProfile,
            systemStateManifest: snapshot.systemStateManifest,
          }
        : null,
    });
  }
);

// ── POST /bmr/recover/complete — Agent reports recovery done ────────

bmrRoutes.post(
  '/bmr/recover/complete',
  zValidator('json', bmrCompleteSchema),
  async (c) => {
    const { token, result } = c.req.valid('json');
    const tokenHash = hashToken(token);

    const [row] = await db
      .select()
      .from(recoveryTokens)
      .where(eq(recoveryTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      return c.json({ error: 'Invalid recovery token' }, 401);
    }

    // Create a restore job record for the completed recovery.
    const restoreStatus =
      result.status === 'completed'
        ? 'completed'
        : result.status === 'partial'
          ? 'partial'
          : 'failed';

    const [restoreJob] = await db
      .insert(restoreJobs)
      .values({
        orgId: row.orgId,
        snapshotId: row.snapshotId,
        deviceId: row.deviceId,
        restoreType: 'bare_metal',
        status: restoreStatus,
        targetConfig: row.targetConfig,
        recoveryTokenId: row.id,
        restoredSize: result.bytesRestored ?? null,
        restoredFiles: result.filesRestored ?? null,
        startedAt: row.usedAt ?? row.createdAt,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return c.json({
      restoreJobId: restoreJob?.id ?? null,
      status: restoreStatus,
    });
  }
);

// ── POST /backup/restore/as-vm — Trigger VM restore ────────────────

bmrRoutes.post(
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

// ── GET /backup/restore/as-vm/estimate/:snapshotId — VM estimate ────

bmrRoutes.get('/backup/restore/as-vm/estimate/:snapshotId', async (c) => {
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
