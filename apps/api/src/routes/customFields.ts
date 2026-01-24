import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db';

// Custom field schemas (defined locally to avoid rootDir issues)
// Must match the database enum: 'text', 'number', 'boolean', 'dropdown', 'date'
const customFieldTypeSchema = z.enum(['text', 'number', 'boolean', 'dropdown', 'date']);

const customFieldOptionsSchema = z.object({
  choices: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  pattern: z.string().optional(),
  placeholder: z.string().optional()
});

const createCustomFieldSchema = z.object({
  name: z.string().min(1).max(100),
  fieldKey: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, 'Field key must be lowercase alphanumeric with underscores'),
  type: customFieldTypeSchema,
  options: customFieldOptionsSchema.optional(),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  deviceTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional()
});

const updateCustomFieldSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  options: customFieldOptionsSchema.optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  deviceTypes: z.array(z.enum(['windows', 'macos', 'linux'])).nullable().optional()
});

const customFieldQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  deviceType: z.enum(['windows', 'macos', 'linux']).optional(),
  type: customFieldTypeSchema.optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50)
});
import { customFieldDefinitions, organizations } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const customFieldRoutes = new Hono();

type CustomFieldDefinition = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  fieldKey: string;
  type: string;
  options: unknown;
  required: boolean;
  defaultValue: unknown;
  deviceTypes: string[] | null;
  createdAt: string;
  updatedAt: string;
};

const customFieldIdParamSchema = z.object({
  id: z.string().uuid()
});

const createCustomFieldRequestSchema = createCustomFieldSchema.extend({
  orgId: z.string().uuid().optional(),
  partnerId: z.string().uuid().optional()
});

customFieldRoutes.use('*', authMiddleware);

async function ensureOrgAccess(
  orgId: string,
  auth: { scope: string; partnerId: string | null; orgId: string | null }
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, auth.partnerId as string)))
      .limit(1);

    return Boolean(org);
  }

  return true;
}

async function getOrgIdsForAuth(
  auth: { scope: string; partnerId: string | null; orgId: string | null }
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId as string));
    return partnerOrgs.map((org) => org.id);
  }

  return null;
}

function canEditField(
  field: typeof customFieldDefinitions.$inferSelect,
  auth: { scope: string; partnerId: string | null; orgId: string | null }
) {
  if (auth.scope === 'system') {
    return true;
  }

  if (field.orgId) {
    return auth.scope === 'organization'
      ? auth.orgId === field.orgId
      : auth.scope === 'partner'
        ? Boolean(auth.partnerId)
        : false;
  }

  if (field.partnerId) {
    return auth.scope === 'partner' && auth.partnerId === field.partnerId;
  }

  return false;
}

async function getCustomFieldWithAccess(
  fieldId: string,
  auth: { scope: string; partnerId: string | null; orgId: string | null }
) {
  const [field] = await db
    .select()
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.id, fieldId))
    .limit(1);

  if (!field) {
    return null;
  }

  if (field.orgId) {
    const hasAccess = await ensureOrgAccess(field.orgId, auth);
    if (!hasAccess) {
      return null;
    }
  } else if (field.partnerId) {
    if (auth.scope !== 'system' && auth.partnerId !== field.partnerId) {
      return null;
    }
  } else if (auth.scope !== 'system') {
    return null;
  }

  return field;
}

function mapCustomFieldRow(
  field: typeof customFieldDefinitions.$inferSelect
): CustomFieldDefinition {
  return {
    id: field.id,
    orgId: field.orgId,
    partnerId: field.partnerId,
    name: field.name,
    fieldKey: field.fieldKey,
    type: field.type,
    options: field.options ?? null,
    required: field.required,
    defaultValue: field.defaultValue ?? null,
    deviceTypes: field.deviceTypes ?? null,
    createdAt: field.createdAt.toISOString(),
    updatedAt: field.updatedAt.toISOString()
  };
}

// GET / - List custom field definitions
customFieldRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
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

    let results = fields;
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
  zValidator('json', createCustomFieldRequestSchema),
  async (c) => {
    const auth = c.get('auth');
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
        partnerId = auth.partnerId;
      }
    } else if (!orgId && !partnerId) {
      return c.json({ error: 'orgId or partnerId is required' }, 400);
    }

    const [field] = await db
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
        deviceTypes: payload.deviceTypes
      })
      .returning();

    if (!field) {
      return c.json({ error: 'Failed to create custom field' }, 500);
    }

    return c.json({ data: mapCustomFieldRow(field) }, 201);
  }
);

// PATCH /:id - Update custom field definition
customFieldRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', customFieldIdParamSchema),
  zValidator('json', updateCustomFieldSchema),
  async (c) => {
    const auth = c.get('auth');
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

    const [updated] = await db
      .update(customFieldDefinitions)
      .set(updates)
      .where(eq(customFieldDefinitions.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update custom field' }, 500);
    }

    return c.json({ data: mapCustomFieldRow(updated) });
  }
);

// DELETE /:id - Delete custom field definition
customFieldRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', customFieldIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const field = await getCustomFieldWithAccess(id, auth);
    if (!field) {
      return c.json({ error: 'Custom field not found' }, 404);
    }

    if (!canEditField(field, auth)) {
      return c.json({ error: 'Access to this custom field denied' }, 403);
    }

    await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, id));

    return c.json({ data: mapCustomFieldRow(field) });
  }
);
