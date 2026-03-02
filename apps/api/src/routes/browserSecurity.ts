import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
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
import { PERMISSIONS } from '../services/permissions';

export const browserSecurityRoutes = new Hono();

browserSecurityRoutes.use('*', authMiddleware);
browserSecurityRoutes.use('*', requireScope('organization', 'partner', 'system'));

// GET /browser-security/extensions — list extensions with risk summary
browserSecurityRoutes.get(
  '/extensions',
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { deviceId, browser, riskLevel, limit: rawLimit } = c.req.query();

    const conditions: SQL[] = [];
    if (auth.orgId) conditions.push(eq(browserExtensions.orgId, auth.orgId));
    if (deviceId) conditions.push(eq(browserExtensions.deviceId, deviceId));
    if (browser) conditions.push(eq(browserExtensions.browser, browser));
    if (riskLevel) conditions.push(eq(browserExtensions.riskLevel, riskLevel));

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
    const { deviceId, policyId } = c.req.query();

    const conditions: SQL[] = [isNull(browserPolicyViolations.resolvedAt)];
    if (auth.orgId) conditions.push(eq(browserPolicyViolations.orgId, auth.orgId));
    if (deviceId) conditions.push(eq(browserPolicyViolations.deviceId, deviceId));
    if (policyId) conditions.push(eq(browserPolicyViolations.policyId, policyId));

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
    const policyId = c.req.param('policyId');

    const conditions: SQL[] = [eq(browserPolicies.id, policyId)];
    if (auth.orgId) conditions.push(eq(browserPolicies.orgId, auth.orgId));

    const [existing] = await db
      .select()
      .from(browserPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!existing) return c.json({ error: 'Policy not found' }, 404);

    const body = c.req.valid('json');
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
    const policyId = c.req.param('policyId');

    const conditions: SQL[] = [eq(browserPolicies.id, policyId)];
    if (auth.orgId) conditions.push(eq(browserPolicies.orgId, auth.orgId));

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
    const deviceId = c.req.param('deviceId');
    if (!auth.orgId) return c.json({ error: 'Organization context required' }, 400);

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
