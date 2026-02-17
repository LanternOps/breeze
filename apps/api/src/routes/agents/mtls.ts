import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, organizations } from '../../db/schema';
import { authMiddleware, requirePermission } from '../../middleware/auth';
import { writeAuditEvent } from '../../services/auditEvents';
import { CloudflareMtlsService } from '../../services/cloudflareMtls';
import { orgMtlsSettingsSchema } from '@breeze/shared';
import { isObject, getOrgMtlsSettings } from './helpers';

export const mtlsRoutes = new Hono();

// POST /api/v1/agents/renew-cert
// Excluded from mTLS at WAF level (same as /enroll).
// Does inline bearer token validation (not middleware) so agents with expired certs can call it.
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

// PATCH /api/v1/agents/org/:orgId/settings/mtls — update mTLS settings for an org
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
