import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, desc, eq, or } from 'drizzle-orm';
import { createHash } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import { db, withSystemDbAccessContext } from '../../db';
import { isAgentTenantActive } from '../../services/tenantStatus';
import { devices, organizations } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { matchAgentTokenHash } from '../../middleware/agentAuth';
import { writeAuditEvent } from '../../services/auditEvents';
import { CloudflareMtlsService } from '../../services/cloudflareMtls';
import { orgMtlsSettingsSchema, orgHelperSettingsSchema, orgLogForwardingSettingsSchema } from '@breeze/shared';
import { getOrgHelperSettings, issueMtlsCertForDevice, isObject } from './helpers';
import { disconnectAgent } from '../agentWs';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { encryptSecret } from '../../services/secretCrypto';
import { isPrivateIp } from '../../services/urlSafety';
import { terminateDeviceRemoteSessions, TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';

export const mtlsRoutes = new Hono();

const deviceIdParamSchema = z.object({ id: z.string().guid() });
const orgIdParamSchema = z.object({ orgId: z.string().guid() });

// E4: per-device renewal cooldowns (Redis sliding window).
// Short-term: 1 attempt / 30s — prevents agent-restart hammering.
// Long-term:  1 success / 1h — caps Cloudflare issuance even if a token leaks.
const MTLS_RENEW_ATTEMPT_LIMIT = 1;
const MTLS_RENEW_ATTEMPT_WINDOW_SECONDS = 30;
const MTLS_RENEW_SUCCESS_LIMIT = 1;
const MTLS_RENEW_SUCCESS_WINDOW_SECONDS = 3600;
const LOG_FORWARDING_MASK = '****';

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function validateLogForwardingTarget(rawUrl: string | undefined): Promise<string[]> {
  if (!rawUrl) return [];

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return ['Invalid Elasticsearch URL format'];
  }

  if (parsed.protocol !== 'https:') {
    return ['Elasticsearch URL must use HTTPS'];
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return ['Elasticsearch URL hostname is required'];
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return ['Elasticsearch URL cannot target localhost or local network hostnames'];
  }

  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    return isPrivateIp(hostname)
      ? ['Elasticsearch URL cannot target private, loopback, link-local, or reserved addresses']
      : [];
  }

  try {
    const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
    if (resolved.length === 0) {
      return ['Elasticsearch URL hostname could not be resolved'];
    }
    const blockedTargets = resolved
      .map((entry) => entry.address)
      .filter((address) => isPrivateIp(address));
    if (blockedTargets.length > 0) {
      return [`Elasticsearch URL resolves to blocked address space: ${blockedTargets.join(', ')}`];
    }
  } catch {
    return ['Elasticsearch URL hostname could not be resolved'];
  }

  return [];
}

function resolveSecretForStorage(incoming: unknown, existing: unknown): string | undefined {
  if (typeof incoming !== 'string') return undefined;
  const trimmed = incoming.trim();
  if (!trimmed) return undefined;
  if (trimmed === LOG_FORWARDING_MASK) return encryptSecret(toOptionalString(existing)) ?? undefined;
  return encryptSecret(trimmed) ?? undefined;
}

type OrgMtlsPolicy = { certLifetimeDays: number; expiredCertPolicy: 'auto_reissue' | 'quarantine' };

/**
 * Read the org's mTLS policy for the /renew-cert agent path.
 *
 * SECURITY (fail-closed): this route hand-rolls bearer auth and skips
 * agentAuthMiddleware (see AGENT_AUTH_SKIP_ID_SEGMENTS), so it carries NO
 * ambient request DB context. Under FORCE RLS the bare `breeze_app` pool would
 * return 0 rows for a contextless read — silently collapsing an org configured
 * `quarantine` into the `auto_reissue` default and handing a fresh cert+key to
 * a possibly-compromised agent. We therefore read INSIDE
 * `withSystemDbAccessContext` (mirroring the device lookup above) so RLS
 * returns the real row and the true policy is honored.
 *
 * Returns `null` when the org row is genuinely absent. Callers MUST treat null
 * as the most-restrictive path (error / deny) — never fall back to
 * `auto_reissue` on a missing row. (An org that simply has no mTLS settings
 * still yields a row and its real default policy; only a truly missing org row
 * returns null.) The parse mirrors helpers.ts `getOrgMtlsSettings`, inlined
 * here so we can distinguish "no org row" from "org with default settings",
 * which that helper cannot.
 */
async function readOrgMtlsPolicyOrNull(orgId: string): Promise<OrgMtlsPolicy | null> {
  return withSystemDbAccessContext(async () => {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return null;
    const settings = isObject(org.settings) ? org.settings : {};
    const mtls = isObject(settings.mtls) ? settings.mtls : {};
    const certLifetimeDays =
      typeof mtls.certLifetimeDays === 'number' && mtls.certLifetimeDays >= 1 && mtls.certLifetimeDays <= 365
        ? Math.round(mtls.certLifetimeDays)
        : 90;
    const expiredCertPolicy = mtls.expiredCertPolicy === 'quarantine' ? 'quarantine' : 'auto_reissue';
    return { certLifetimeDays, expiredCertPolicy };
  });
}

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
      .select({
        id: devices.id,
        orgId: devices.orgId,
        agentId: devices.agentId,
        hostname: devices.hostname,
        status: devices.status,
        agentTokenHash: devices.agentTokenHash,
        previousTokenHash: devices.previousTokenHash,
        previousTokenExpiresAt: devices.previousTokenExpiresAt,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
        mtlsCertExpiresAt: devices.mtlsCertExpiresAt,
        mtlsCertCfId: devices.mtlsCertCfId,
      })
      .from(devices)
      .where(or(eq(devices.agentTokenHash, tokenHash), eq(devices.previousTokenHash, tokenHash)))
      .limit(1);
    return row ?? null;
  });

  // Issue #2621 — deliberately NOT passing pendingTokenHash here. Staged
  // credentials from an unconfirmed rotation authenticate for ordinary agent
  // traffic, but this route mints fresh cert material and stays fail-closed on
  // the CURRENT token only (same rationale as the superseded-token rejection
  // below). A legitimate agent confirms its rotation on the next request and
  // renews immediately after; the pending set is never the long-term identity.
  const match = device
    ? matchAgentTokenHash({
        agentTokenHash: device.agentTokenHash,
        previousTokenHash: device.previousTokenHash,
        previousTokenExpiresAt: device.previousTokenExpiresAt,
        tokenHash,
      })
    : null;

  if (!device || !match) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  // FINDING #2 (fail-closed): only the CURRENT token may mint new cert material.
  // `matchAgentTokenHash` accepts the PREVIOUS (superseded) token within its
  // rotation grace window — that's correct for idempotent agent traffic
  // (heartbeats/results) but NOT for this cert-issuing route: a stolen,
  // already-rotated token must not be able to obtain a fresh certificate +
  // private key. When the previous hash matched, `match.tokenRotationRequired`
  // is true; reject here (ONLY on this route — the general agent auth path
  // keeps accepting the previous token for grace). The message tells a
  // legitimate agent to finish rotating before renewing.
  if (match.tokenRotationRequired) {
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'previous_token_rejected' },
    });
    return c.json(
      { error: 'Rotate to the current agent token before renewing the certificate' },
      401
    );
  }

  // Task 18: auto-suspended tokens fail closed at every auth gate. The
  // suspended-reason is intentionally not surfaced to the caller.
  if (device.agentTokenSuspendedAt) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  if (device.status === 'decommissioned') {
    return c.json({ error: 'Device has been decommissioned' }, 403);
  }

  if (device.status === 'quarantined') {
    return c.json({ error: 'Device quarantined', quarantined: true }, 403);
  }

  // E4: per-device renewal cooldowns (defense against leaked tokens spamming
  // Cloudflare issuance). Two layers via the existing sliding-window helper.
  const redis = getRedis();
  const attemptResult = await rateLimiter(
    redis,
    `mtls:renew:attempt:${device.id}`,
    MTLS_RENEW_ATTEMPT_LIMIT,
    MTLS_RENEW_ATTEMPT_WINDOW_SECONDS
  );
  if (!attemptResult.allowed) {
    const retryAfter = Math.max(1, Math.ceil((attemptResult.resetAt.getTime() - Date.now()) / 1000));
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'attempt_rate_limited', retryAfter },
    });
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'Renewal attempt rate limited; retry later' }, 429);
  }

  // Long-term cap: peek at the success window without consuming a slot
  // (cost=0 would still record — instead, do a read-only zcard check).
  if (redis) {
    try {
      const successKey = `mtls:renew:success:${device.id}`;
      const cutoff = Date.now() - MTLS_RENEW_SUCCESS_WINDOW_SECONDS * 1000;
      await redis.zremrangebyscore(successKey, '-inf', cutoff);
      const recentSuccessCount = await redis.zcard(successKey);
      if (recentSuccessCount >= MTLS_RENEW_SUCCESS_LIMIT) {
        const oldest = await redis.zrange(successKey, 0, 0, 'WITHSCORES');
        const oldestScore = Array.isArray(oldest) && oldest.length >= 2 ? Number(oldest[1]) : Date.now();
        const retryAfter = Math.max(
          1,
          Math.ceil((oldestScore + MTLS_RENEW_SUCCESS_WINDOW_SECONDS * 1000 - Date.now()) / 1000)
        );
        writeAuditEvent(c, {
          orgId: device.orgId,
          actorType: 'agent',
          actorId: device.agentId,
          action: 'agent.mtls.renew.denied',
          resourceType: 'device',
          resourceId: device.id,
          result: 'denied',
          details: { reason: 'success_rate_limited', retryAfter },
        });
        c.header('Retry-After', String(retryAfter));
        return c.json({ error: 'Renewal success rate limited; retry later' }, 429);
      }
    } catch (err) {
      // Soft-fail on redis errors here — the attempt limiter (above) already
      // failed-closed if redis is fully unavailable; if zcard fails we proceed.
      console.warn('[agents] mTLS success-window check failed:', String(err));
    }
  }

  // Tenant-status gate (F4): this route authenticates the device token by hand
  // and never passes through agentAuthMiddleware, so it missed the org/partner
  // lifecycle check the rest of the agent surface enforces. A device whose
  // tenant is suspended/churned/soft-deleted — but whose token was not
  // individually suspended — could otherwise keep minting fresh Cloudflare mTLS
  // cert + private-key material. Mirror the agentAuth gate: run it after the
  // per-device rate limiters (so an inactive tenant can't drive uncached
  // lookups) and before any Cloudflare issuance, and return the same opaque 401
  // as a stale token so suspension is not distinguishable from a bad credential.
  if (!(await isAgentTenantActive(device.orgId))) {
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'tenant_inactive' },
    });
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) {
    return c.json({ error: 'mTLS not configured' }, 400);
  }

  // FINDING #1 (fail-closed): read the org mTLS policy INSIDE a system DB
  // context. A contextless read here returns 0 rows under FORCE RLS, which
  // would silently downgrade a `quarantine` org to the `auto_reissue` default.
  // A genuinely missing org row (null) is treated as an error — never
  // auto_reissue — so we deny rather than issue a cert against an org we can't
  // resolve a policy for.
  const mtlsSettings = await readOrgMtlsPolicyOrNull(device.orgId);
  if (!mtlsSettings) {
    console.error('[agents] mTLS renew: org policy row not found, failing closed:', device.orgId);
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'org_policy_unavailable' },
    });
    return c.json({ error: 'Certificate renewal unavailable' }, 500);
  }

  const certExpired = device.mtlsCertExpiresAt && device.mtlsCertExpiresAt.getTime() < Date.now();

  if (certExpired && mtlsSettings.expiredCertPolicy === 'quarantine') {
    // FINDING #1: the quarantine write must run in a system DB context and
    // actually affect a row. A contextless / 0-row write under FORCE RLS would
    // "succeed" while leaving the device un-quarantined. Require exactly 1 row;
    // if none, fail closed (500) rather than tearing down / returning as if the
    // device were isolated.
    const quarantined = await withSystemDbAccessContext(async () =>
      db
        .update(devices)
        .set({
          status: 'quarantined',
          quarantinedAt: new Date(),
          quarantinedReason: 'mtls_cert_expired',
          updatedAt: new Date(),
        })
        .where(eq(devices.id, device.id))
        .returning({ id: devices.id })
    );

    if (quarantined.length !== 1) {
      console.error('[agents] mTLS quarantine write affected 0 rows, failing closed:', device.id);
      return c.json({ error: 'Certificate renewal failed' }, 500);
    }

    // Cut any live remote-control session to this device. Flipping `status`
    // alone is only checked at connect time, so an in-flight desktop/terminal
    // session would otherwise keep running against a device we just isolated as
    // compromised. Never throws; a TEARDOWN_FAILED (already Sentry-reported
    // inside the service) is recorded in the audit trail below so there's a
    // forensic record that live control may have persisted.
    const teardownResult = await terminateDeviceRemoteSessions(device.id);

    // FINDING #3: also sever the agent command WebSocket. terminateDeviceRemoteSessions
    // only cuts remote-desktop/terminal sessions; the agent's own command channel
    // would keep draining decrypted commands after quarantine. In-process only
    // (cross-replica broadcast is handled by the agentWs owner). Mirrors the
    // decommission caller in devices/core.ts (code 4041).
    const agentWsDisconnect = disconnectAgent(device.agentId, 4041, 'Device quarantined: mTLS cert expired');

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.quarantined',
      resourceType: 'device',
      resourceId: device.id,
      details: {
        reason: 'mtls_cert_expired',
        remoteSessionTeardown: teardownResult === TEARDOWN_FAILED ? 'failed' : 'ok',
        agentWsDisconnect,
      },
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

  // FINDING #1 (atomicity / fail-closed): do NOT return certificate material
  // until its metadata has provably persisted. The write runs in a system DB
  // context and must affect exactly 1 row; a contextless / 0-row write under
  // FORCE RLS would otherwise "succeed" silently, leaving us handing out an
  // UNTRACKED cert (no serial/expiry/cfId recorded → cannot be revoked or
  // reasoned about later). If persistence fails or affects 0 rows, revoke the
  // just-issued cert (best-effort) and deny the renewal. Better to deny than to
  // leak an untracked cert.
  let persisted: { id: string }[];
  try {
    persisted = await withSystemDbAccessContext(async () =>
      db
        .update(devices)
        .set({
          mtlsCertSerialNumber: cert.serialNumber,
          mtlsCertExpiresAt: new Date(cert.expiresOn),
          mtlsCertIssuedAt: new Date(cert.issuedOn),
          mtlsCertCfId: cert.id,
          updatedAt: new Date(),
        })
        .where(eq(devices.id, device.id))
        .returning({ id: devices.id })
    );
  } catch (dbErr) {
    console.error('[agents] failed to persist renewed mTLS cert metadata to DB:', String(dbErr));
    persisted = [];
  }

  if (persisted.length !== 1) {
    console.error('[agents] mTLS cert metadata write affected 0 rows, revoking untracked cert and failing closed:', device.id);
    try {
      await cfService.revokeCertificate(cert.id);
    } catch (revokeErr) {
      console.error('[agents] failed to revoke untracked mTLS cert after metadata write failure:', String(revokeErr));
    }
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'cert_metadata_persist_failed', serialNumber: cert.serialNumber },
    });
    return c.json({ error: 'Certificate renewal failed' }, 500);
  }

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'agent',
    actorId: device.agentId,
    action: 'agent.mtls.renewed',
    resourceType: 'device',
    resourceId: device.id,
    details: { serialNumber: cert.serialNumber },
  });

  // E4: record successful renewal in the long-term cooldown window.
  if (redis) {
    try {
      const successKey = `mtls:renew:success:${device.id}`;
      const nowTs = Date.now();
      const memberId = `${nowTs}-${Math.random().toString(36).slice(2, 10)}`;
      await redis.zadd(successKey, nowTs, memberId);
      await redis.expire(successKey, MTLS_RENEW_SUCCESS_WINDOW_SECONDS);
    } catch (recordErr) {
      console.warn('[agents] failed to record mTLS success cooldown:', String(recordErr));
    }
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

mtlsRoutes.post('/:id/approve', authMiddleware, requirePermission('devices', 'write'), zValidator('param', deviceIdParamSchema), async (c) => {
  const { id: deviceId } = c.req.valid('param');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      agentId: devices.agentId,
      hostname: devices.hostname,
      status: devices.status,
    })
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

mtlsRoutes.post('/:id/deny', authMiddleware, requirePermission('devices', 'write'), zValidator('param', deviceIdParamSchema), async (c) => {
  const { id: deviceId } = c.req.valid('param');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      agentId: devices.agentId,
      hostname: devices.hostname,
      status: devices.status,
    })
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

  // Tear down any live remote-control session to a device we're decommissioning.
  // Never throws; a TEARDOWN_FAILED is recorded in the audit trail below.
  const teardownResult = await terminateDeviceRemoteSessions(device.id);

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.deny',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
    details: { remoteSessionTeardown: teardownResult === TEARDOWN_FAILED ? 'failed' : 'ok' },
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
  zValidator('param', orgIdParamSchema),
  zValidator('json', orgMtlsSettingsSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
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
  zValidator('param', orgIdParamSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
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
  zValidator('param', orgIdParamSchema),
  zValidator('json', orgHelperSettingsSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
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
  zValidator('param', orgIdParamSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
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
  requireMfa(),
  zValidator('param', orgIdParamSchema),
  zValidator('json', orgLogForwardingSettingsSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
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
      ? resolveSecretForStorage(incoming.elasticsearchApiKey, existingForwarding.elasticsearchApiKey)
      : encryptSecret(toOptionalString(existingForwarding.elasticsearchApiKey)) ?? undefined;
    let resolvedUsername = hasOwn(incoming, 'elasticsearchUsername')
      ? toOptionalString(incoming.elasticsearchUsername)
      : toOptionalString(existingForwarding.elasticsearchUsername);
    let resolvedPassword = hasOwn(incoming, 'elasticsearchPassword')
      ? resolveSecretForStorage(incoming.elasticsearchPassword, existingForwarding.elasticsearchPassword)
      : encryptSecret(toOptionalString(existingForwarding.elasticsearchPassword)) ?? undefined;

    // Explicit auth-method updates should clear stale credentials from the other mode.
    if (providedBasic && !providedApiKey) {
      resolvedApiKey = undefined;
    } else if (providedApiKey && !providedBasic) {
      resolvedUsername = undefined;
      resolvedPassword = undefined;
    }

    if (data.enabled) {
      const targetErrors = await validateLogForwardingTarget(resolvedUrl);
      if (targetErrors.length > 0) {
        return c.json({ error: 'Invalid log forwarding target', details: targetErrors }, 400);
      }
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
