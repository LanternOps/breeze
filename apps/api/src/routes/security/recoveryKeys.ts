import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { db } from '../../db';
import { devices, deviceRecoveryKeys, recoveryKeyAccessEvents } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import { decryptForColumn } from '../../services/secretCrypto';
import { writeRouteAudit } from '../../services/auditEvents';
import { CommandTypes, queueCommand } from '../../services/commandQueue';
import { encryptSensitivePayloadFields } from '../../services/sensitiveCommandPayload';
import { deviceIdParamSchema, recoveryKeyRevealParamSchema, rotateRecoveryKeySchema } from './schemas';

/**
 * Site-scope gate: partner-scope users restricted via `allowedSiteIds` must
 * not see/touch a device in a site they cannot access. RLS does not defend
 * the site axis — mirrors security/scans.ts (PR #864/#868).
 */
async function canAccessDeviceSite(
  c: Context,
  auth: Pick<AuthContext, 'user' | 'partnerId' | 'orgId'>,
  deviceSiteId: string | null,
): Promise<boolean> {
  let userPerms = c.get('permissions') as UserPermissions | undefined;
  if (!userPerms) {
    const fetched = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined,
    });
    userPerms = fetched || undefined;
  }
  if (!userPerms?.allowedSiteIds) return true;
  if (typeof deviceSiteId !== 'string') return false;
  return canAccessSite(userPerms, deviceSiteId);
}

async function loadAccessibleDevice(c: Context, deviceId: string) {
  const auth = c.get('auth');
  const orgCondition = auth.orgCondition(devices.orgId);
  const conditions = [eq(devices.id, deviceId)];
  if (orgCondition) conditions.push(orgCondition);
  const [device] = await db
    .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId, siteId: devices.siteId, osType: devices.osType })
    .from(devices)
    .where(and(...conditions))
    .limit(1);
  if (!device) return { device: null as null, denied: c.json({ error: 'Device not found' }, 404) };
  if (!(await canAccessDeviceSite(c, auth, device.siteId))) {
    return { device: null as null, denied: c.json({ error: 'Access to this site denied' }, 403) };
  }
  return { device, denied: null as null };
}

export const recoveryKeysRoutes = new Hono();

// Key metadata + reveal ledger. NEVER returns key material.
recoveryKeysRoutes.get(
  '/encryption/devices/:deviceId/recovery-keys',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const keys = await db
      .select({
        id: deviceRecoveryKeys.id,
        keyType: deviceRecoveryKeys.keyType,
        volumeMount: deviceRecoveryKeys.volumeMount,
        protectorId: deviceRecoveryKeys.protectorId,
        status: deviceRecoveryKeys.status,
        escrowedAt: deviceRecoveryKeys.escrowedAt,
        supersededAt: deviceRecoveryKeys.supersededAt,
      })
      .from(deviceRecoveryKeys)
      .where(eq(deviceRecoveryKeys.deviceId, deviceId))
      .orderBy(desc(deviceRecoveryKeys.escrowedAt))
      .limit(50);

    const keyIds = keys.map((k) => k.id);
    const accessHistory = keyIds.length
      ? await db
          .select({
            id: recoveryKeyAccessEvents.id,
            keyId: recoveryKeyAccessEvents.keyId,
            userEmail: recoveryKeyAccessEvents.userEmail,
            action: recoveryKeyAccessEvents.action,
            createdAt: recoveryKeyAccessEvents.createdAt,
          })
          .from(recoveryKeyAccessEvents)
          .where(inArray(recoveryKeyAccessEvents.keyId, keyIds))
          .orderBy(desc(recoveryKeyAccessEvents.createdAt))
          .limit(25)
      : [];

    return c.json({
      data: {
        device: { id: device.id, hostname: device.hostname, os: device.osType },
        keys,
        accessHistory,
      },
    });
  }
);

// Audited fetch-on-demand reveal: ledger row + route audit; plaintext returned once.
recoveryKeysRoutes.post(
  '/encryption/devices/:deviceId/recovery-keys/:keyId/reveal',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', recoveryKeyRevealParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId, keyId } = c.req.valid('param');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const [key] = await db
      .select()
      .from(deviceRecoveryKeys)
      .where(and(eq(deviceRecoveryKeys.id, keyId), eq(deviceRecoveryKeys.deviceId, deviceId)))
      .limit(1);
    if (!key) return c.json({ error: 'Recovery key not found' }, 404);

    let plaintext: string | null;
    try {
      plaintext = decryptForColumn('device_recovery_keys', 'encrypted_key', key.encryptedKey);
    } catch (err) {
      console.error('[security] recovery key decrypt failed:', { keyId, error: err });
      return c.json({ error: 'Failed to decrypt recovery key — check APP_ENCRYPTION_KEY configuration' }, 500);
    }
    if (!plaintext) return c.json({ error: 'Recovery key material is empty' }, 500);

    await db.insert(recoveryKeyAccessEvents).values({
      keyId: key.id,
      deviceId,
      orgId: key.orgId,
      userId: auth.user.id,
      userEmail: auth.user.email ?? '',
      action: 'revealed',
    });

    // Audit records who/when/which key — NEVER the key itself.
    writeRouteAudit(c, {
      orgId: key.orgId,
      action: 'device.recovery_key.reveal',
      resourceType: 'device',
      resourceId: deviceId,
      details: { keyId: key.id, keyType: key.keyType, volumeMount: key.volumeMount, keyStatus: key.status },
    });

    return c.json({
      data: { id: key.id, keyType: key.keyType, volumeMount: key.volumeMount, status: key.status, recoveryKey: plaintext },
    });
  }
);

// Rotate: Windows needs nothing (defaults volumeMount C:); macOS needs a
// FileVault user's credentials or the current recovery key (encrypted into
// the command payload; see sensitiveCommandPayload.ts).
recoveryKeysRoutes.post(
  '/encryption/devices/:deviceId/recovery-keys/rotate',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', rotateRecoveryKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const os = (device.osType ?? '').toLowerCase();
    let payload: Record<string, unknown>;
    if (os === 'windows') {
      payload = { volumeMount: body.volumeMount ?? 'C:' };
    } else if (os === 'macos' || os === 'darwin') {
      const hasCreds = (body.username && body.password) || body.currentRecoveryKey;
      if (!hasCreds) {
        return c.json({ error: "FileVault rotation requires a FileVault-enabled user's username and password, or the current recovery key" }, 400);
      }
      const raw: Record<string, unknown> = {};
      if (body.username) raw.username = body.username;
      if (body.password) raw.password = body.password;
      if (body.currentRecoveryKey) raw.currentRecoveryKey = body.currentRecoveryKey;
      payload = encryptSensitivePayloadFields(CommandTypes.ENCRYPTION_ROTATE_KEY, raw);
    } else {
      return c.json({ error: `Recovery key rotation is not supported on ${device.osType}` }, 400);
    }

    const command = await queueCommand(device.id, CommandTypes.ENCRYPTION_ROTATE_KEY, payload, auth.user.id);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.recovery_key.rotate',
      resourceType: 'device',
      resourceId: deviceId,
      details: { os, volumeMount: os === 'windows' ? (body.volumeMount ?? 'C:') : null },
    });

    return c.json({ data: { commandId: command.id, status: 'queued' } }, 202);
  }
);

// On-demand re-collect (Windows snapshot refresh).
recoveryKeysRoutes.post(
  '/encryption/devices/:deviceId/recovery-keys/collect',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const command = await queueCommand(device.id, CommandTypes.ENCRYPTION_COLLECT_KEYS, {}, auth.user.id);
    return c.json({ data: { commandId: command.id, status: 'queued' } }, 202);
  }
);
