import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '../../db';
import { devices, organizations, sites, partners, provisionCredentialHandles } from '../../db/schema';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { provisionDeviceSchema } from './schemas';
import { generateAgentId, generateApiKey, issueMtlsCertForDevice } from '../agents/helpers';
import { getActiveTrustKeyset } from '../../services/manifestSigning';
import { stripSensitiveDeviceFields } from './helpers';
import {
  PROVISION_HANDLE_TOKEN_PATTERN,
  generateProvisionHandleToken,
  provisionHandleExpiresAt,
} from '../../services/provisionCredentialHandle';

export const provisionRoutes = new Hono();

provisionRoutes.use('*', authMiddleware);

/**
 * POST /devices/provision
 *
 * Admin-side pre-creates a device row + generates an agent config blob so the
 * agent never has to call `POST /agents/enroll`. The admin downloads the
 * returned config, ships it to the endpoint, the agent starts up and
 * heartbeats. Mirrors the ScreenConnect/Action1 "drag-into-folder" model.
 *
 * Pairs with `POST /devices/:id/move-org` (#875) so the workflow becomes:
 *   1. Admin provisions a device into a "Staging" org → ships config.
 *   2. Tech installs, agent starts heartbeating in Staging.
 *   3. Once verified, admin uses move-org to relocate.
 *
 * Auth: scope organization+ (admin must be able to see the target org),
 * DEVICES_WRITE permission, MFA-gated (creates a long-lived credential blob).
 *
 * Hostname collision: hard-fail 409 (admin must DELETE the existing row
 * first). Unlike the agent-driven `/enroll` path which auto-allows on a
 * decommissioned slot (#896), the admin path requires explicit intent — if
 * the admin types a hostname that's already taken, that's almost certainly
 * because they didn't realize a device exists. Failing loudly forces them to
 * investigate.
 *
 * Server URL: pulled from `process.env.PUBLIC_API_URL ?? process.env.API_URL`,
 * matching the established pattern in `enrollmentKeys.ts:949,952` and
 * 7 other call sites. 500 if both are unset (same pattern, same message).
 */
provisionRoutes.post(
  '/provision',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', provisionDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // ----------- auth: caller must be able to see the target org -----------
    // canAccessOrg is always populated by authMiddleware; the prior `typeof
    // === 'function'` guard silently fell open if it were ever missing. We
    // require it to be present and use it directly — fail-closed instead.
    if (!auth.canAccessOrg(data.orgId)) {
      return c.json({ error: 'Caller does not have access to target organization' }, 403);
    }

    // ----------- validate the target site belongs to the target org -----------
    const [targetSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, data.siteId), eq(sites.orgId, data.orgId)))
      .limit(1);

    if (!targetSite) {
      return c.json(
        { error: 'Target site not found or does not belong to the target organization' },
        400,
      );
    }

    // ----------- auth: site-scope gate (app-layer only; RLS does NOT defend it) -----------
    // A site-restricted org user (`permissions.allowedSiteIds`) must not be able
    // to provision a device into a site outside their allowlist. No behavior
    // change for unrestricted callers (allowedSiteIds unset → canAccessSite true).
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, data.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // ----------- server URL for the agent config (canonical pattern) -----------
    const serverUrl = (process.env.PUBLIC_API_URL ?? process.env.API_URL ?? '').trim();
    if (!serverUrl) {
      return c.json({ error: 'Server URL not configured (set PUBLIC_API_URL or API_URL)' }, 500);
    }

    // ----------- hostname collision: hard-fail 409 -----------
    const [existingDevice] = await db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(
        and(
          eq(devices.hostname, data.hostname),
          eq(devices.orgId, data.orgId),
          eq(devices.siteId, data.siteId),
        ),
      )
      .limit(1);

    if (existingDevice) {
      writeRouteAudit(c, {
        orgId: data.orgId,
        action: 'device.provision',
        resourceType: 'device',
        resourceId: existingDevice.id,
        resourceName: data.hostname,
        details: {
          reason: 'hostname_collision',
          siteId: data.siteId,
          existingStatus: existingDevice.status,
          message: 'A device with this hostname already exists in this site. Delete the existing row first.',
        },
        result: 'denied',
      });
      return c.json(
        {
          error: 'A device with this hostname already exists in this site. Delete the existing row first.',
          reason: 'hostname_collision',
        },
        409,
      );
    }

    // ----------- generate credentials -----------
    const agentId = generateAgentId();
    const apiKey = generateApiKey();
    const watchdogApiKey = generateApiKey();
    const helperApiKey = generateApiKey();
    const tokenIssuedAt = new Date();
    // lgtm[js/insufficient-password-hash]
    const tokenHash = createHash('sha256').update(apiKey).digest('hex');
    // lgtm[js/insufficient-password-hash]
    const watchdogTokenHash = createHash('sha256').update(watchdogApiKey).digest('hex');
    // lgtm[js/insufficient-password-hash]
    const helperTokenHash = createHash('sha256').update(helperApiKey).digest('hex');

    // ----------- device limit check + insert (TOCTOU-safe in a transaction) -----------
    let device: typeof devices.$inferSelect | undefined;
    try {
      device = await db.transaction(async (tx) => {
        const [org] = await tx
          .select({ id: organizations.id, partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, data.orgId))
          .limit(1);

        if (!org) {
          throw new Error('Target organization not found');
        }

        // Partner device-limit check (mirrors enrollment.ts:415-449)
        let maxDevices: number | null = null;
        if (org.partnerId) {
          const [partner] = await tx
            .select({ maxDevices: partners.maxDevices })
            .from(partners)
            .where(eq(partners.id, org.partnerId))
            .limit(1);
          maxDevices = partner?.maxDevices ?? null;
        }
        if (maxDevices != null && org.partnerId) {
          const partnerOrgIds = tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.partnerId, org.partnerId));
          const [countResult] = await tx
            .select({ count: sql<number>`count(*)` })
            .from(devices)
            .where(
              and(
                sql`${devices.orgId} IN (${partnerOrgIds})`,
                ne(devices.status, 'decommissioned'),
              ),
            );
          const activeCount = Number(countResult?.count ?? 0);
          if (activeCount >= maxDevices) {
            throw new HttpDeviceLimitError(activeCount, maxDevices);
          }
        }

        const [inserted] = await tx
          .insert(devices)
          .values({
            orgId: data.orgId,
            siteId: data.siteId,
            agentId,
            agentTokenHash: tokenHash,
            watchdogTokenHash,
            helperTokenHash,
            hostname: data.hostname,
            displayName: data.displayName,
            osType: data.osType,
            // Sentinel values for fields the agent will populate on first
            // heartbeat. `'0.0.0'` is semver-safe (localeCompare orders it
            // BELOW any real version, so policyEvaluationService.ts:542
            // compliance checks correctly fail rather than silently pass —
            // unlike `'pending'` which would compare as >= "10"). Future
            // direction is to make these columns nullable in a follow-up PR
            // that also widens the ~5 downstream type consumers
            // (policyEvaluationService, securityPosture, helper, etc.).
            osVersion: '0.0.0',
            architecture: 'unknown',
            agentVersion: '0.0.0',
            tokenIssuedAt,
            watchdogTokenIssuedAt: tokenIssuedAt,
            helperTokenIssuedAt: tokenIssuedAt,
            deviceRole: 'unknown',
            deviceRoleSource: 'auto',
            status: 'pending',
            tags: [],
          })
          .returning();

        if (!inserted) {
          throw new Error('Failed to insert provisioned device');
        }
        return inserted;
      });
    } catch (err) {
      if (err instanceof HttpDeviceLimitError) {
        return c.json(
          {
            error: 'Device limit reached',
            code: 'DEVICE_LIMIT_REACHED',
            currentDevices: err.current,
            maxDevices: err.max,
          },
          403,
        );
      }
      console.error('[devices.provision] insert failed:', err);
      return c.json({ error: 'Failed to provision device' }, 500);
    }

    // ----------- mTLS cert + manifest trust keys for the config blob -----------
    const mtlsCert = await issueMtlsCertForDevice(device.id, data.orgId);
    const manifestTrustKeys = await getActiveTrustKeyset();

    // ----------- assemble the config blob (contains long-lived secrets) -----------
    // SECURITY (#917 L-3): the secrets below — auth_token, watchdog/helper
    // tokens and the mTLS private key — are long-lived and MUST NOT be
    // returned inline in this response. If the admin UI logged or persisted
    // the body before transport, those secrets would sit in plaintext. We
    // stash the blob server-side keyed by a short-TTL, single-use handle and
    // return a one-time fetch URL instead.
    const configBlob = {
      agent_id: agentId,
      server_url: serverUrl,
      auth_token: apiKey,
      watchdog_auth_token: watchdogApiKey,
      helper_auth_token: helperApiKey,
      org_id: data.orgId,
      site_id: data.siteId,
      heartbeat_interval_seconds: 60,
      metrics_interval_seconds: 30,
      manifest_trust_keys: manifestTrustKeys,
      mtls: mtlsCert
        ? {
            certificate: mtlsCert.certificate,
            private_key: mtlsCert.privateKey,
            expires_at: mtlsCert.expiresAt,
            serial_number: mtlsCert.serialNumber,
          }
        : null,
    };

    const handleToken = generateProvisionHandleToken();
    const handleExpiresAt = provisionHandleExpiresAt();
    try {
      await db.insert(provisionCredentialHandles).values({
        token: handleToken,
        orgId: data.orgId,
        deviceId: device.id,
        credentials: configBlob,
        createdBy: auth.user?.id ?? null,
        expiresAt: handleExpiresAt,
      });
    } catch (err) {
      console.error('[devices.provision] failed to persist credential handle:', err);
      return c.json({ error: 'Failed to issue provisioning credentials' }, 500);
    }

    writeRouteAudit(c, {
      orgId: data.orgId,
      action: 'device.provision',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: data.hostname,
      details: {
        siteId: data.siteId,
        osType: data.osType,
        agentId,
        mtlsCertIssued: mtlsCert !== null,
        credentialHandleIssued: true,
      },
    });

    // ----------- response: one-time fetch URL (NO inline secrets) -----------
    return c.json(
      {
        success: true,
        device: stripSensitiveDeviceFields(device),
        credentials: {
          fetch_url: `/api/v1/devices/provision/fetch/${handleToken}`,
          fetch_token: handleToken,
          expires_at: handleExpiresAt.toISOString(),
          single_use: true,
        },
      },
      201,
    );
  },
);

/**
 * GET /devices/provision/fetch/:token
 *
 * One-time retrieval of the provisioning credential blob created by
 * POST /devices/provision (#917 L-3). The handle token is the bearer
 * credential; the caller must additionally be an authenticated admin with
 * access to the owning org (defense-in-depth on top of the unguessable
 * token). The handle is single-use: the first successful fetch returns the
 * blob and atomically deletes the row, so a replay 404s. Expired handles
 * are rejected with 410.
 *
 * Invalid / consumed / non-existent tokens all return 404 to avoid leaking
 * which condition was hit. The same caller fetches immediately after
 * provisioning, so the 5-minute default TTL is generous.
 */
provisionRoutes.get('/provision/fetch/:token', async (c) => {
  const auth = c.get('auth');
  const token = c.req.param('token');

  if (!PROVISION_HANDLE_TOKEN_PATTERN.test(token)) {
    return c.json({ error: 'invalid token' }, 400);
  }

  const ip = c.req.header('cf-connecting-ip') ?? null;

  // ── 1. Look up the handle ───────────────────────────────────────────────
  const [row] = await db
    .select()
    .from(provisionCredentialHandles)
    .where(eq(provisionCredentialHandles.token, token))
    .limit(1);

  if (!row) {
    return c.json({ error: 'handle invalid, expired, or already used' }, 404);
  }

  // ── 2. Org-access check (defense-in-depth on top of the token) ──────────
  if (!auth.canAccessOrg(row.orgId)) {
    return c.json({ error: 'handle invalid, expired, or already used' }, 404);
  }

  // ── 3. Expiry ───────────────────────────────────────────────────────────
  if (new Date(row.expiresAt) < new Date()) {
    // Best-effort cleanup of the expired row; ignore failures.
    await db
      .delete(provisionCredentialHandles)
      .where(eq(provisionCredentialHandles.id, row.id))
      .catch(() => {});
    return c.json({ error: 'handle expired' }, 410);
  }

  // ── 4. Atomic single-use consume ────────────────────────────────────────
  // Mark consumed only if not already consumed; the UPDATE serializes
  // concurrent fetches so exactly one wins.
  const [consumed] = await db
    .update(provisionCredentialHandles)
    .set({ consumedAt: new Date(), consumedFromIp: ip })
    .where(
      and(
        eq(provisionCredentialHandles.id, row.id),
        isNull(provisionCredentialHandles.consumedAt),
      ),
    )
    .returning();

  if (!consumed) {
    // Lost the race — another fetch already consumed it.
    return c.json({ error: 'handle invalid, expired, or already used' }, 404);
  }

  // ── 5. Hard-delete so plaintext secrets don't linger at rest ────────────
  await db
    .delete(provisionCredentialHandles)
    .where(eq(provisionCredentialHandles.id, row.id))
    .catch(() => {});

  writeRouteAudit(c, {
    orgId: row.orgId,
    action: 'device.provision.fetch',
    resourceType: 'device',
    resourceId: row.deviceId,
    details: { credentialHandleConsumed: true },
  });

  return c.json({ success: true, config: row.credentials }, 200);
});

class HttpDeviceLimitError extends Error {
  constructor(public current: number, public max: number) {
    super('device limit reached');
  }
}
