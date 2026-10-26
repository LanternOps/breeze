import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, inArray, like, desc, sql, gte, lte, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { db } from '../db';
import { discoveredAssets, snmpTemplates, snmpDevices, snmpMetrics, snmpAlertThresholds } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { loadSnmpDashboard } from '../services/snmpDashboard';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';

import {
  browseOidRows, canMutateTemplate, createTemplateSchema, dashboardQuerySchema, browseOidsSchema, escapeLikePattern,
  listTemplatesSchema, resolveOrgId, templateVisibilityCondition, updateTemplateSchema, validateOidRows, validateOidsSchema,
} from '../services/snmpTemplates';


// --- Router ---

const snmpRoutes = new Hono();
const requireSnmpRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireSnmpWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
snmpRoutes.use('*', authMiddleware);

// ==================== DEVICE ROUTES ====================

const snmpDevicesDeprecationResponse = {
  error: 'SNMP device endpoints have been deprecated.',
  message: 'Manage SNMP monitoring via /monitoring/assets and /monitoring/assets/:id/snmp. On-demand poll and test operations are not yet available in the new API.'
} as const;

snmpRoutes.get('/devices', requireScope('organization', 'partner', 'system'), requireSnmpRead, (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.post('/devices', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.get('/devices/:id', requireScope('organization', 'partner', 'system'), requireSnmpRead, (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.patch('/devices/:id', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.delete('/devices/:id', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.post('/devices/:id/poll', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.post('/devices/:id/test', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpDevicesDeprecationResponse, 410));

// ==================== TEMPLATE ROUTES ====================

snmpRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  requireSnmpRead,
  zValidator('query', listTemplatesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const visibility = templateVisibilityCondition(auth, query.orgId);
    if (visibility.error) return c.json({ error: visibility.error }, visibility.status ?? 403);
    const conditions: SQL[] = [];

    if (visibility.condition) conditions.push(visibility.condition);

    if (query.source === 'builtin') conditions.push(eq(snmpTemplates.isBuiltIn, true));
    else if (query.source === 'custom') conditions.push(eq(snmpTemplates.isBuiltIn, false));

    if (query.search) {
      const escaped = escapeLikePattern(query.search);
      conditions.push(
        or(
          like(snmpTemplates.name, `%${escaped}%`),
          like(snmpTemplates.vendor, `%${escaped}%`),
          like(snmpTemplates.deviceType, `%${escaped}%`)
        )!
      );
    }

    const where = conditions.length ? and(...conditions) : undefined;
    const results = await db.select().from(snmpTemplates).where(where).orderBy(desc(snmpTemplates.createdAt));

    return c.json({
      data: results.map((t) => ({
        id: t.id,
        orgId: t.orgId,
        name: t.name,
        description: t.description,
        source: t.isBuiltIn ? 'builtin' : 'custom',
        vendor: t.vendor,
        deviceClass: t.deviceType,
        oids: t.oids as any[],
        oidCount: Array.isArray(t.oids) ? (t.oids as any[]).length : 0,
        createdAt: t.createdAt.toISOString()
      }))
    });
  }
);

snmpRoutes.post(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  requireSnmpWrite,
  requireMfa(),
  zValidator('json', createTemplateSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth, payload.orgId, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [template] = await db.insert(snmpTemplates).values({
      orgId: orgResult.orgId!,
      name: payload.name,
      description: payload.description ?? null,
      vendor: payload.vendor ?? null,
      deviceType: payload.deviceType ?? null,
      oids: payload.oids,
      isBuiltIn: false
    }).returning();
    if (!template) {
      return c.json({ error: 'Failed to create SNMP template.' }, 500);
    }

    writeRouteAudit(c, {
      orgId: template.orgId,
      action: 'snmp.template.create',
      resourceType: 'snmp_template',
      resourceId: template.id,
      resourceName: template.name,
      details: {
        oidCount: Array.isArray(template.oids) ? template.oids.length : 0,
      },
    });

    return c.json({
      data: {
        id: template.id,
        orgId: template.orgId,
        name: template.name,
        description: template.description,
        source: 'custom',
        vendor: template.vendor,
        deviceClass: template.deviceType,
        oids: template.oids,
        createdAt: template.createdAt.toISOString()
      }
    }, 201);
  }
);

snmpRoutes.get(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  requireSnmpRead,
  async (c) => {
    const auth = c.get('auth');
    const templateId = c.req.param('id')!;
    const visibility = templateVisibilityCondition(auth);
    if (visibility.error) return c.json({ error: visibility.error }, visibility.status ?? 403);
    const conditions: SQL[] = [eq(snmpTemplates.id, templateId)];
    if (visibility.condition) conditions.push(visibility.condition);

    const [template] = await db.select().from(snmpTemplates)
      .where(and(...conditions)).limit(1);
    if (!template) return c.json({ error: 'Template not found.' }, 404);

    return c.json({
      data: {
        id: template.id,
        orgId: template.orgId,
        name: template.name,
        description: template.description,
        source: template.isBuiltIn ? 'builtin' : 'custom',
        vendor: template.vendor,
        deviceClass: template.deviceType,
        oids: template.oids,
        createdAt: template.createdAt.toISOString()
      }
    });
  }
);

snmpRoutes.patch(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  requireSnmpWrite,
  requireMfa(),
  zValidator('json', updateTemplateSchema),
  async (c) => {
    const auth = c.get('auth');
    const templateId = c.req.param('id')!;
    const payload = c.req.valid('json');

    const [template] = await db.select().from(snmpTemplates)
      .where(eq(snmpTemplates.id, templateId)).limit(1);
    if (!template) return c.json({ error: 'Template not found.' }, 404);
    if (template.isBuiltIn) return c.json({ error: 'Built-in templates cannot be modified.' }, 400);
    if (!canMutateTemplate(auth, template)) return c.json({ error: 'Access denied' }, 403);

    const updates: Record<string, unknown> = {};
    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.description !== undefined) updates.description = payload.description;
    if (payload.vendor !== undefined) updates.vendor = payload.vendor;
    if (payload.deviceType !== undefined) updates.deviceType = payload.deviceType;
    if (payload.oids !== undefined) updates.oids = payload.oids;

    const [updated] = await db.update(snmpTemplates)
      .set(updates)
      .where(eq(snmpTemplates.id, templateId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to update SNMP template.' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId ?? c.get('auth').orgId,
      action: 'snmp.template.update',
      resourceType: 'snmp_template',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(updates),
      },
    });

    return c.json({
      data: {
        id: updated.id,
        orgId: updated.orgId,
        name: updated.name,
        description: updated.description,
        source: 'custom',
        vendor: updated.vendor,
        deviceClass: updated.deviceType,
        oids: updated.oids,
        createdAt: updated.createdAt.toISOString()
      }
    });
  }
);

snmpRoutes.delete(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  requireSnmpWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const templateId = c.req.param('id')!;

    const [template] = await db.select().from(snmpTemplates)
      .where(eq(snmpTemplates.id, templateId)).limit(1);
    if (!template) return c.json({ error: 'Template not found.' }, 404);
    if (template.isBuiltIn) return c.json({ error: 'Built-in templates cannot be deleted.' }, 400);
    if (!canMutateTemplate(auth, template)) return c.json({ error: 'Access denied' }, 403);

    const [removed] = await db.delete(snmpTemplates)
      .where(eq(snmpTemplates.id, templateId)).returning();
    if (!removed) {
      return c.json({ error: 'Failed to delete SNMP template.' }, 500);
    }

    writeRouteAudit(c, {
      orgId: removed.orgId ?? c.get('auth').orgId,
      action: 'snmp.template.delete',
      resourceType: 'snmp_template',
      resourceId: removed.id,
      resourceName: removed.name,
    });

    return c.json({ data: removed });
  }
);

snmpRoutes.get(
  '/oids/browse',
  requireScope('organization', 'partner', 'system'),
  requireSnmpRead,
  zValidator('query', browseOidsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { query = '', limit = 25 } = c.req.valid('query');
    const visibility = templateVisibilityCondition(auth);
    if (visibility.error) return c.json({ error: visibility.error }, visibility.status ?? 403);
    const templates = await db.select({
      name: snmpTemplates.name,
      oids: snmpTemplates.oids
    }).from(snmpTemplates).where(visibility.condition);

    return c.json({ data: browseOidRows(templates, query, limit) });
  }
);

snmpRoutes.post(
  '/oids/validate',
  requireScope('organization', 'partner', 'system'),
  requireSnmpRead,
  zValidator('json', validateOidsSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const visibility = templateVisibilityCondition(auth);
    if (visibility.error) return c.json({ error: visibility.error }, visibility.status ?? 403);
    const templates = await db.select({
      oids: snmpTemplates.oids
    }).from(snmpTemplates).where(visibility.condition);

    return c.json({ data: validateOidRows(templates, payload.oids) });
  }
);

// ==================== METRIC ROUTES ====================

const snmpMetricsDeprecationResponse = {
  error: 'SNMP metric endpoints have been deprecated.',
  message: 'The /monitoring/assets/:id endpoint returns the 20 most recent metrics. Full metric history and per-OID queries are not yet available in the new API.'
} as const;

snmpRoutes.get('/metrics/:deviceId', requireScope('organization', 'partner', 'system'), requireSnmpRead, (c) => c.json(snmpMetricsDeprecationResponse, 410));
snmpRoutes.get('/metrics/:deviceId/history', requireScope('organization', 'partner', 'system'), requireSnmpRead, (c) => c.json(snmpMetricsDeprecationResponse, 410));
snmpRoutes.get('/metrics/:deviceId/:oid', requireScope('organization', 'partner', 'system'), requireSnmpRead, (c) => c.json(snmpMetricsDeprecationResponse, 410));

// ==================== THRESHOLD ROUTES ====================

const snmpThresholdDeprecationResponse = {
  error: 'SNMP threshold endpoints have been deprecated.',
  message: 'Thresholds have been deprecated. Manage SNMP polling via /monitoring/assets/:id/snmp. Use alert rules on network monitors via /monitors/alerts as an alternative.'
} as const;

snmpRoutes.get('/thresholds/:deviceId', requireScope('organization', 'partner', 'system'), requireSnmpRead, (c) => c.json(snmpThresholdDeprecationResponse, 410));
snmpRoutes.post('/thresholds', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpThresholdDeprecationResponse, 410));
snmpRoutes.patch('/thresholds/:id', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpThresholdDeprecationResponse, 410));
snmpRoutes.delete('/thresholds/:id', requireScope('organization', 'partner', 'system'), requireSnmpWrite, requireMfa(), (c) => c.json(snmpThresholdDeprecationResponse, 410));

// ==================== DASHBOARD ROUTE ====================

snmpRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  requireSnmpRead,
  zValidator('query', dashboardQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const templateVisibility = templateVisibilityCondition(auth, orgResult.orgId ?? undefined);
    if (templateVisibility.error) return c.json({ error: templateVisibility.error }, templateVisibility.status ?? 403);

    const dashboard = await loadSnmpDashboard({
      orgId: orgResult.orgId,
      templateCondition: templateVisibility.condition,
      allowedSiteIds: perms?.allowedSiteIds,
    });
    return c.json(dashboard);
  }
);

export { snmpRoutes };
