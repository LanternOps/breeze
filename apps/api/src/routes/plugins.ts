import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, ilike, sql, desc } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import { pluginCatalog, pluginInstallations, pluginLogs } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';

export const pluginRoutes = new Hono();

// Helper functions for org access
async function canAccessOrg(
  auth: { canAccessOrg: (orgId: string) => boolean },
  orgId: string
): Promise<boolean> {
  return auth.canAccessOrg(orgId);
}

function resolveOrgId(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 } as const;
    }

    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 } as const;
    }

    return { orgId: auth.orgId } as const;
  }

  if (requestedOrgId && !auth.canAccessOrg(requestedOrgId)) {
    return { error: 'Access to this organization denied', status: 403 } as const;
  }

  if (auth.scope === 'partner' && !requestedOrgId) {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && accessibleOrgIds.length === 1) {
      return { orgId: accessibleOrgIds[0] } as const;
    }
    return { error: 'orgId is required for partner scope', status: 400 } as const;
  }

  if (auth.scope === 'system' && !requestedOrgId) {
    return { error: 'orgId is required for system scope', status: 400 } as const;
  }

  if (requireForNonOrg && !requestedOrgId) {
    return { error: 'orgId is required', status: 400 } as const;
  }

  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}

// Validation Schemas
const catalogQuerySchema = z.object({
  type: z.enum(['integration', 'automation', 'reporting', 'collector', 'notification', 'ui']).optional(),
  category: z.string().optional(),
  search: z.string().optional(),
  verified: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20)
});

const installPluginSchema = z.object({
  catalogId: z.string().uuid(),
  config: z.record(z.unknown()).default({}),
  orgId: z.string().uuid().optional()
});

const updatePluginSchema = z.object({
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional()
});

const installationQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['installed', 'error', 'installing', 'updating', 'uninstalling']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20)
});

const logsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  level: z.enum(['error', 'warn', 'info', 'debug']).optional()
});

// Apply auth middleware to all routes
pluginRoutes.use('*', authMiddleware);

// ============================================
// Catalog Endpoints (authenticated user)
// ============================================

// GET /catalog - List available plugins with filters
pluginRoutes.get(
  '/catalog',
  zValidator('query', catalogQuerySchema),
  async (c) => {
    const query = c.req.valid('query');
    const offset = (query.page - 1) * query.limit;

    const conditions = [eq(pluginCatalog.isDeprecated, false)];

    if (query.type) {
      conditions.push(eq(pluginCatalog.type, query.type));
    }

    if (query.category) {
      conditions.push(eq(pluginCatalog.category, query.category));
    }

    if (query.search) {
      const searchPattern = `%${query.search}%`;
      conditions.push(
        sql`(${ilike(pluginCatalog.name, searchPattern)} OR ${ilike(pluginCatalog.description, searchPattern)})`
      );
    }

    if (query.verified !== undefined) {
      conditions.push(eq(pluginCatalog.isVerified, query.verified));
    }

    const whereClause = and(...conditions);

    const [plugins, countResult] = await Promise.all([
      db
        .select({
          id: pluginCatalog.id,
          slug: pluginCatalog.slug,
          name: pluginCatalog.name,
          version: pluginCatalog.version,
          description: pluginCatalog.description,
          type: pluginCatalog.type,
          author: pluginCatalog.author,
          category: pluginCatalog.category,
          tags: pluginCatalog.tags,
          iconUrl: pluginCatalog.iconUrl,
          installCount: pluginCatalog.installCount,
          rating: pluginCatalog.rating,
          isVerified: pluginCatalog.isVerified,
          isFeatured: pluginCatalog.isFeatured
        })
        .from(pluginCatalog)
        .where(whereClause)
        .orderBy(desc(pluginCatalog.isFeatured), desc(pluginCatalog.installCount))
        .limit(query.limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(pluginCatalog)
        .where(whereClause)
    ]);

    const total = countResult[0]?.count ?? 0;

    return c.json({
      data: plugins,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit)
      }
    });
  }
);

// GET /catalog/:slug - Get plugin details by slug
pluginRoutes.get('/catalog/:slug', async (c) => {
  const slug = c.req.param('slug');

  const [plugin] = await db
    .select()
    .from(pluginCatalog)
    .where(eq(pluginCatalog.slug, slug))
    .limit(1);

  if (!plugin) {
    return c.json({ error: 'Plugin not found' }, 404);
  }

  return c.json(plugin);
});

// ============================================
// Installation Endpoints (org admin or partner/system)
// ============================================

// GET /installations - List installed plugins for org
pluginRoutes.get(
  '/installations',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', installationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, true);

    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const offset = (query.page - 1) * query.limit;
    const conditions = [eq(pluginInstallations.orgId, orgResult.orgId as string)];

    if (query.status) {
      if (query.status === 'installed') {
        conditions.push(eq(pluginInstallations.status, 'installed'));
      } else if (query.status === 'error') {
        conditions.push(eq(pluginInstallations.status, 'error'));
      } else {
        conditions.push(eq(pluginInstallations.status, query.status));
      }
    }

    const whereClause = and(...conditions);

    const [installations, countResult] = await Promise.all([
      db
        .select({
          id: pluginInstallations.id,
          orgId: pluginInstallations.orgId,
          catalogId: pluginInstallations.catalogId,
          version: pluginInstallations.version,
          status: pluginInstallations.status,
          enabled: pluginInstallations.enabled,
          config: pluginInstallations.config,
          installedAt: pluginInstallations.installedAt,
          lastActiveAt: pluginInstallations.lastActiveAt,
          errorMessage: pluginInstallations.errorMessage,
          createdAt: pluginInstallations.createdAt,
          updatedAt: pluginInstallations.updatedAt,
          plugin: {
            slug: pluginCatalog.slug,
            name: pluginCatalog.name,
            type: pluginCatalog.type,
            iconUrl: pluginCatalog.iconUrl
          }
        })
        .from(pluginInstallations)
        .innerJoin(pluginCatalog, eq(pluginInstallations.catalogId, pluginCatalog.id))
        .where(whereClause)
        .orderBy(desc(pluginInstallations.createdAt))
        .limit(query.limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(pluginInstallations)
        .where(whereClause)
    ]);

    const total = countResult[0]?.count ?? 0;

    return c.json({
      data: installations,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit)
      }
    });
  }
);

// POST /installations - Install plugin
pluginRoutes.post(
  '/installations',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', installPluginSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId, true);

    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    // Fetch the plugin from catalog
    const [catalogPlugin] = await db
      .select()
      .from(pluginCatalog)
      .where(eq(pluginCatalog.id, body.catalogId))
      .limit(1);

    if (!catalogPlugin) {
      return c.json({ error: 'Plugin not found in catalog' }, 404);
    }

    if (catalogPlugin.isDeprecated) {
      return c.json({ error: 'Plugin is deprecated and cannot be installed' }, 400);
    }

    // Check if already installed
    const [existing] = await db
      .select()
      .from(pluginInstallations)
      .where(
        and(
          eq(pluginInstallations.orgId, orgResult.orgId as string),
          eq(pluginInstallations.catalogId, body.catalogId)
        )
      )
      .limit(1);

    if (existing) {
      return c.json({ error: 'Plugin is already installed for this organization' }, 409);
    }

    // Validate config against manifest schema if available
    // In a real implementation, this would fetch the manifest and validate
    // For now, we accept any config object

    const now = new Date();

    // Create installation
    const [installation] = await db
      .insert(pluginInstallations)
      .values({
        orgId: orgResult.orgId as string,
        catalogId: body.catalogId,
        version: catalogPlugin.version,
        status: 'installed',
        enabled: true,
        config: body.config,
        permissions: catalogPlugin.permissions,
        installedAt: now,
        installedBy: auth.user.id
      })
      .returning();

    if (!installation) {
      return c.json({ error: 'Failed to create installation' }, 500);
    }

    // Update install count
    await db
      .update(pluginCatalog)
      .set({ installCount: sql`${pluginCatalog.installCount} + 1` })
      .where(eq(pluginCatalog.id, body.catalogId));

    // Log installation event
    await db.insert(pluginLogs).values({
      installationId: installation.id,
      level: 'info',
      message: `Plugin installed: ${catalogPlugin.name} v${catalogPlugin.version}`,
      context: {
        action: 'install',
        userId: auth.user.id,
        version: catalogPlugin.version
      }
    });

    writeRouteAudit(c, {
      orgId: orgResult.orgId as string,
      action: 'install_plugin',
      resourceType: 'plugin',
      resourceId: installation.id,
      resourceName: catalogPlugin.name,
      details: { version: catalogPlugin.version, catalogId: body.catalogId }
    });

    return c.json(installation, 201);
  }
);

// GET /installations/:id - Get installation details
pluginRoutes.get(
  '/installations/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const installationId = c.req.param('id');

    const [installation] = await db
      .select({
        id: pluginInstallations.id,
        orgId: pluginInstallations.orgId,
        catalogId: pluginInstallations.catalogId,
        version: pluginInstallations.version,
        status: pluginInstallations.status,
        enabled: pluginInstallations.enabled,
        config: pluginInstallations.config,
        permissions: pluginInstallations.permissions,
        sandboxEnabled: pluginInstallations.sandboxEnabled,
        resourceLimits: pluginInstallations.resourceLimits,
        installedAt: pluginInstallations.installedAt,
        installedBy: pluginInstallations.installedBy,
        lastActiveAt: pluginInstallations.lastActiveAt,
        errorMessage: pluginInstallations.errorMessage,
        createdAt: pluginInstallations.createdAt,
        updatedAt: pluginInstallations.updatedAt,
        plugin: {
          id: pluginCatalog.id,
          slug: pluginCatalog.slug,
          name: pluginCatalog.name,
          version: pluginCatalog.version,
          description: pluginCatalog.description,
          type: pluginCatalog.type,
          author: pluginCatalog.author,
          iconUrl: pluginCatalog.iconUrl,
          homepage: pluginCatalog.homepage
        }
      })
      .from(pluginInstallations)
      .innerJoin(pluginCatalog, eq(pluginInstallations.catalogId, pluginCatalog.id))
      .where(eq(pluginInstallations.id, installationId))
      .limit(1);

    if (!installation) {
      return c.json({ error: 'Installation not found' }, 404);
    }

    if (!(await canAccessOrg(auth, installation.orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json(installation);
  }
);

// PATCH /installations/:id - Update plugin config
pluginRoutes.patch(
  '/installations/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updatePluginSchema),
  async (c) => {
    const auth = c.get('auth');
    const installationId = c.req.param('id');
    const updates = c.req.valid('json');

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const [installation] = await db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.id, installationId))
      .limit(1);

    if (!installation) {
      return c.json({ error: 'Installation not found' }, 404);
    }

    if (!(await canAccessOrg(auth, installation.orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const updateData: Partial<typeof pluginInstallations.$inferInsert> = {
      updatedAt: new Date()
    };

    if (updates.config !== undefined) {
      // In production, validate config against manifest schema here
      updateData.config = updates.config;
    }

    if (updates.enabled !== undefined) {
      updateData.enabled = updates.enabled;
    }

    const [updated] = await db
      .update(pluginInstallations)
      .set(updateData)
      .where(eq(pluginInstallations.id, installationId))
      .returning();

    // Log config update
    await db.insert(pluginLogs).values({
      installationId: installation.id,
      level: 'info',
      message: 'Plugin configuration updated',
      context: {
        action: 'config_update',
        userId: auth.user.id,
        changes: Object.keys(updates)
      }
    });

    writeRouteAudit(c, {
      orgId: installation.orgId,
      action: 'plugin.update',
      resourceType: 'plugin',
      resourceId: installation.id,
      details: { changedFields: Object.keys(updates) }
    });

    return c.json(updated);
  }
);

// DELETE /installations/:id - Uninstall plugin
pluginRoutes.delete(
  '/installations/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const installationId = c.req.param('id');

    const [installation] = await db
      .select({
        id: pluginInstallations.id,
        orgId: pluginInstallations.orgId,
        catalogId: pluginInstallations.catalogId,
        pluginName: pluginCatalog.name
      })
      .from(pluginInstallations)
      .innerJoin(pluginCatalog, eq(pluginInstallations.catalogId, pluginCatalog.id))
      .where(eq(pluginInstallations.id, installationId))
      .limit(1);

    if (!installation) {
      return c.json({ error: 'Installation not found' }, 404);
    }

    if (!(await canAccessOrg(auth, installation.orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Log uninstallation event before deletion
    await db.insert(pluginLogs).values({
      installationId: installation.id,
      level: 'info',
      message: `Plugin uninstalled: ${installation.pluginName}`,
      context: {
        action: 'uninstall',
        userId: auth.user.id
      }
    });

    // Delete logs first (foreign key constraint)
    await db
      .delete(pluginLogs)
      .where(eq(pluginLogs.installationId, installationId));

    // Delete installation
    await db
      .delete(pluginInstallations)
      .where(eq(pluginInstallations.id, installationId));

    // Decrement install count
    await db
      .update(pluginCatalog)
      .set({ installCount: sql`GREATEST(${pluginCatalog.installCount} - 1, 0)` })
      .where(eq(pluginCatalog.id, installation.catalogId));

    writeRouteAudit(c, {
      orgId: installation.orgId,
      action: 'uninstall_plugin',
      resourceType: 'plugin',
      resourceId: installation.id,
      resourceName: installation.pluginName,
      details: { catalogId: installation.catalogId }
    });

    return c.json({ success: true });
  }
);

// POST /installations/:id/enable - Enable plugin
pluginRoutes.post(
  '/installations/:id/enable',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const installationId = c.req.param('id');

    const [installation] = await db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.id, installationId))
      .limit(1);

    if (!installation) {
      return c.json({ error: 'Installation not found' }, 404);
    }

    if (!(await canAccessOrg(auth, installation.orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (installation.enabled) {
      return c.json({ error: 'Plugin is already enabled' }, 400);
    }

    const [updated] = await db
      .update(pluginInstallations)
      .set({
        enabled: true,
        updatedAt: new Date()
      })
      .where(eq(pluginInstallations.id, installationId))
      .returning();

    // Log enable event
    await db.insert(pluginLogs).values({
      installationId: installation.id,
      level: 'info',
      message: 'Plugin enabled',
      context: {
        action: 'enable',
        userId: auth.user.id
      }
    });

    writeRouteAudit(c, {
      orgId: installation.orgId,
      action: 'plugin.enable',
      resourceType: 'plugin',
      resourceId: installation.id
    });

    return c.json(updated);
  }
);

// POST /installations/:id/disable - Disable plugin
pluginRoutes.post(
  '/installations/:id/disable',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const installationId = c.req.param('id');

    const [installation] = await db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.id, installationId))
      .limit(1);

    if (!installation) {
      return c.json({ error: 'Installation not found' }, 404);
    }

    if (!(await canAccessOrg(auth, installation.orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (!installation.enabled) {
      return c.json({ error: 'Plugin is already disabled' }, 400);
    }

    const [updated] = await db
      .update(pluginInstallations)
      .set({
        enabled: false,
        updatedAt: new Date()
      })
      .where(eq(pluginInstallations.id, installationId))
      .returning();

    // Log disable event
    await db.insert(pluginLogs).values({
      installationId: installation.id,
      level: 'info',
      message: 'Plugin disabled',
      context: {
        action: 'disable',
        userId: auth.user.id
      }
    });

    writeRouteAudit(c, {
      orgId: installation.orgId,
      action: 'plugin.disable',
      resourceType: 'plugin',
      resourceId: installation.id
    });

    return c.json(updated);
  }
);

// ============================================
// Logs Endpoints
// ============================================

// GET /installations/:id/logs - Get plugin execution logs
pluginRoutes.get(
  '/installations/:id/logs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', logsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const installationId = c.req.param('id');
    const query = c.req.valid('query');

    // First check installation exists and user has access
    const [installation] = await db
      .select({ orgId: pluginInstallations.orgId })
      .from(pluginInstallations)
      .where(eq(pluginInstallations.id, installationId))
      .limit(1);

    if (!installation) {
      return c.json({ error: 'Installation not found' }, 404);
    }

    if (!(await canAccessOrg(auth, installation.orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const offset = (query.page - 1) * query.limit;
    const conditions = [eq(pluginLogs.installationId, installationId)];

    if (query.level) {
      conditions.push(eq(pluginLogs.level, query.level));
    }

    const whereClause = and(...conditions);

    const [logs, countResult] = await Promise.all([
      db
        .select()
        .from(pluginLogs)
        .where(whereClause)
        .orderBy(desc(pluginLogs.timestamp))
        .limit(query.limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(pluginLogs)
        .where(whereClause)
    ]);

    const total = countResult[0]?.count ?? 0;

    return c.json({
      data: logs,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit)
      }
    });
  }
);
