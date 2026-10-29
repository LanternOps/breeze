import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import { customFieldWriteConflict } from '../services/customFields/writeErrors';
import {
  canEditField,
  createCustomFieldSchema,
  customFieldTypeSchema,
  ensureOrgAccess,
  getCustomFieldWithAccess,
  mapCustomFieldRow,
  updateCustomFieldSchema,
} from '../services/customFields/definitionAdmin';

const customFieldQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceType: z.enum(['windows', 'macos', 'linux']).optional(),
  type: customFieldTypeSchema.optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50)
});
import { customFieldDefinitions } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import {
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  canManagePartnerWidePolicies,
} from '../services/partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';

export const customFieldRoutes = new Hono();
const requireCustomFieldRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireCustomFieldWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

const customFieldIdParamSchema = z.object({
  id: z.string().guid()
});

const createCustomFieldRequestSchema = createCustomFieldSchema.extend({
  orgId: z.string().guid().optional(),
  partnerId: z.string().guid().optional()
});

customFieldRoutes.use('*', authMiddleware);

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


// GET / - List custom field definitions
customFieldRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldRead,
  zValidator('query', customFieldQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions = [] as ReturnType<typeof eq>[];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ data: [], total: 0 });
      }
      const scopeConditions = [eq(customFieldDefinitions.orgId, auth.orgId)];
      if (auth.partnerId) {
        scopeConditions.push(eq(customFieldDefinitions.partnerId, auth.partnerId));
      }
      conditions.push(or(...scopeConditions) as ReturnType<typeof eq>);
    } else if (auth.scope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ data: [], total: 0 });
      }
      const partnerCondition = eq(customFieldDefinitions.partnerId, auth.partnerId);
      const orgIds = await getOrgIdsForAuth(auth);
      if (orgIds && orgIds.length > 0) {
        conditions.push(
          or(partnerCondition, inArray(customFieldDefinitions.orgId, orgIds)) as ReturnType<typeof eq>
        );
      } else {
        conditions.push(partnerCondition);
      }
    }

    if (query.type) {
      conditions.push(eq(customFieldDefinitions.type, query.type));
    }

    const whereCondition = conditions.length ? and(...conditions) : undefined;

    const fields = await db
      .select()
      .from(customFieldDefinitions)
      .where(whereCondition)
      .orderBy(desc(customFieldDefinitions.createdAt));

    // #7572: alphabetical by display name for every consumer (settings page,
    // device details, filters). Done in JS — Postgres collation is deployment-
    // dependent. There is no explicit position column, so name is the sole key;
    // fieldKey then id make the order deterministic for equal names.
    let results = [...fields].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
        a.fieldKey.localeCompare(b.fieldKey) ||
        a.id.localeCompare(b.id)
    );
    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((field) =>
        field.name.toLowerCase().includes(term) || field.fieldKey.toLowerCase().includes(term)
      );
    }

    const data = results.map((field) => mapCustomFieldRow(field));

    return c.json({ data, total: data.length });
  }
);

// GET /:id - Get custom field definition
customFieldRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldRead,
  zValidator('param', customFieldIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const field = await getCustomFieldWithAccess(id, auth);
    if (!field) {
      return c.json({ error: 'Custom field not found' }, 404);
    }

    return c.json({ data: mapCustomFieldRow(field) });
  }
);

// POST / - Create custom field definition
customFieldRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldWrite,
  requireMfa(),
  zValidator('json', createCustomFieldRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    // A definition is an org-wide (or partner-wide) governance object with no
    // per-site ownership model — same capability class as
    // `canMutateOrgWideGovernance`'s other objects, even though this table
    // isn't in that contract's hand-listed set yet.
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const payload = c.req.valid('json');

    if (payload.orgId && payload.partnerId) {
      return c.json({ error: 'Provide either orgId or partnerId, not both' }, 400);
    }

    let orgId = payload.orgId ?? null;
    let partnerId = payload.partnerId ?? null;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
      partnerId = null;
    } else if (auth.scope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner context required' }, 403);
      }
      if (partnerId && partnerId !== auth.partnerId) {
        return c.json({ error: 'Access to this partner denied' }, 403);
      }
      if (orgId) {
        const hasAccess = await ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        partnerId = null;
      } else {
        // Partner-wide definition (org_id NULL) — capability gate, not just
        // scope (epic #2135; security review 2026-08-16 §1.1 #1).
        if (!canManagePartnerWidePolicies(auth)) {
          return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
        }
        partnerId = auth.partnerId;
      }
    } else if (!orgId && !partnerId) {
      return c.json({ error: 'orgId or partnerId is required' }, 400);
    }

    let field;
    try {
      [field] = await db
        .insert(customFieldDefinitions)
        .values({
          orgId,
          partnerId,
          name: payload.name,
          fieldKey: payload.fieldKey,
          type: payload.type,
          options: payload.options,
          required: payload.required,
          defaultValue: payload.defaultValue,
          deviceTypes: payload.deviceTypes,
          scriptWrite: payload.scriptWrite
        })
        .returning();
    } catch (err) {
      // Both mapped conditions are the caller's own to fix and neither is a
      // server fault, so neither may surface as a 500. The mapping itself lives
      // in services/customFields/writeErrors.ts because the definitions
      // importer (#3257 W07) needs the identical one per row — see that
      // module's header for what each SQLSTATE means and why only one of the
      // two messages may be passed through verbatim.
      const conflict = customFieldWriteConflict(err, payload.fieldKey);
      if (conflict) {
        return c.json(conflict, 409);
      }
      throw err;
    }

    if (!field) {
      return c.json({ error: 'Failed to create custom field' }, 500);
    }

    writeRouteAudit(c, {
      orgId: field.orgId ?? auth.orgId,
      action: 'custom_field.create',
      resourceType: 'custom_field',
      resourceId: field.id,
      resourceName: field.name,
      details: { fieldKey: field.fieldKey, type: field.type }
    });

    return c.json({ data: mapCustomFieldRow(field) }, 201);
  }
);

// PATCH /:id - Update custom field definition
customFieldRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldWrite,
  requireMfa(),
  zValidator('param', customFieldIdParamSchema),
  zValidator('json', updateCustomFieldSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const field = await getCustomFieldWithAccess(id, auth);
    if (!field) {
      return c.json({ error: 'Custom field not found' }, 404);
    }

    if (!canEditField(field, auth)) {
      return c.json({ error: 'Access to this custom field denied' }, 403);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.options !== undefined) updates.options = payload.options;
    if (payload.required !== undefined) updates.required = payload.required;
    if (payload.defaultValue !== undefined) updates.defaultValue = payload.defaultValue;
    if (payload.deviceTypes !== undefined) updates.deviceTypes = payload.deviceTypes;
    if (payload.scriptWrite !== undefined) updates.scriptWrite = payload.scriptWrite;

    const [updated] = await db
      .update(customFieldDefinitions)
      .set(updates)
      .where(eq(customFieldDefinitions.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update custom field' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId ?? auth.orgId,
      action: 'custom_field.update',
      resourceType: 'custom_field',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(payload) }
    });

    return c.json({ data: mapCustomFieldRow(updated) });
  }
);

// DELETE /:id - Delete custom field definition
customFieldRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldWrite,
  requireMfa(),
  zValidator('param', customFieldIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const { id } = c.req.valid('param');

    const field = await getCustomFieldWithAccess(id, auth);
    if (!field) {
      return c.json({ error: 'Custom field not found' }, 404);
    }

    if (!canEditField(field, auth)) {
      return c.json({ error: 'Access to this custom field denied' }, 403);
    }

    await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, id));

    writeRouteAudit(c, {
      orgId: field.orgId ?? auth.orgId,
      action: 'custom_field.delete',
      resourceType: 'custom_field',
      resourceId: field.id,
      resourceName: field.name
    });

    return c.json({ data: mapCustomFieldRow(field) });
  }
);
