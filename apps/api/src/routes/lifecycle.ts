import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gt, inArray, isNull, max, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  mobileDevices,
  oauthClients,
  oauthClientBlocks,
  oauthGrants,
  oauthRefreshTokens,
  organizationUsers,
  organizations,
  partnerUsers,
} from '../db/schema';
import { approvalRequests } from '../db/schema/approvals';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { rateLimiter, getRedis } from '../services';
import { writeRouteAudit } from '../services/auditEvents';
import { revokeGrant, revokeJti } from '../oauth/revocationCache';
import { ERROR_IDS, logOauthError } from '../oauth/log';
import { ACCESS_TOKEN_TTL_SECONDS } from '../oauth/provider';
import { resolveUserAuditOrgId } from './auth/helpers';
import { PERMISSIONS } from '../services/permissions';

/**
 * Device + OAuth client lifecycle management.
 *
 *   - GET    /me/mobile-devices                      list calling user's paired phones
 *   - POST   /me/mobile-devices/:id/block            self-revoke a paired phone
 *   - GET    /me/oauth-clients                       list calling user's authorized OAuth clients
 *   - POST   /me/oauth-clients/:clientId/revoke      self-revoke an OAuth client
 *   - POST   /admin/users/:userId/mobile-devices/:id/block             admin block on behalf of user
 *   - POST   /admin/orgs/:orgId/oauth-clients/:clientId/block-globally org-wide OAuth client block
 *
 * "Admin" here is org/partner admin (USERS_WRITE permission), not platform
 * admin. See `/api/v1/admin/*` for platform-admin (cross-tenant) actions.
 */
export const lifecycleRoutes = new Hono();
export const lifecycleAdminRoutes = new Hono();

lifecycleRoutes.use('*', authMiddleware);
lifecycleAdminRoutes.use('*', authMiddleware);

const REVOKE_RATE_LIMIT = 10;
const REVOKE_RATE_WINDOW_SECONDS = 60;

// Header sent by the mobile app on every API call so we can identify which
// paired device is making the call (and therefore detect "this device tried
// to block itself" → 409 self-lockout protection, and "this device has been
// blocked → 403 device_blocked").
export const MOBILE_DEVICE_ID_HEADER = 'x-breeze-mobile-device-id';

const blockReasonSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
const revokeReasonSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
const adminBlockSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(500),
});
const blockGloballySchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(500),
  blockedUntil: z.string().datetime().optional(),
});

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function rateCheck(
  c: import('hono').Context,
  bucket: string,
  userId: string
): Promise<Response | null> {
  const redis = getRedis();
  if (!redis) return null;
  const key = `lifecycle:${bucket}:${userId}`;
  const result = await rateLimiter(redis, key, REVOKE_RATE_LIMIT, REVOKE_RATE_WINDOW_SECONDS);
  if (!result.allowed) {
    return c.json(
      {
        error: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
      },
      429
    );
  }
  return null;
}

function readMobileDeviceIdHeader(c: import('hono').Context): string | null {
  const v = c.req.header(MOBILE_DEVICE_ID_HEADER) ?? c.req.header(MOBILE_DEVICE_ID_HEADER.toUpperCase());
  return v && v.trim().length > 0 ? v.trim() : null;
}

// ============================================================
// User-facing: mobile devices
// ============================================================

lifecycleRoutes.get('/me/mobile-devices', async (c) => {
  const userId = c.get('auth').user.id;
  const callerDeviceHeader = readMobileDeviceIdHeader(c);

  const rows = await db
    .select({
      id: mobileDevices.id,
      deviceId: mobileDevices.deviceId,
      platform: mobileDevices.platform,
      model: mobileDevices.model,
      osVersion: mobileDevices.osVersion,
      appVersion: mobileDevices.appVersion,
      lastActiveAt: mobileDevices.lastActiveAt,
      status: mobileDevices.status,
      blockedAt: mobileDevices.blockedAt,
      blockedReason: mobileDevices.blockedReason,
      createdAt: mobileDevices.createdAt,
    })
    .from(mobileDevices)
    .where(eq(mobileDevices.userId, userId))
    // Active first, then blocked. Within each, most-recently-active first.
    .orderBy(
      sql`CASE WHEN ${mobileDevices.status} = 'active' THEN 0 ELSE 1 END`,
      desc(mobileDevices.lastActiveAt),
      desc(mobileDevices.createdAt)
    );

  return c.json({
    devices: rows.map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      platform: r.platform,
      model: r.model,
      osVersion: r.osVersion,
      appVersion: r.appVersion,
      lastActiveAt: r.lastActiveAt?.toISOString() ?? null,
      status: r.status,
      blockedAt: r.blockedAt?.toISOString() ?? null,
      blockedReason: r.blockedReason,
      createdAt: r.createdAt.toISOString(),
      isCurrent: callerDeviceHeader !== null && r.deviceId === callerDeviceHeader,
    })),
  });
});

lifecycleRoutes.post(
  '/me/mobile-devices/:id/block',
  zValidator('json', blockReasonSchema),
  async (c) => {
    const userId = c.get('auth').user.id;
    const targetId = c.req.param('id');
    const body = c.req.valid('json');

    if (!/^[0-9a-fA-F-]{36}$/.test(targetId)) {
      return c.json({ error: 'Invalid device id' }, 400);
    }

    const limit = await rateCheck(c, 'self-revoke-device', userId);
    if (limit) return limit;

    const callerDeviceHeader = readMobileDeviceIdHeader(c);

    const [target] = await db
      .select()
      .from(mobileDevices)
      .where(and(eq(mobileDevices.id, targetId), eq(mobileDevices.userId, userId)))
      .limit(1);

    if (!target) {
      return c.json({ error: 'Mobile device not found' }, 404);
    }

    if (target.status === 'blocked') {
      return c.json({ error: 'Device is already blocked' }, 409);
    }

    // Cannot block the device making the call. The mobile app greys this
    // option out client-side, but enforce server-side too.
    if (callerDeviceHeader && target.deviceId === callerDeviceHeader) {
      return c.json(
        {
          error: 'Cannot revoke the current device. Revoke from another device.',
          code: 'self_revoke_blocked',
        },
        409
      );
    }

    const now = new Date();
    const [updated] = await db
      .update(mobileDevices)
      .set({
        status: 'blocked',
        blockedAt: now,
        blockedByUserId: userId,
        blockedReason: body.reason ?? null,
        // Clear push tokens so we can't fan out to the revoked device.
        fcmToken: null,
        apnsToken: null,
        notificationsEnabled: false,
        updatedAt: now,
      })
      .where(and(eq(mobileDevices.id, targetId), eq(mobileDevices.userId, userId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to block device' }, 500);
    }

    const auditOrgId = await resolveUserAuditOrgId(userId);
    writeRouteAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'mobile.device.self_block',
      resourceType: 'mobile_device',
      resourceId: updated.id,
      resourceName: updated.deviceId,
      details: { reason: body.reason ?? null },
    });

    return c.body(null, 204);
  }
);

// ============================================================
// User-facing: OAuth clients
// ============================================================

lifecycleRoutes.get('/me/oauth-clients', async (c) => {
  const userId = c.get('auth').user.id;

  // Per-user grant rows joined to the client metadata. We aggregate by
  // client_id since a user may have multiple grant rows for the same
  // client (re-consent, multi-tab, etc).
  const rows = await asSystem(() =>
    db
      .select({
        clientId: oauthGrants.clientId,
        displayName: oauthClients.metadata,
        createdAt: oauthGrants.createdAt,
        revokedAt: oauthGrants.revokedAt,
        clientCreatedAt: oauthClients.createdAt,
        clientLastUsedAt: oauthClients.lastUsedAt,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(eq(oauthGrants.accountId, userId))
  );

  // Last decided approval per client (most recent decision regardless of
  // outcome) — useful as a "last seen" hint distinct from the grant
  // creation time.
  const approvals = await db
    .select({
      clientId: approvalRequests.requestingClientId,
      lastDecidedAt: max(approvalRequests.decidedAt),
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.userId, userId))
    .groupBy(approvalRequests.requestingClientId);
  const approvalByClient = new Map(
    approvals
      .filter((a): a is typeof a & { clientId: string } => Boolean(a.clientId))
      .map((a) => [a.clientId, a.lastDecidedAt])
  );

  const byClient = new Map<string, {
    clientId: string;
    displayName: string;
    createdAt: Date;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
  }>();
  for (const row of rows) {
    const meta = (row.displayName as { client_name?: string } | null) ?? null;
    const displayName = meta?.client_name ?? row.clientId;
    const existing = byClient.get(row.clientId);
    if (!existing) {
      byClient.set(row.clientId, {
        clientId: row.clientId,
        displayName,
        createdAt: row.createdAt,
        revokedAt: row.revokedAt,
        lastUsedAt: row.clientLastUsedAt,
      });
    } else {
      // Aggregate: row is "active" if any grant for this client is unrevoked.
      if (row.revokedAt === null && existing.revokedAt !== null) {
        existing.revokedAt = null;
      }
      if (row.createdAt > existing.createdAt) existing.createdAt = row.createdAt;
    }
  }

  return c.json({
    clients: Array.from(byClient.values()).map((c2) => ({
      clientId: c2.clientId,
      displayName: c2.displayName,
      createdAt: c2.createdAt.toISOString(),
      lastUsedAt: c2.lastUsedAt?.toISOString() ?? null,
      lastApprovalDecidedAt: approvalByClient.get(c2.clientId)?.toISOString() ?? null,
      revokedAt: c2.revokedAt?.toISOString() ?? null,
    })),
  });
});

async function revokeUserOauthClient(
  userId: string,
  clientId: string,
  revokedByUserId: string,
  reason: string | null
): Promise<{ grantsRevoked: number; refreshTokensRevoked: number }> {
  return asSystem(async () => {
    const now = new Date();

    // Mark grants revoked (per-user-per-client lifecycle).
    const updatedGrants = await db
      .update(oauthGrants)
      .set({ revokedAt: now, revokedByUserId, revokedReason: reason })
      .where(
        and(
          eq(oauthGrants.accountId, userId),
          eq(oauthGrants.clientId, clientId),
          isNull(oauthGrants.revokedAt)
        )
      )
      .returning({ id: oauthGrants.id });

    // Stamp + cache-revoke every active refresh token for the (user, client)
    // pair so sibling JWTs are killed before natural expiry.
    const tokens = await db
      .select({
        id: oauthRefreshTokens.id,
        payload: oauthRefreshTokens.payload,
        expiresAt: oauthRefreshTokens.expiresAt,
      })
      .from(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.userId, userId),
          eq(oauthRefreshTokens.clientId, clientId),
          isNull(oauthRefreshTokens.revokedAt)
        )
      );

    const seenGrants = new Set<string>();
    for (const tok of tokens) {
      const payload = tok.payload as { jti?: string; grantId?: string } | null;
      if (payload?.jti) {
        const ttl = Math.ceil((new Date(tok.expiresAt).getTime() - Date.now()) / 1000);
        try {
          await revokeJti(payload.jti, Math.max(ttl, 1));
        } catch (err) {
          logOauthError({
            errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
            message: 'self-service jti revocation cache write failed',
            err,
            context: { jti: payload.jti, clientId, userId },
          });
          throw err;
        }
      }
      if (payload?.grantId && !seenGrants.has(payload.grantId)) {
        seenGrants.add(payload.grantId);
        try {
          await revokeGrant(payload.grantId, ACCESS_TOKEN_TTL_SECONDS);
        } catch (err) {
          logOauthError({
            errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
            message: 'self-service grant revocation cache write failed',
            err,
            context: { grantId: payload.grantId, clientId, userId },
          });
          throw err;
        }
      }
    }

    // Belt-and-suspenders: also write a grant marker for any grant rows
    // that didn't have a refresh token (direct authorize flows).
    for (const grant of updatedGrants) {
      if (seenGrants.has(grant.id)) continue;
      seenGrants.add(grant.id);
      try {
        await revokeGrant(grant.id, ACCESS_TOKEN_TTL_SECONDS);
      } catch (err) {
        logOauthError({
          errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
          message: 'self-service grant-only revocation cache write failed',
          err,
          context: { grantId: grant.id, clientId, userId },
        });
        throw err;
      }
    }

    if (tokens.length > 0) {
      await db
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(inArray(oauthRefreshTokens.id, tokens.map((t) => t.id)));
    }

    return {
      grantsRevoked: updatedGrants.length,
      refreshTokensRevoked: tokens.length,
    };
  });
}

lifecycleRoutes.post(
  '/me/oauth-clients/:clientId/revoke',
  zValidator('json', revokeReasonSchema),
  async (c) => {
    const userId = c.get('auth').user.id;
    const clientId = c.req.param('clientId');
    const body = c.req.valid('json');

    const limit = await rateCheck(c, 'self-revoke-oauth', userId);
    if (limit) return limit;

    // Confirm the user actually has at least one grant for this client.
    const [present] = await asSystem(() =>
      db
        .select({ id: oauthGrants.id, revokedAt: oauthGrants.revokedAt })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.accountId, userId), eq(oauthGrants.clientId, clientId)))
        .limit(1)
    );

    if (!present) {
      return c.json({ error: 'OAuth client not found for this user' }, 404);
    }

    const result = await revokeUserOauthClient(userId, clientId, userId, body.reason ?? null);

    if (result.grantsRevoked === 0) {
      return c.json({ error: 'OAuth client already revoked' }, 409);
    }

    const auditOrgId = await resolveUserAuditOrgId(userId);
    writeRouteAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'oauth.client.self_revoke',
      resourceType: 'oauth_client',
      resourceId: clientId,
      details: {
        reason: body.reason ?? null,
        grantsRevoked: result.grantsRevoked,
        refreshTokensRevoked: result.refreshTokensRevoked,
      },
    });

    return c.body(null, 204);
  }
);

// ============================================================
// Admin endpoints
// ============================================================

const requireUsersWrite = requirePermission(
  PERMISSIONS.USERS_WRITE.resource,
  PERMISSIONS.USERS_WRITE.action
);

async function adminCanReachUser(
  auth: ReturnType<import('hono').Context['get']> & {
    scope: 'system' | 'partner' | 'organization';
    partnerId?: string | null;
    accessibleOrgIds?: string[] | null;
    canAccessOrg?: (orgId: string) => boolean;
  },
  targetUserId: string
): Promise<boolean> {
  if (auth.scope === 'system') return true;

  // Resolve the target user's org / partner association via system context
  // so RLS doesn't hide cross-tenant rows during the lookup itself; the
  // authorization check below is what enforces the boundary.
  return asSystem(async () => {
    if (auth.scope === 'partner' && auth.partnerId) {
      const [partnerRow] = await db
        .select({ partnerId: partnerUsers.partnerId })
        .from(partnerUsers)
        .where(eq(partnerUsers.userId, targetUserId))
        .limit(1);
      if (partnerRow?.partnerId === auth.partnerId) return true;

      // Org user under one of partner's orgs
      const [orgRow] = await db
        .select({ orgId: organizationUsers.orgId })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, targetUserId))
        .limit(1);
      if (orgRow?.orgId && typeof auth.canAccessOrg === 'function' && auth.canAccessOrg(orgRow.orgId)) {
        return true;
      }
      return false;
    }

    if (auth.scope === 'organization') {
      const [orgRow] = await db
        .select({ orgId: organizationUsers.orgId })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, targetUserId))
        .limit(1);
      const accessible = auth.accessibleOrgIds ?? [];
      return Boolean(orgRow?.orgId && accessible.includes(orgRow.orgId));
    }

    return false;
  });
}

lifecycleAdminRoutes.post(
  '/admin/users/:userId/mobile-devices/:id/block',
  requireUsersWrite,
  zValidator('json', adminBlockSchema),
  async (c) => {
    const auth = c.get('auth');
    const userId = c.req.param('userId');
    const targetId = c.req.param('id');
    const body = c.req.valid('json');

    if (!/^[0-9a-fA-F-]{36}$/.test(userId) || !/^[0-9a-fA-F-]{36}$/.test(targetId)) {
      return c.json({ error: 'Invalid id' }, 400);
    }

    if (userId === auth.user.id) {
      return c.json({ error: 'Use /me/mobile-devices/:id/block to revoke your own device' }, 409);
    }

    const ok = await adminCanReachUser(auth, userId);
    if (!ok) {
      return c.json({ error: 'User not in your tenant' }, 403);
    }

    const [target] = await asSystem(() =>
      db
        .select()
        .from(mobileDevices)
        .where(and(eq(mobileDevices.id, targetId), eq(mobileDevices.userId, userId)))
        .limit(1)
    );

    if (!target) {
      return c.json({ error: 'Mobile device not found' }, 404);
    }

    if (target.status === 'blocked') {
      return c.json({ error: 'Device is already blocked' }, 409);
    }

    const now = new Date();
    const [updated] = await asSystem(() =>
      db
        .update(mobileDevices)
        .set({
          status: 'blocked',
          blockedAt: now,
          blockedByUserId: auth.user.id,
          blockedReason: body.reason,
          fcmToken: null,
          apnsToken: null,
          notificationsEnabled: false,
          updatedAt: now,
        })
        .where(eq(mobileDevices.id, targetId))
        .returning()
    );

    if (!updated) {
      return c.json({ error: 'Failed to block device' }, 500);
    }

    const auditOrgId = await resolveUserAuditOrgId(userId);
    writeRouteAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'mobile.device.admin_block',
      resourceType: 'mobile_device',
      resourceId: updated.id,
      resourceName: updated.deviceId,
      details: {
        targetUserId: userId,
        reason: body.reason,
      },
    });

    return c.body(null, 204);
  }
);

lifecycleAdminRoutes.post(
  '/admin/orgs/:orgId/oauth-clients/:clientId/block-globally',
  requireUsersWrite,
  zValidator('json', blockGloballySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.param('orgId');
    const clientId = c.req.param('clientId');
    const body = c.req.valid('json');

    if (!/^[0-9a-fA-F-]{36}$/.test(orgId)) {
      return c.json({ error: 'Invalid orgId' }, 400);
    }

    if (typeof auth.canAccessOrg === 'function' && !auth.canAccessOrg(orgId) && auth.scope !== 'system') {
      return c.json({ error: 'Organization not in scope' }, 403);
    }

    // Verify the client exists.
    const [client] = await asSystem(() =>
      db.select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1)
    );
    if (!client) {
      return c.json({ error: 'OAuth client not found' }, 404);
    }

    // Verify org exists.
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const blockedUntil = body.blockedUntil ? new Date(body.blockedUntil) : null;
    const now = new Date();

    // Idempotent: if a non-expired block exists, refresh it; otherwise insert.
    const [existing] = await db
      .select()
      .from(oauthClientBlocks)
      .where(and(eq(oauthClientBlocks.orgId, orgId), eq(oauthClientBlocks.clientId, clientId)))
      .limit(1);

    let row: typeof oauthClientBlocks.$inferSelect | null = null;
    if (existing) {
      const [updated] = await db
        .update(oauthClientBlocks)
        .set({
          blockedAt: now,
          blockedByUserId: auth.user.id,
          blockedReason: body.reason,
          blockedUntil,
        })
        .where(eq(oauthClientBlocks.id, existing.id))
        .returning();
      row = updated ?? null;
    } else {
      const [inserted] = await db
        .insert(oauthClientBlocks)
        .values({
          orgId,
          clientId,
          blockedAt: now,
          blockedByUserId: auth.user.id,
          blockedReason: body.reason,
          blockedUntil,
        })
        .returning();
      row = inserted ?? null;
    }

    if (!row) {
      return c.json({ error: 'Failed to record block' }, 500);
    }

    // Revoke all in-flight tokens for users in this org for this client.
    const userIdsInOrg = await asSystem(() =>
      db
        .select({ userId: organizationUsers.userId })
        .from(organizationUsers)
        .where(eq(organizationUsers.orgId, orgId))
    );
    let tokensRevoked = 0;
    for (const { userId } of userIdsInOrg) {
      try {
        const r = await revokeUserOauthClient(userId, clientId, auth.user.id, body.reason);
        tokensRevoked += r.refreshTokensRevoked;
      } catch (err) {
        // Surface but don't block — org-wide block row is already in place.
        console.error('[lifecycle] org-block revoke failed for user', userId, err);
      }
    }

    writeRouteAudit(c, {
      orgId,
      action: 'oauth.client.admin_block_org',
      resourceType: 'oauth_client',
      resourceId: clientId,
      details: {
        reason: body.reason,
        blockedUntil: blockedUntil?.toISOString() ?? null,
        tokensRevoked,
      },
    });

    return c.json(
      {
        orgId,
        clientId,
        blockedAt: row.blockedAt.toISOString(),
        blockedUntil: row.blockedUntil?.toISOString() ?? null,
        tokensRevoked,
      },
      201
    );
  }
);

// ============================================================
// Helpers exported for use elsewhere (token validation, push fan-out).
// ============================================================

/**
 * Returns true when the (orgId, clientId) pair has an active block row.
 * Active = blocked_until IS NULL OR blocked_until > now().
 *
 * Caller is responsible for resolving orgId from the authorization context.
 */
export async function isOauthClientBlockedForOrg(orgId: string, clientId: string): Promise<boolean> {
  const now = new Date();
  const [row] = await asSystem(() =>
    db
      .select({ id: oauthClientBlocks.id })
      .from(oauthClientBlocks)
      .where(
        and(
          eq(oauthClientBlocks.orgId, orgId),
          eq(oauthClientBlocks.clientId, clientId),
          or(isNull(oauthClientBlocks.blockedUntil), gt(oauthClientBlocks.blockedUntil, now))
        )
      )
      .limit(1)
  );
  return Boolean(row);
}
