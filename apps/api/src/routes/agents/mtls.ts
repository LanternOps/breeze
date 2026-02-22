import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, organizations } from '../../db/schema';
import { authMiddleware, requirePermission } from '../../middleware/auth';
import { writeAuditEvent } from '../../services/auditEvents';
import { CloudflareMtlsService } from '../../services/cloudflareMtls';
import { orgMtlsSettingsSchema, orgHelperSettingsSchema, orgLogForwardingSettingsSchema } from '@breeze/shared';
import { getOrgMtlsSettings, getOrgHelperSettings, issueMtlsCertForDevice, isObject } from './helpers';

export const mtlsRoutes = new Hono();

// ============================================
// mTLS Certificate Renewal
// ============================================

mtlsRoutes.post('/renew-cert', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (!token.startsWith('brz_')) {
    return c.json({ error: 'Invalid agent token format' }, 401);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(devices)
      .where(eq(devices.agentTokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  });

  if (!device) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  if (device.status === 'decommissioned') {
    return c.json({ error: 'Device has been decommissioned' }, 403);
  }

  if (device.status === 'quarantined') {
    return c.json({ error: 'Device quarantined', quarantined: true }, 403);
  }

  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) {
    return c.json({ error: 'mTLS not configured' }, 400);
  }

  const mtlsSettings = await getOrgMtlsSettings(device.orgId);

  const certExpired = device.mtlsCertExpiresAt && device.mtlsCertExpiresAt.getTime() < Date.now();

  if (certExpired && mtlsSettings.expiredCertPolicy === 'quarantine') {
    await db
      .update(devices)
      .set({
        status: 'quarantined',
        quarantinedAt: new Date(),
        quarantinedReason: 'mtls_cert_expired',
        updatedAt: new Date(),
      })
      .where(eq(devices.id, device.id));

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.quarantined',
      resourceType: 'device',
      resourceId: device.id,
      details: { reason: 'mtls_cert_expired' },
    });

    return c.json({ error: 'Device quarantined', quarantined: true }, 403);
  }

  // Revoke old cert (best-effort)
  if (device.mtlsCertCfId) {
    try {
      await cfService.revokeCertificate(device.mtlsCertCfId);
    } catch (err) {
      console.warn('[agents] failed to revoke old mTLS cert, proceeding with renewal:', String(err));
    }
  }

  let cert;
  try {
    cert = await cfService.issueCertificate(mtlsSettings.certLifetimeDays);
  } catch (err) {
    console.error('[agents] mTLS cert issuance failed:', String(err));
    const message = err instanceof Error && err.message.includes('rate limit')
      ? 'Certificate renewal failed: rate limited, retry later'
      : 'Certificate renewal failed';
    return c.json({ error: message }, 500);
  }

  try {
    await db
      .update(devices)
      .set({
        mtlsCertSerialNumber: cert.serialNumber,
        mtlsCertExpiresAt: new Date(cert.expiresOn),
        mtlsCertIssuedAt: new Date(cert.issuedOn),
        mtlsCertCfId: cert.id,
        updatedAt: new Date(),
      })
      .where(eq(devices.id, device.id));

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renewed',
      resourceType: 'device',
      resourceId: device.id,
      details: { serialNumber: cert.serialNumber },
    });
  } catch (dbErr) {
    console.error('[agents] failed to persist renewed mTLS cert metadata to DB:', String(dbErr));
  }

  return c.json({
    mtls: {
      certificate: cert.certificate,
      privateKey: cert.privateKey,
      expiresAt: cert.expiresOn,
      serialNumber: cert.serialNumber,
    }
  });
});

// ============================================
// Admin Quarantine Management (user JWT auth)
// ============================================

mtlsRoutes.get('/quarantined', authMiddleware, requirePermission('devices', 'read'), async (c) => {
  const auth = c.get('auth') as { orgId?: string; orgCondition?: (col: any) => any };

  const rows = await db
    .select({
      id: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      osType: devices.osType,
      quarantinedAt: devices.quarantinedAt,
      quarantinedReason: devices.quarantinedReason,
    })
    .from(devices)
    .where(
      and(
        eq(devices.status, 'quarantined'),
        auth.orgCondition ? auth.orgCondition(devices.orgId) : undefined
      )
    )
    .orderBy(desc(devices.quarantinedAt))
    .limit(100);

  return c.json({ devices: rows });
});

mtlsRoutes.post('/:id/approve', authMiddleware, requirePermission('devices', 'write'), async (c) => {
  const deviceId = c.req.param('id');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  const mtlsCert = await issueMtlsCertForDevice(device.id, device.orgId);

  await db
    .update(devices)
    .set({
      status: 'online',
      quarantinedAt: null,
      quarantinedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.approve',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
    details: { mtlsCertIssued: mtlsCert !== null },
  });

  return c.json({
    success: true,
    mtls: mtlsCert,
  });
});

mtlsRoutes.post('/:id/deny', authMiddleware, requirePermission('devices', 'write'), async (c) => {
  const deviceId = c.req.param('id');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  await db
    .update(devices)
    .set({
      status: 'decommissioned',
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.deny',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
  });

  return c.json({ success: true });
});

// ============================================
// Org mTLS Settings (user JWT auth)
// ============================================

mtlsRoutes.patch(
  '/org/:orgId/settings/mtls',
  authMiddleware,
  requirePermission('orgs', 'write'),
  zValidator('json', orgMtlsSettingsSchema),
  async (c) => {
    const orgId = c.req.param('orgId');
    const data = c.req.valid('json');
    const auth = c.get('auth') as { user?: { id: string }; canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const currentSettings = isObject(org.settings) ? org.settings : {};
    const updatedSettings = {
      ...currentSettings,
      mtls: {
        certLifetimeDays: data.certLifetimeDays,
        expiredCertPolicy: data.expiredCertPolicy,
      },
    };

    await db
      .update(organizations)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));

    writeAuditEvent(c, {
      orgId,
      actorType: 'user',
      actorId: auth.user?.id ?? 'unknown',
      action: 'admin.org.mtls_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: data,
    });

    return c.json({ success: true, settings: updatedSettings.mtls });
  }
);

// ============================================
// Org Helper Settings (user JWT auth)
// ============================================

mtlsRoutes.get(
  '/org/:orgId/settings/helper',
  authMiddleware,
  requirePermission('orgs', 'read'),
  async (c) => {
    const orgId = c.req.param('orgId');
    const auth = c.get('auth') as { canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const helperSettings = await getOrgHelperSettings(orgId);
    return c.json(helperSettings);
  }
);

mtlsRoutes.patch(
  '/org/:orgId/settings/helper',
  authMiddleware,
  requirePermission('orgs', 'write'),
  zValidator('json', orgHelperSettingsSchema),
  async (c) => {
    const orgId = c.req.param('orgId');
    const data = c.req.valid('json');
    const auth = c.get('auth') as { user?: { id: string }; canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const currentSettings = isObject(org.settings) ? org.settings : {};
    const updatedSettings = {
      ...currentSettings,
      helper: {
        enabled: data.enabled,
      },
    };

    await db
      .update(organizations)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));

    writeAuditEvent(c, {
      orgId,
      actorType: 'user',
      actorId: auth.user?.id ?? 'unknown',
      action: 'admin.org.helper_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: data,
    });

    return c.json({ success: true, settings: updatedSettings.helper });
  }
);

// ============================================
// Org Log Forwarding Settings (user JWT auth)
// ============================================

mtlsRoutes.get(
  '/org/:orgId/settings/log-forwarding',
  authMiddleware,
  requirePermission('orgs', 'read'),
  async (c) => {
    const orgId = c.req.param('orgId');
    const auth = c.get('auth') as { canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const settings = isObject(org.settings) ? org.settings : {};
    const forwarding = (isObject(settings.logForwarding) ? settings.logForwarding : { enabled: false }) as Record<string, unknown>;
    const safe = {
      ...forwarding,
      elasticsearchApiKey: forwarding.elasticsearchApiKey ? '****' : undefined,
      elasticsearchPassword: forwarding.elasticsearchPassword ? '****' : undefined,
    };

    return c.json({ settings: { logForwarding: safe } });
  }
);

mtlsRoutes.patch(
  '/org/:orgId/settings/log-forwarding',
  authMiddleware,
  requirePermission('orgs', 'write'),
  zValidator('json', orgLogForwardingSettingsSchema),
  async (c) => {
    const orgId = c.req.param('orgId');
    const data = c.req.valid('json');
    const auth = c.get('auth') as { user?: { id: string }; canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const currentSettings = isObject(org.settings) ? org.settings : {};
    const existingForwarding = isObject(currentSettings.logForwarding)
      ? (currentSettings.logForwarding as Record<string, unknown>)
      : {};
    const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
      Object.prototype.hasOwnProperty.call(obj, key);
    const toOptionalString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    const resolveSecret = (incoming: unknown, existing: unknown): string | undefined => {
      if (typeof incoming !== 'string') return undefined;
      const trimmed = incoming.trim();
      if (!trimmed) return undefined;
      if (trimmed === '****') return toOptionalString(existing);
      return trimmed;
    };

    const incoming = data as Record<string, unknown>;
    const providedApiKey = hasOwn(incoming, 'elasticsearchApiKey');
    const providedBasic =
      hasOwn(incoming, 'elasticsearchUsername') || hasOwn(incoming, 'elasticsearchPassword');

    const resolvedUrl = hasOwn(incoming, 'elasticsearchUrl')
      ? toOptionalString(incoming.elasticsearchUrl)
      : toOptionalString(existingForwarding.elasticsearchUrl);
    const resolvedIndexPrefix = hasOwn(incoming, 'indexPrefix')
      ? toOptionalString(incoming.indexPrefix)
      : toOptionalString(existingForwarding.indexPrefix);
    let resolvedApiKey = hasOwn(incoming, 'elasticsearchApiKey')
      ? resolveSecret(incoming.elasticsearchApiKey, existingForwarding.elasticsearchApiKey)
      : toOptionalString(existingForwarding.elasticsearchApiKey);
    let resolvedUsername = hasOwn(incoming, 'elasticsearchUsername')
      ? toOptionalString(incoming.elasticsearchUsername)
      : toOptionalString(existingForwarding.elasticsearchUsername);
    let resolvedPassword = hasOwn(incoming, 'elasticsearchPassword')
      ? resolveSecret(incoming.elasticsearchPassword, existingForwarding.elasticsearchPassword)
      : toOptionalString(existingForwarding.elasticsearchPassword);

    // Explicit auth-method updates should clear stale credentials from the other mode.
    if (providedBasic && !providedApiKey) {
      resolvedApiKey = undefined;
    } else if (providedApiKey && !providedBasic) {
      resolvedUsername = undefined;
      resolvedPassword = undefined;
    }

    const normalizedForwarding: Record<string, unknown> = {
      enabled: data.enabled,
      indexPrefix: resolvedIndexPrefix ?? 'breeze-logs',
    };
    if (resolvedUrl) normalizedForwarding.elasticsearchUrl = resolvedUrl;
    if (resolvedApiKey) normalizedForwarding.elasticsearchApiKey = resolvedApiKey;
    if (resolvedUsername) normalizedForwarding.elasticsearchUsername = resolvedUsername;
    if (resolvedPassword) normalizedForwarding.elasticsearchPassword = resolvedPassword;

    const updatedSettings = {
      ...currentSettings,
      logForwarding: normalizedForwarding,
    };

    await db
      .update(organizations)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));

    const { elasticsearchApiKey, elasticsearchPassword, ...safeData } = normalizedForwarding;
    const maskedDetails = {
      ...safeData,
      elasticsearchApiKey: elasticsearchApiKey ? '****' : undefined,
      elasticsearchPassword: elasticsearchPassword ? '****' : undefined,
    };

    writeAuditEvent(c, {
      orgId,
      actorType: 'user',
      actorId: auth.user?.id ?? 'unknown',
      action: 'admin.org.log_forwarding_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: maskedDetails,
    });

    return c.json({ success: true, settings: { logForwarding: maskedDetails } });
  }
);
