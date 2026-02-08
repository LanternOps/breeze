import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { savedFilters } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { evaluateFilterWithPreview, FilterConditionGroup } from '../services/filterEngine';
import { writeRouteAudit } from '../services/auditEvents';
import {
  filterConditionGroupSchema,
  createSavedFilterSchema,
  updateSavedFilterSchema,
  savedFilterQuerySchema
} from '@breeze/shared/validators/filters';

export const filterRoutes = new Hono();

type SavedFilterResponse = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  conditions: unknown;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

const filterIdParamSchema = z.object({
  id: z.string().uuid()
});

const createFilterSchema = createSavedFilterSchema.extend({
  orgId: z.string().uuid().optional()
});

const previewQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional()
});

filterRoutes.use('*', authMiddleware);

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  return true;
}

async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds'>
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    return auth.accessibleOrgIds ?? [];
  }

  return null;
}

async function getFilterWithAccess(
  filterId: string,
  auth: { scope: string; partnerId: string | null; orgId: string | null }
) {
  const [filter] = await db
    .select()
    .from(savedFilters)
    .where(eq(savedFilters.id, filterId))
    .limit(1);

  if (!filter) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(filter.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return filter;
}

function mapFilterRow(filter: typeof savedFilters.$inferSelect): SavedFilterResponse {
  return {
    id: filter.id,
    orgId: filter.orgId,
    name: filter.name,
    description: filter.description ?? null,
    conditions: filter.conditions,
    createdBy: filter.createdBy ?? null,
    createdAt: filter.createdAt.toISOString(),
    updatedAt: filter.updatedAt.toISOString()
  };
}

// POST /preview - Ad-hoc filter preview (no saved filter required)
filterRoutes.post(
  '/preview',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', z.object({
    conditions: filterConditionGroupSchema,
    limit: z.number().int().positive().max(100).optional()
  })),
  async (c) => {
    const auth = c.get('auth');
    const { conditions, limit } = c.req.valid('json');

    const orgIds = await getOrgIdsForAuth(auth);
    if (!orgIds || orgIds.length === 0) {
      return c.json({ data: { totalCount: 0, devices: [], evaluatedAt: new Date().toISOString() } });
    }

    // Evaluate filter across all orgs the user has access to
    const allDevices: Array<{ id: string; hostname: string; displayName: string | null; osType: string; status: string; lastSeenAt: Date | null }> = [];
    let totalCount = 0;

    for (const orgId of orgIds) {
      const preview = await evaluateFilterWithPreview(
        conditions as unknown as FilterConditionGroup,
        { orgId, previewLimit: limit }
      );
      totalCount += preview.totalCount;
      allDevices.push(...preview.devices);
    }

    // Trim to limit after aggregating
    const trimmedDevices = allDevices.slice(0, limit ?? 10);

    writeRouteAudit(c, {
      orgId: auth.orgId ?? (orgIds.length === 1 ? orgIds[0] : null),
      action: 'filter.preview',
      resourceType: 'saved_filter',
      details: {
        orgCount: orgIds.length,
        totalCount,
        previewCount: trimmedDevices.length
      }
    });

    return c.json({
      data: {
        totalCount,
        devices: trimmedDevices.map((device) => ({
          id: device.id,
          hostname: device.hostname,
          displayName: device.displayName,
          osType: device.osType,
          status: device.status,
          lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null
        })),
        evaluatedAt: new Date().toISOString()
      }
    });
  }
);

// GET / - List saved filters
filterRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', savedFilterQuerySchema.pick({ search: true })),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0 });
    }

    const conditions = [] as ReturnType<typeof eq>[];
    if (orgIds) {
      conditions.push(inArray(savedFilters.orgId, orgIds));
    }

    const whereCondition = conditions.length ? and(...conditions) : undefined;

    const filters = await db
      .select()
      .from(savedFilters)
      .where(whereCondition)
      .orderBy(desc(savedFilters.createdAt));

    let results = filters;
    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((filter) => {
        const inName = filter.name.toLowerCase().includes(term);
        const inDescription = filter.description?.toLowerCase().includes(term) ?? false;
        return inName || inDescription;
      });
    }

    const data = results.map(mapFilterRow);

    return c.json({ data, total: data.length });
  }
);

// POST / - Create saved filter
filterRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createFilterSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    let orgId = payload.orgId;
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [filter] = await db
      .insert(savedFilters)
      .values({
        orgId: orgId!,
        name: payload.name,
        description: payload.description ?? null,
        conditions: payload.conditions,
        createdBy: auth.user.id
      })
      .returning();

    if (!filter) {
      return c.json({ error: 'Failed to create saved filter' }, 500);
    }

    writeRouteAudit(c, {
      orgId: filter.orgId,
      action: 'filter.create',
      resourceType: 'saved_filter',
      resourceId: filter.id,
      resourceName: filter.name
    });

    return c.json({ data: mapFilterRow(filter) }, 201);
  }
);

// GET /:id - Get single saved filter
filterRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', filterIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const filter = await getFilterWithAccess(id, auth);
    if (!filter) {
      return c.json({ error: 'Saved filter not found' }, 404);
    }

    return c.json({ data: mapFilterRow(filter) });
  }
);

// PATCH /:id - Update saved filter
filterRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', filterIdParamSchema),
  zValidator('json', updateSavedFilterSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const filter = await getFilterWithAccess(id, auth);
    if (!filter) {
      return c.json({ error: 'Saved filter not found' }, 404);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.description !== undefined) updates.description = payload.description;
    if (payload.conditions !== undefined) updates.conditions = payload.conditions;

    const [updated] = await db
      .update(savedFilters)
      .set(updates)
      .where(eq(savedFilters.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update saved filter' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'filter.update',
      resourceType: 'saved_filter',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(payload) }
    });

    return c.json({ data: mapFilterRow(updated) });
  }
);

// DELETE /:id - Delete saved filter
filterRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', filterIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const filter = await getFilterWithAccess(id, auth);
    if (!filter) {
      return c.json({ error: 'Saved filter not found' }, 404);
    }

    await db.delete(savedFilters).where(eq(savedFilters.id, id));

    writeRouteAudit(c, {
      orgId: filter.orgId,
      action: 'filter.delete',
      resourceType: 'saved_filter',
      resourceId: filter.id,
      resourceName: filter.name
    });

    return c.json({ data: mapFilterRow(filter) });
  }
);

// POST /:id/preview - Preview matching devices for saved filter
filterRoutes.post(
  '/:id/preview',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', filterIdParamSchema),
  zValidator('query', previewQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');

    const filter = await getFilterWithAccess(id, auth);
    if (!filter) {
      return c.json({ error: 'Saved filter not found' }, 404);
    }

    const preview = await evaluateFilterWithPreview(
      filter.conditions as FilterConditionGroup,
      { orgId: filter.orgId, previewLimit: query.limit }
    );

    writeRouteAudit(c, {
      orgId: filter.orgId,
      action: 'filter.saved.preview',
      resourceType: 'saved_filter',
      resourceId: filter.id,
      resourceName: filter.name,
      details: {
        totalCount: preview.totalCount,
        previewCount: preview.devices.length
      }
    });

    return c.json({
      data: {
        totalCount: preview.totalCount,
        devices: preview.devices.map((device) => ({
          id: device.id,
          hostname: device.hostname,
          displayName: device.displayName,
          osType: device.osType,
          status: device.status,
          lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null
        })),
        evaluatedAt: preview.evaluatedAt.toISOString()
      }
    });
  }
);
