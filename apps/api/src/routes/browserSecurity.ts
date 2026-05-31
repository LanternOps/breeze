import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  browserExtensions,
  browserPolicies,
  browserPolicyViolations,
} from '../db/schema';
import { devices } from '../db/schema/devices';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { triggerBrowserPolicyEvaluation } from '../jobs/browserSecurityJobs';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';

export const browserSecurityRoutes = new Hono();

browserSecurityRoutes.use('*', authMiddleware);
browserSecurityRoutes.use('*', requireScope('organization', 'partner', 'system'));

// Resolve the device IDs a site-restricted caller may read within their org,
// narrowed by `permissions.allowedSiteIds`. Returns null when the caller has no
// site restriction (no narrowing needed). Site is an app-layer concept only —
// Postgres RLS does NOT defend it — so a site-restricted org user must not read
// extension/violation rows for devices in other sites within the same org.
// `allowedSiteIds` is only ever set for org-scope users (see permissions.ts), so
// `orgId` is guaranteed present whenever narrowing applies. Mirrors the
// software-inventory list route (PR #864/#868).
async function resolveSiteAllowedDeviceIds(
  orgId: string,
  perms: UserPermissions | undefined,
): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId))
    .map((d) => d.id);
}

// A site-restricted caller may only mutate policies that target sites entirely
// within their allowlist. Org/group/device/tag targets are not site-bounded, so
// a site-restricted caller cannot confirm scope over them and is denied.
// Unrestricted callers (no `allowedSiteIds`) always pass.
function policyWithinSiteWriteScope(
  perms: UserPermissions | undefined,
  targetType: string,
  targetIds: string[] | null | undefined,
): boolean {
  if (!perms?.allowedSiteIds) return true;
  if (targetType !== 'site') return false;
  const ids = targetIds ?? [];
  if (ids.length === 0) return false;
  return ids.every((id) => canAccessSite(perms, id));
}

// GET /browser-security/extensions — list extensions with risk summary
browserSecurityRoutes.get(
  '/extensions',
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const { deviceId, browser, riskLevel, limit: rawLimit } = c.req.query();

    const conditions: SQL[] = [];
    if (auth.orgId) conditions.push(eq(browserExtensions.orgId, auth.orgId));
    if (deviceId) conditions.push(eq(browserExtensions.deviceId, deviceId));
    if (browser) conditions.push(eq(browserExtensions.browser, browser));
    if (riskLevel) conditions.push(eq(browserExtensions.riskLevel, riskLevel));

    // Narrow to the caller's accessible devices when site-restricted.
    if (perms?.allowedSiteIds && auth.orgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
      if (deviceId && !allowedDeviceIds!.includes(deviceId)) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({
          summary: { total: 0, low: 0, medium: 0, high: 0, critical: 0 },
          extensions: [],
        });
      }
      conditions.push(inArray(browserExtensions.deviceId, allowedDeviceIds));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(Math.max(1, Number(rawLimit) || 100), 500);

    const [summary, extensions] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          low: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'low' then 1 else 0 end), 0)::int`,
          medium: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'medium' then 1 else 0 end), 0)::int`,
          high: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'high' then 1 else 0 end), 0)::int`,
          critical: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'critical' then 1 else 0 end), 0)::int`,
        })
        .from(browserExtensions)
        .where(where),
      db
        .select({
          id: browserExtensions.id,
          orgId: browserExtensions.orgId,
          deviceId: browserExtensions.deviceId,
          deviceName: devices.hostname,
          browser: browserExtensions.browser,
          extensionId: browserExtensions.extensionId,
          name: browserExtensions.name,
          version: browserExtensions.version,
          source: browserExtensions.source,
          riskLevel: browserExtensions.riskLevel,
          enabled: browserExtensions.enabled,
          lastSeenAt: browserExtensions.lastSeenAt,
        })
        .from(browserExtensions)
        .innerJoin(devices, eq(browserExtensions.deviceId, devices.id))
        .where(where)
        .orderBy(desc(browserExtensions.lastSeenAt))
        .limit(limit),
    ]);

    return c.json({ summary: summary[0], extensions });
  }
);

// GET /browser-security/violations — list unresolved violations
browserSecurityRoutes.get(
  '/violations',
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const { deviceId, policyId } = c.req.query();

    const conditions: SQL[] = [isNull(browserPolicyViolations.resolvedAt)];
    if (auth.orgId) conditions.push(eq(browserPolicyViolations.orgId, auth.orgId));
    if (deviceId) conditions.push(eq(browserPolicyViolations.deviceId, deviceId));
    if (policyId) conditions.push(eq(browserPolicyViolations.policyId, policyId));

    // Narrow to the caller's accessible devices when site-restricted.
    if (perms?.allowedSiteIds && auth.orgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
      if (deviceId && !allowedDeviceIds!.includes(deviceId)) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({ violations: [] });
      }
      conditions.push(inArray(browserPolicyViolations.deviceId, allowedDeviceIds));
    }

    const violations = await db
      .select({
        id: browserPolicyViolations.id,
        orgId: browserPolicyViolations.orgId,
        deviceId: browserPolicyViolations.deviceId,
        deviceName: devices.hostname,
        policyId: browserPolicyViolations.policyId,
        violationType: browserPolicyViolations.violationType,
        details: browserPolicyViolations.details,
        detectedAt: browserPolicyViolations.detectedAt,
      })
      .from(browserPolicyViolations)
      .innerJoin(devices, eq(browserPolicyViolations.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(desc(browserPolicyViolations.detectedAt))
      .limit(200);

    return c.json({ violations });
  }
);

const policyCreateSchema = z.object({
  name: z.string().min(1).max(200),
  targetType: z.enum(['org', 'site', 'group', 'device', 'tag']),
  targetIds: z.array(z.string()).optional(),
  allowedExtensions: z.array(z.string()).optional(),
  blockedExtensions: z.array(z.string()).optional(),
  requiredExtensions: z.array(z.string()).optional(),
  settings: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

// GET /browser-security/policies — list policies
browserSecurityRoutes.get(
  '/policies',
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const conditions: SQL[] = [];
    if (auth.orgId) conditions.push(eq(browserPolicies.orgId, auth.orgId));

    const policies = await db
      .select()
      .from(browserPolicies)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(browserPolicies.updatedAt));

    return c.json({ policies });
  }
);

// POST /browser-security/policies — create policy
browserSecurityRoutes.post(
  '/policies',
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', policyCreateSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.orgId) return c.json({ error: 'Organization context required' }, 400);

    const body = c.req.valid('json');

    // Site-restricted callers may only create policies scoped to their sites.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (!policyWithinSiteWriteScope(perms, body.targetType, body.targetIds)) {
      return c.json({ error: 'Access to the targeted site(s) denied' }, 403);
    }

    const [policy] = await db
      .insert(browserPolicies)
      .values({
        orgId: auth.orgId,
        name: body.name,
        targetType: body.targetType,
        targetIds: body.targetIds ?? null,
        allowedExtensions: body.allowedExtensions ?? null,
        blockedExtensions: body.blockedExtensions ?? null,
        requiredExtensions: body.requiredExtensions ?? null,
        settings: body.settings ?? null,
        isActive: body.isActive ?? true,
        createdBy: auth.user.id,
      })
      .returning();

    if (policy) {
      try {
        await triggerBrowserPolicyEvaluation(auth.orgId, policy.id);
      } catch {
        // Non-fatal — policy was created successfully
      }

      writeRouteAudit(c, {
        orgId: auth.orgId,
        action: 'browser_policy.created',
        resourceType: 'browser_policy',
        resourceId: policy.id,
        resourceName: policy.name,
      });
    }

    return c.json({ policy }, 201);
  }
);

// PUT /browser-security/policies/:policyId — update policy
browserSecurityRoutes.put(
  '/policies/:policyId',
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', policyCreateSchema.partial()),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const policyId = c.req.param('policyId')!;

    const conditions: SQL[] = [eq(browserPolicies.id, policyId)];
    if (auth.orgId) conditions.push(eq(browserPolicies.orgId, auth.orgId));

    const [existing] = await db
      .select()
      .from(browserPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!existing) return c.json({ error: 'Policy not found' }, 404);

    const body = c.req.valid('json');

    // Site-restricted callers must be able to act on the policy both as it
    // stands and as it will be after the update (so they cannot retarget a
    // policy onto a site outside their allowlist).
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds) {
      const nextTargetType = body.targetType ?? existing.targetType;
      const nextTargetIds =
        body.targetIds !== undefined ? body.targetIds : existing.targetIds;
      if (
        !policyWithinSiteWriteScope(perms, existing.targetType, existing.targetIds) ||
        !policyWithinSiteWriteScope(perms, nextTargetType, nextTargetIds)
      ) {
        return c.json({ error: 'Access to the targeted site(s) denied' }, 403);
      }
    }

    const [updated] = await db
      .update(browserPolicies)
      .set({
        name: body.name ?? existing.name,
        targetType: body.targetType ?? existing.targetType,
        targetIds: body.targetIds !== undefined ? body.targetIds : existing.targetIds,
        allowedExtensions: body.allowedExtensions !== undefined ? body.allowedExtensions : existing.allowedExtensions,
        blockedExtensions: body.blockedExtensions !== undefined ? body.blockedExtensions : existing.blockedExtensions,
        requiredExtensions: body.requiredExtensions !== undefined ? body.requiredExtensions : existing.requiredExtensions,
        settings: body.settings !== undefined ? body.settings : existing.settings,
        isActive: body.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(browserPolicies.id, existing.id))
      .returning();

    try {
      await triggerBrowserPolicyEvaluation(existing.orgId, existing.id);
    } catch {
      // Non-fatal
    }

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'browser_policy.updated',
      resourceType: 'browser_policy',
      resourceId: existing.id,
      resourceName: updated?.name ?? existing.name,
    });
    return c.json({ policy: updated ?? existing });
  }
);

// DELETE /browser-security/policies/:policyId
browserSecurityRoutes.delete(
  '/policies/:policyId',
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const policyId = c.req.param('policyId')!;

    const conditions: SQL[] = [eq(browserPolicies.id, policyId)];
    if (auth.orgId) conditions.push(eq(browserPolicies.orgId, auth.orgId));

    // Site-restricted callers can only delete policies scoped to their sites.
    // Verify scope before deleting (the bare DELETE can't gate on site).
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds) {
      const [existing] = await db
        .select({
          targetType: browserPolicies.targetType,
          targetIds: browserPolicies.targetIds,
        })
        .from(browserPolicies)
        .where(and(...conditions))
        .limit(1);
      if (!existing) return c.json({ error: 'Policy not found' }, 404);
      if (!policyWithinSiteWriteScope(perms, existing.targetType, existing.targetIds)) {
        return c.json({ error: 'Access to the targeted site(s) denied' }, 403);
      }
    }

    const [deleted] = await db
      .delete(browserPolicies)
      .where(and(...conditions))
      .returning();

    if (!deleted) return c.json({ error: 'Policy not found' }, 404);

    writeRouteAudit(c, {
      orgId: deleted.orgId,
      action: 'browser_policy.deleted',
      resourceType: 'browser_policy',
      resourceId: deleted.id,
      resourceName: deleted.name,
    });
    return c.json({ success: true });
  }
);

// PUT /browser-security/inventory/:deviceId — agent reports extensions
browserSecurityRoutes.put(
  '/inventory/:deviceId',
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const deviceId = c.req.param('deviceId')!;
    if (!auth.orgId) return c.json({ error: 'Organization context required' }, 400);

    // Verify device belongs to caller's org, and gate on site-scope so a
    // partner-scope user with `allowedSiteIds` cannot write inventory for a
    // device outside their site allowlist. RLS does not defend the site axis.
    // Mirrors the SP2 launch-readiness sweep (PR #864/#868).
    const [device] = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.orgId, auth.orgId)))
      .limit(1);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    const userPerms = c.get('permissions') as UserPermissions | undefined;
    if (userPerms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const body = await c.req.json();
    const extensions = Array.isArray(body.extensions) ? body.extensions : [];
    const now = new Date();

    for (const ext of extensions) {
      await db
        .insert(browserExtensions)
        .values({
          orgId: auth.orgId,
          deviceId,
          browser: ext.browser ?? 'unknown',
          extensionId: ext.extensionId ?? ext.id ?? '',
          name: ext.name ?? 'Unknown',
          version: ext.version ?? null,
          source: ext.source ?? 'unknown',
          permissions: ext.permissions ?? [],
          riskLevel: ext.riskLevel ?? 'low',
          enabled: ext.enabled !== false,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [browserExtensions.orgId, browserExtensions.deviceId, browserExtensions.browser, browserExtensions.extensionId],
          set: {
            name: sql`excluded.name`,
            version: sql`excluded.version`,
            source: sql`excluded.source`,
            permissions: sql`excluded.permissions`,
            riskLevel: sql`excluded.risk_level`,
            enabled: sql`excluded.enabled`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
    }

    return c.json({ upserted: extensions.length });
  }
);
