import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { db } from '../../db';
import { alertTemplates } from '../../db/schema';
import { eq, and, or, ilike, desc } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { listTemplatesSchema, createTemplateSchema, updateTemplateSchema } from './schemas';
import { resolveScopedOrgId, parseBoolean } from './helpers';
import { getPagination } from '../../utils/pagination';

export const templateRoutes = new Hono();

templateRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const query = c.req.valid('query');
      const conditions: ReturnType<typeof eq>[] = [];

      // Built-in templates (orgId IS NULL) + org's custom templates
      const scopeCondition = or(
        eq(alertTemplates.isBuiltIn, true),
        eq(alertTemplates.orgId, orgId)
      );

      const builtInFlag = parseBoolean(query.builtIn);
      if (builtInFlag !== undefined) {
        conditions.push(eq(alertTemplates.isBuiltIn, builtInFlag));
      }

      if (query.severity) {
        conditions.push(eq(alertTemplates.severity, query.severity));
      }

      if (query.search) {
        const search = `%${query.search}%`;
        conditions.push(
          or(
            ilike(alertTemplates.name, search),
            ilike(alertTemplates.description, search)
          )!
        );
      }

      const allConditions = scopeCondition
        ? [scopeCondition, ...conditions]
        : conditions;

      const rows = await db
        .select()
        .from(alertTemplates)
        .where(and(...allConditions))
        .orderBy(desc(alertTemplates.isBuiltIn), alertTemplates.name);

      const { page, limit, offset } = getPagination(query);
      return c.json({
        data: rows.slice(offset, offset + limit),
        page,
        limit,
        total: rows.length
      });
    } catch {
      return c.json({ error: 'Failed to list templates' }, 500);
    }
  }
);

templateRoutes.get(
  '/templates/built-in',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  async (c) => {
    try {
      const query = c.req.valid('query');
      const conditions: ReturnType<typeof eq>[] = [
        eq(alertTemplates.isBuiltIn, true)
      ];

      if (query.severity) {
        conditions.push(eq(alertTemplates.severity, query.severity));
      }

      if (query.search) {
        const search = `%${query.search}%`;
        conditions.push(
          or(
            ilike(alertTemplates.name, search),
            ilike(alertTemplates.description, search)
          )!
        );
      }

      const rows = await db
        .select()
        .from(alertTemplates)
        .where(and(...conditions))
        .orderBy(alertTemplates.name);

      const { page, limit, offset } = getPagination(query);
      return c.json({
        data: rows.slice(offset, offset + limit),
        page,
        limit,
        total: rows.length
      });
    } catch {
      return c.json({ error: 'Failed to list built-in templates' }, 500);
    }
  }
);

templateRoutes.post(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createTemplateSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const data = c.req.valid('json');
      const targets = data.targets && Object.keys(data.targets).length > 0
        ? data.targets
        : { scope: 'organization' };

      const [template] = await db
        .insert(alertTemplates)
        .values({
          orgId,
          name: data.name.trim(),
          description: data.description,
          category: data.category ?? 'Custom',
          conditions: data.conditions ?? {},
          severity: data.severity,
          titleTemplate: `{{deviceName}}: ${data.name.trim()}`,
          messageTemplate: `Alert triggered: ${data.name.trim()} on {{deviceName}} ({{hostname}}).`,
          targets,
          cooldownMinutes: data.defaultCooldownMinutes ?? 15,
          isBuiltIn: false,
        })
        .returning();

      if (!template) {
        return c.json({ error: 'Failed to create template' }, 500);
      }

      writeRouteAudit(c, {
        orgId,
        action: 'alert_template.create',
        resourceType: 'alert_template',
        resourceId: template.id,
        resourceName: template.name,
        details: {
          category: template.category,
          severity: template.severity,
        },
      });
      return c.json({ data: template }, 201);
    } catch {
      return c.json({ error: 'Failed to create template' }, 500);
    }
  }
);

templateRoutes.get(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const templateId = c.req.param('id')!;
      const [template] = await db
        .select()
        .from(alertTemplates)
        .where(
          and(
            eq(alertTemplates.id, templateId),
            or(
              eq(alertTemplates.isBuiltIn, true),
              eq(alertTemplates.orgId, orgId)
            )
          )
        )
        .limit(1);

      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      return c.json({ data: template });
    } catch {
      return c.json({ error: 'Failed to fetch template' }, 500);
    }
  }
);

templateRoutes.patch(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateTemplateSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const templateId = c.req.param('id')!;
      const updates = c.req.valid('json');

      // Check if template exists and is accessible
      const [existing] = await db
        .select()
        .from(alertTemplates)
        .where(eq(alertTemplates.id, templateId))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      if (existing.isBuiltIn) {
        return c.json({ error: 'Built-in templates cannot be modified' }, 403);
      }

      if (existing.orgId !== orgId) {
        return c.json({ error: 'Template not found' }, 404);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const setValues: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.name !== undefined) setValues.name = updates.name.trim();
      if (updates.description !== undefined) setValues.description = updates.description;
      if (updates.category !== undefined) setValues.category = updates.category;
      if (updates.severity !== undefined) setValues.severity = updates.severity;
      if (updates.conditions !== undefined) setValues.conditions = updates.conditions;
      if (updates.targets !== undefined) setValues.targets = updates.targets;
      if (updates.defaultCooldownMinutes !== undefined) setValues.cooldownMinutes = updates.defaultCooldownMinutes;

      const [updated] = await db
        .update(alertTemplates)
        .set(setValues)
        .where(eq(alertTemplates.id, templateId))
        .returning();

      writeRouteAudit(c, {
        orgId,
        action: 'alert_template.update',
        resourceType: 'alert_template',
        resourceId: templateId,
        resourceName: updated?.name ?? existing.name,
        details: { updatedFields: Object.keys(updates) },
      });
      return c.json({ data: updated });
    } catch {
      return c.json({ error: 'Failed to update template' }, 500);
    }
  }
);

templateRoutes.delete(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const templateId = c.req.param('id')!;

      const [existing] = await db
        .select()
        .from(alertTemplates)
        .where(eq(alertTemplates.id, templateId))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      if (existing.isBuiltIn) {
        return c.json({ error: 'Built-in templates cannot be deleted' }, 403);
      }

      if (existing.orgId !== orgId) {
        return c.json({ error: 'Template not found' }, 404);
      }

      await db
        .delete(alertTemplates)
        .where(eq(alertTemplates.id, templateId));

      writeRouteAudit(c, {
        orgId,
        action: 'alert_template.delete',
        resourceType: 'alert_template',
        resourceId: existing.id,
        resourceName: existing.name,
      });
      return c.json({ data: { id: templateId, deleted: true } });
    } catch {
      return c.json({ error: 'Failed to delete template' }, 500);
    }
  }
);
