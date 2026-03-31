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
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { recoveryTokens } from '../../db/schema/recoveryTokens';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import {
  bmrCreateTokenSchema,
  bmrAuthenticateSchema,
  bmrCompleteSchema,
} from './schemas';

export const bmrRoutes = new Hono();

// Public routes that bypass JWT auth — recovery agents authenticate via token.
export const bmrPublicRoutes = new Hono();

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
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
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

bmrRoutes.get('/bmr/token/:id', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const tokenId = c.req.param('id')!;
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

bmrRoutes.delete(
  '/bmr/token/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const tokenId = c.req.param('id')!;
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
// Mounted on bmrPublicRoutes (no JWT auth — token-based auth instead).

bmrPublicRoutes.post(
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
// Mounted on bmrPublicRoutes (no JWT auth — token-based auth instead).

bmrPublicRoutes.post(
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

// VM restore + instant boot + estimate routes are in vmrestore.ts
