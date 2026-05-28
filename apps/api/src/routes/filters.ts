import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { savedFilters, savedFilterFolders, savedFilterStars } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { evaluateFilterWithPreview, FilterConditionGroup } from '../services/filterEngine';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import {
  filterConditionGroupSchema,
  createSavedFilterSchema,
  updateSavedFilterSchema,
  savedFilterQuerySchema
} from '@breeze/shared/validators/filters';

const savedFilterScopeSchema = z.enum(['private', 'org', 'partner']);

export const filterRoutes = new Hono();
const requireFilterRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireFilterWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

type SavedFilterResponse = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  description: string | null;
  conditions: unknown;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  scope: 'private' | 'org' | 'partner';
  folderId: string | null;
  lastUsedAt: string | null;
  useCount: number;
  icon: string | null;
  color: string | null;
};

const filterIdParamSchema = z.object({
  id: z.string().uuid()
});

const createFilterSchema = createSavedFilterSchema.extend({
  orgId: z.string().uuid().optional(),
  scope: savedFilterScopeSchema.optional(),
  folderId: z.string().uuid().nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex')
    .nullable()
    .optional()
});

const updateFilterExtendedSchema = updateSavedFilterSchema.extend({
  scope: savedFilterScopeSchema.optional(),
  folderId: z.string().uuid().nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex')
    .nullable()
    .optional()
});

const folderIdParamSchema = z.object({
  id: z.string().uuid()
});

const createFolderSchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
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

// A saved_filter row is either org-scoped (orgId set) or partner-scoped (partnerId set).
// Partner-scoped rows are visible only to partner-scope callers from the same partner.
function canAccessFilter(
  filter: { orgId: string | null; partnerId: string | null },
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'canAccessOrg'>
): boolean {
  if (auth.scope === 'system') return true;
  if (filter.orgId) {
    if (auth.scope === 'organization') return auth.orgId === filter.orgId;
    if (auth.scope === 'partner') return auth.canAccessOrg(filter.orgId);
    return false;
  }
  if (filter.partnerId) {
    return auth.scope === 'partner' && auth.partnerId === filter.partnerId;
  }
  return false;
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
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [filter] = await db
    .select()
    .from(savedFilters)
    .where(eq(savedFilters.id, filterId))
    .limit(1);

  if (!filter) {
    return null;
  }

  if (!canAccessFilter(filter, auth)) {
    return null;
  }

  return filter;
}

function mapFilterRow(filter: typeof savedFilters.$inferSelect): SavedFilterResponse {
  return {
    id: filter.id,
    orgId: filter.orgId,
    partnerId: filter.partnerId,
    name: filter.name,
    description: filter.description ?? null,
    conditions: filter.conditions,
    createdBy: filter.createdBy ?? null,
    createdAt: filter.createdAt.toISOString(),
    updatedAt: filter.updatedAt.toISOString(),
    scope: filter.scope ?? 'private',
    folderId: filter.folderId ?? null,
    lastUsedAt: filter.lastUsedAt ? filter.lastUsedAt.toISOString() : null,
    useCount: filter.useCount ?? 0,
    icon: filter.icon ?? null,
    color: filter.color ?? null
  };
}

// POST /preview - Ad-hoc filter preview (no saved filter required)
filterRoutes.post(
  '/preview',
  requireScope('organization', 'partner', 'system'),
  requireFilterRead,
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
  requireFilterRead,
  zValidator('query', savedFilterQuerySchema.pick({ search: true }).extend({
    scope: savedFilterScopeSchema.optional(),
    folderId: z.string().uuid().nullable().optional()
  })),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    const hasOrgVisibility = orgIds && orgIds.length > 0;
    const hasPartnerVisibility = auth.scope === 'partner' && !!auth.partnerId;
    if (auth.scope !== 'system' && !hasOrgVisibility && !hasPartnerVisibility) {
      return c.json({ data: [], total: 0 });
    }

    // Visibility: org-scoped filters in accessible orgs PLUS partner-scoped
    // filters owned by the caller's partner. System scope sees all (no filter).
    const conditions: SQL[] = [];

    const visibilityClauses: SQL[] = [];
    if (hasOrgVisibility) visibilityClauses.push(inArray(savedFilters.orgId, orgIds!));
    if (hasPartnerVisibility) visibilityClauses.push(eq(savedFilters.partnerId, auth.partnerId!));
    if (visibilityClauses.length === 1) {
      conditions.push(visibilityClauses[0]);
    } else if (visibilityClauses.length > 1) {
      const combined = or(...visibilityClauses);
      if (combined) conditions.push(combined);
    }

    if (query.scope) {
      conditions.push(eq(savedFilters.scope, query.scope));
    }
    if (query.folderId !== undefined) {
      conditions.push(query.folderId === null
        ? isNull(savedFilters.folderId)
        : eq(savedFilters.folderId, query.folderId));
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
  requireFilterWrite,
  requireMfa(),
  zValidator('json', createFilterSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    let orgId: string | null = payload.orgId ?? null;
    let partnerId: string | null = null;
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        // No orgId specified → save as partner-wide filter visible across all the partner's orgs.
        if (!auth.partnerId) {
          return c.json({ error: 'Partner context required' }, 403);
        }
        partnerId = auth.partnerId;
      } else {
        const hasAccess = await ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [filter] = await db
      .insert(savedFilters)
      .values({
        orgId,
        partnerId,
        name: payload.name,
        description: payload.description ?? null,
        conditions: payload.conditions,
        createdBy: auth.user.id,
        scope: payload.scope ?? 'private',
        folderId: payload.folderId ?? null,
        icon: payload.icon ?? null,
        color: payload.color ?? null
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

// ============================================
// Folder CRUD (spec §3.2 - savedFilterFolders)
// MUST be registered BEFORE /:id routes so /folders is not matched as an id.
// ============================================

type SavedFilterFolderResponse = {
  id: string;
  orgId: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapFolderRow(row: typeof savedFilterFolders.$inferSelect): SavedFilterFolderResponse {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    parentId: row.parentId ?? null,
    sortOrder: row.sortOrder,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

// GET /folders - List folders visible to the caller
filterRoutes.get(
  '/folders',
  requireScope('organization', 'partner', 'system'),
  requireFilterRead,
  async (c) => {
    const auth = c.get('auth');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0 });
    }

    const where = orgIds
      ? inArray(savedFilterFolders.orgId, orgIds)
      : undefined;

    const rows = await db
      .select()
      .from(savedFilterFolders)
      .where(where)
      .orderBy(desc(savedFilterFolders.createdAt));

    return c.json({ data: rows.map(mapFolderRow), total: rows.length });
  }
);

// POST /folders - Create a folder
filterRoutes.post(
  '/folders',
  requireScope('organization', 'partner', 'system'),
  requireFilterWrite,
  requireMfa(),
  zValidator('json', createFolderSchema),
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
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    // Enforce one-level nesting: parent must have parentId IS NULL.
    if (payload.parentId) {
      const [parent] = await db
        .select()
        .from(savedFilterFolders)
        .where(eq(savedFilterFolders.id, payload.parentId))
        .limit(1);
      if (!parent) {
        return c.json({ error: 'Parent folder not found' }, 404);
      }
      if (parent.parentId !== null) {
        return c.json({ error: 'Folders can be nested at most one level deep' }, 400);
      }
    }

    const [folder] = await db
      .insert(savedFilterFolders)
      .values({
        orgId: orgId!,
        name: payload.name,
        parentId: payload.parentId ?? null,
        sortOrder: payload.sortOrder ?? 0,
        createdBy: auth.user.id
      })
      .returning();

    if (!folder) {
      return c.json({ error: 'Failed to create folder' }, 500);
    }

    writeRouteAudit(c, {
      orgId: folder.orgId,
      action: 'filter.folder.create',
      resourceType: 'saved_filter_folder',
      resourceId: folder.id,
      resourceName: folder.name
    });

    return c.json({ data: mapFolderRow(folder) }, 201);
  }
);

// DELETE /folders/:id - Delete a folder
filterRoutes.delete(
  '/folders/:id',
  requireScope('organization', 'partner', 'system'),
  requireFilterWrite,
  requireMfa(),
  zValidator('param', folderIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const [folder] = await db
      .select()
      .from(savedFilterFolders)
      .where(eq(savedFilterFolders.id, id))
      .limit(1);

    if (!folder) {
      return c.json({ error: 'Folder not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(folder.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Folder not found' }, 404);
    }

    await db.delete(savedFilterFolders).where(eq(savedFilterFolders.id, id));

    writeRouteAudit(c, {
      orgId: folder.orgId,
      action: 'filter.folder.delete',
      resourceType: 'saved_filter_folder',
      resourceId: folder.id,
      resourceName: folder.name
    });

    return c.json({ data: mapFolderRow(folder) });
  }
);

// ============================================
// Per-user stars (spec §3.2 - savedFilterStars)
// MUST be registered BEFORE /:id PATCH/DELETE so :id/star isn't shadowed.
// ============================================

filterRoutes.post(
  '/:id/star',
  requireScope('organization', 'partner', 'system'),
  requireFilterRead,
  zValidator('param', filterIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const filter = await getFilterWithAccess(id, auth);
    if (!filter) {
      return c.json({ error: 'Saved filter not found' }, 404);
    }

    await db
      .insert(savedFilterStars)
      .values({ userId: auth.user.id, filterId: id })
      .onConflictDoNothing();

    return c.json({ data: { userId: auth.user.id, filterId: id, starred: true } });
  }
);

filterRoutes.delete(
  '/:id/star',
  requireScope('organization', 'partner', 'system'),
  requireFilterRead,
  zValidator('param', filterIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    await db
      .delete(savedFilterStars)
      .where(and(eq(savedFilterStars.userId, auth.user.id), eq(savedFilterStars.filterId, id)));

    return c.json({ data: { userId: auth.user.id, filterId: id, starred: false } });
  }
);

// GET /:id - Get single saved filter
filterRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireFilterRead,
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
  requireFilterWrite,
  requireMfa(),
  zValidator('param', filterIdParamSchema),
  zValidator('json', updateFilterExtendedSchema),
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
    if (payload.scope !== undefined) updates.scope = payload.scope;
    if (payload.folderId !== undefined) updates.folderId = payload.folderId;
    if (payload.icon !== undefined) updates.icon = payload.icon;
    if (payload.color !== undefined) updates.color = payload.color;

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
  requireFilterWrite,
  requireMfa(),
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
  requireFilterRead,
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
