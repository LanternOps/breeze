import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'crypto';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import type { AlertTemplateTarget, AlertTemplate } from './schemas';
import { listTemplatesSchema, createTemplateSchema, updateTemplateSchema } from './schemas';
import { builtInTemplates, customTemplates, customTemplateOrgById } from './data';
import { resolveScopedOrgId, paginate, parseBoolean, getAllTemplates, getTemplateById, isBuiltInTemplate } from './helpers';

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
      let data = getAllTemplates(orgId);

      if (query.builtIn) {
        const builtInFlag = parseBoolean(query.builtIn);
        if (builtInFlag !== undefined) {
          data = data.filter((template) => template.builtIn === builtInFlag);
        }
      }

      if (query.severity) {
        data = data.filter((template) => template.severity === query.severity);
      }

      if (query.search) {
        const search = query.search.toLowerCase();
        data = data.filter((template) =>
          template.name.toLowerCase().includes(search) ||
          (template.description ?? '').toLowerCase().includes(search)
        );
      }

      const result = paginate(data, query);
      return c.json(result);
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
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const query = c.req.valid('query');
      let data = builtInTemplates;

      if (query.severity) {
        data = data.filter((template) => template.severity === query.severity);
      }

      if (query.search) {
        const search = query.search.toLowerCase();
        data = data.filter((template) =>
          template.name.toLowerCase().includes(search) ||
          (template.description ?? '').toLowerCase().includes(search)
        );
      }

      const result = paginate(data, query);
      return c.json(result);
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
      const targets: AlertTemplateTarget = data.targets && Object.keys(data.targets).length > 0
        ? data.targets as AlertTemplateTarget
        : { scope: 'organization' };
      const template: AlertTemplate = {
        id: randomUUID(),
        name: data.name.trim(),
        description: data.description,
        category: data.category ?? 'Custom',
        severity: data.severity,
        builtIn: false,
        conditions: data.conditions ?? {},
        targets,
        defaultCooldownMinutes: data.defaultCooldownMinutes ?? 15,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      customTemplates.set(template.id, template);
      customTemplateOrgById.set(template.id, orgId);
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

      const templateId = c.req.param('id');
      const template = getTemplateById(templateId, orgId);

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

      const templateId = c.req.param('id');
      const updates = c.req.valid('json');

      if (isBuiltInTemplate(templateId)) {
        return c.json({ error: 'Built-in templates cannot be modified' }, 403);
      }

      const existing = customTemplates.get(templateId);
      if (customTemplateOrgById.get(templateId) !== orgId) {
        return c.json({ error: 'Template not found' }, 404);
      }
      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const updated: AlertTemplate = {
        ...existing,
        name: updates.name?.trim() ?? existing.name,
        description: updates.description ?? existing.description,
        category: updates.category ?? existing.category,
        severity: updates.severity ?? existing.severity,
        conditions: updates.conditions ?? existing.conditions,
        targets: (updates.targets as AlertTemplateTarget | undefined) ?? existing.targets,
        defaultCooldownMinutes: updates.defaultCooldownMinutes ?? existing.defaultCooldownMinutes,
        updatedAt: new Date()
      };

      customTemplates.set(templateId, updated);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_template.update',
        resourceType: 'alert_template',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          updatedFields: Object.keys(updates),
        },
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

      const templateId = c.req.param('id');

      if (isBuiltInTemplate(templateId)) {
        return c.json({ error: 'Built-in templates cannot be deleted' }, 403);
      }

      const existing = customTemplates.get(templateId);
      if (customTemplateOrgById.get(templateId) !== orgId) {
        return c.json({ error: 'Template not found' }, 404);
      }
      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      customTemplates.delete(templateId);
      customTemplateOrgById.delete(templateId);
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
