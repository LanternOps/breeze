import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, like, desc, sql, gte, lte, or } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import { snmpTemplates, snmpDevices, snmpMetrics, snmpAlertThresholds } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { buildTopInterfaces } from '../services/snmpDashboardTopInterfaces';

// --- Helpers ---

function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function resolveOrgId(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 } as const;
    if (requestedOrgId && requestedOrgId !== auth.orgId) return { error: 'Access denied', status: 403 } as const;
    return { orgId: auth.orgId } as const;
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied', status: 403 } as const;
    }
    return { orgId: requestedOrgId } as const;
  }

  if (auth.scope === 'partner') {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && accessibleOrgIds.length === 1) {
      return { orgId: accessibleOrgIds[0] } as const;
    }
    return { error: 'orgId is required for partner scope', status: 400 } as const;
  }

  if (auth.scope === 'system' && !requestedOrgId) {
    return { error: 'orgId is required for system scope', status: 400 } as const;
  }

  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}

// --- Zod Schemas ---

const listTemplatesSchema = z.object({
  source: z.enum(['builtin', 'custom']).optional(),
  search: z.string().optional()
});

const dashboardQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
});

const oidSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  label: z.string().optional(),
  unit: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional()
});

const createTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  vendor: z.string().optional(),
  deviceType: z.string().optional(),
  oids: z.array(oidSchema)
});

const updateTemplateSchema = createTemplateSchema.partial();

const browseOidsSchema = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const validateOidsSchema = z.object({
  oids: z.array(
    z.object({
      id: z.string().optional(),
      oid: z.string().min(1),
      name: z.string().optional(),
      type: z.string().optional(),
      description: z.string().optional()
    })
  ).min(1)
});

type OidCatalogEntry = {
  oid: string;
  name: string;
  type: string;
  description: string;
};

const oidCatalog: OidCatalogEntry[] = [
  {
    oid: '1.3.6.1.2.1.1.1.0',
    name: 'sysDescr',
    type: 'OctetString',
    description: 'System description'
  },
  {
    oid: '1.3.6.1.2.1.1.3.0',
    name: 'sysUpTime',
    type: 'TimeTicks',
    description: 'Time since network management system was last initialized'
  },
  {
    oid: '1.3.6.1.2.1.1.5.0',
    name: 'sysName',
    type: 'OctetString',
    description: 'Device hostname'
  },
  {
    oid: '1.3.6.1.2.1.2.2.1.10',
    name: 'ifInOctets',
    type: 'Counter64',
    description: 'Inbound octets per interface'
  },
  {
    oid: '1.3.6.1.2.1.2.2.1.16',
    name: 'ifOutOctets',
    type: 'Counter64',
    description: 'Outbound octets per interface'
  },
  {
    oid: '1.3.6.1.2.1.25.3.3.1.2',
    name: 'hrProcessorLoad',
    type: 'Gauge',
    description: 'Host processor load'
  },
  {
    oid: '1.3.6.1.4.1.2021.4.6.0',
    name: 'memAvailableReal',
    type: 'Gauge',
    description: 'Available physical memory'
  },
  {
    oid: '1.3.6.1.4.1.2021.9.1.9',
    name: 'dskPercent',
    type: 'Gauge',
    description: 'Disk utilization percentage'
  }
];

function normalizeOidString(value: string): string {
  return value.trim().replace(/^\.+/, '');
}

function isNumericOid(value: string): boolean {
  return /^\d+(?:\.\d+)+$/.test(value);
}

// --- Router ---

const snmpRoutes = new Hono();
snmpRoutes.use('*', authMiddleware);

// ==================== DEVICE ROUTES ====================

const snmpDevicesDeprecationResponse = {
  error: 'SNMP device endpoints have been deprecated.',
  message: 'Manage SNMP monitoring via /monitoring/assets and /monitoring/assets/:id/snmp. On-demand poll and test operations are not yet available in the new API.'
} as const;

snmpRoutes.get('/devices', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.post('/devices', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.get('/devices/:id', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.patch('/devices/:id', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.delete('/devices/:id', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.post('/devices/:id/poll', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpDevicesDeprecationResponse, 410));
snmpRoutes.post('/devices/:id/test', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpDevicesDeprecationResponse, 410));

// ==================== TEMPLATE ROUTES ====================

snmpRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  async (c) => {
    const query = c.req.valid('query');
    const conditions: ReturnType<typeof eq>[] = [];

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
  zValidator('json', createTemplateSchema),
  async (c) => {
    const payload = c.req.valid('json');

    const [template] = await db.insert(snmpTemplates).values({
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
      orgId: c.get('auth').orgId,
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
  async (c) => {
    const templateId = c.req.param('id');
    const [template] = await db.select().from(snmpTemplates)
      .where(eq(snmpTemplates.id, templateId)).limit(1);
    if (!template) return c.json({ error: 'Template not found.' }, 404);

    return c.json({
      data: {
        id: template.id,
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
  zValidator('json', updateTemplateSchema),
  async (c) => {
    const templateId = c.req.param('id');
    const payload = c.req.valid('json');

    const [template] = await db.select().from(snmpTemplates)
      .where(eq(snmpTemplates.id, templateId)).limit(1);
    if (!template) return c.json({ error: 'Template not found.' }, 404);
    if (template.isBuiltIn) return c.json({ error: 'Built-in templates cannot be modified.' }, 400);

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
      orgId: c.get('auth').orgId,
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
  async (c) => {
    const templateId = c.req.param('id');

    const [template] = await db.select().from(snmpTemplates)
      .where(eq(snmpTemplates.id, templateId)).limit(1);
    if (!template) return c.json({ error: 'Template not found.' }, 404);
    if (template.isBuiltIn) return c.json({ error: 'Built-in templates cannot be deleted.' }, 400);

    const [removed] = await db.delete(snmpTemplates)
      .where(eq(snmpTemplates.id, templateId)).returning();
    if (!removed) {
      return c.json({ error: 'Failed to delete SNMP template.' }, 500);
    }

    writeRouteAudit(c, {
      orgId: c.get('auth').orgId,
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
  zValidator('query', browseOidsSchema),
  async (c) => {
    const { query = '', limit = 25 } = c.req.valid('query');
    const normalizedQuery = query.trim().toLowerCase();
    const candidates = new Map<string, {
      oid: string;
      name: string;
      type: string;
      description: string;
      source: 'catalog' | 'template';
      templateName?: string;
    }>();

    for (const entry of oidCatalog) {
      const normalizedOid = normalizeOidString(entry.oid);
      candidates.set(normalizedOid, {
        ...entry,
        oid: normalizedOid,
        source: 'catalog'
      });
    }

    const templates = await db.select({
      name: snmpTemplates.name,
      oids: snmpTemplates.oids
    }).from(snmpTemplates);

    for (const template of templates) {
      if (!Array.isArray(template.oids)) continue;

      for (const rawOid of template.oids as Array<Record<string, unknown>>) {
        const oid = normalizeOidString(String(rawOid.oid ?? ''));
        if (!oid) continue;

        const existing = candidates.get(oid);
        const mapped = {
          oid,
          name: String(rawOid.name ?? rawOid.label ?? existing?.name ?? 'Unnamed OID'),
          type: String(rawOid.type ?? existing?.type ?? 'Gauge'),
          description: String(rawOid.description ?? existing?.description ?? ''),
          source: existing?.source ?? 'template',
          templateName: existing?.templateName ?? template.name ?? undefined
        } as const;

        candidates.set(oid, mapped);
      }
    }

    const filtered = Array.from(candidates.values()).filter((entry) => {
      if (!normalizedQuery) return true;

      const haystack = `${entry.oid} ${entry.name} ${entry.description}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });

    return c.json({
      data: {
        total: filtered.length,
        results: filtered.slice(0, limit)
      }
    });
  }
);

snmpRoutes.post(
  '/oids/validate',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', validateOidsSchema),
  async (c) => {
    const payload = c.req.valid('json');
    const knownOids = new Set(oidCatalog.map((entry) => normalizeOidString(entry.oid)));
    const templates = await db.select({
      oids: snmpTemplates.oids
    }).from(snmpTemplates);

    for (const template of templates) {
      if (!Array.isArray(template.oids)) continue;
      for (const rawOid of template.oids as Array<Record<string, unknown>>) {
        knownOids.add(normalizeOidString(String(rawOid.oid ?? '')));
      }
    }

    const seen = new Set<string>();
    const results = payload.oids.map((item, index) => {
      const normalizedOid = normalizeOidString(item.oid);
      const errors: string[] = [];
      const warnings: string[] = [];

      if (!isNumericOid(normalizedOid)) {
        errors.push('OID must use dotted numeric format (e.g. 1.3.6.1.2.1.1.3.0).');
      }

      if (seen.has(normalizedOid)) {
        errors.push('Duplicate OID in template payload.');
      } else {
        seen.add(normalizedOid);
      }

      if (isNumericOid(normalizedOid) && !knownOids.has(normalizedOid)) {
        warnings.push('OID not found in catalog/templates. Verify this path exists on the target device.');
      }

      return {
        index,
        id: item.id,
        oid: item.oid,
        normalizedOid,
        valid: errors.length === 0,
        errors,
        warnings
      };
    });

    return c.json({
      data: {
        valid: results.every((result) => result.valid),
        results
      }
    });
  }
);

// ==================== METRIC ROUTES ====================

const snmpMetricsDeprecationResponse = {
  error: 'SNMP metric endpoints have been deprecated.',
  message: 'The /monitoring/assets/:id endpoint returns the 20 most recent metrics. Full metric history and per-OID queries are not yet available in the new API.'
} as const;

snmpRoutes.get('/metrics/:deviceId', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpMetricsDeprecationResponse, 410));
snmpRoutes.get('/metrics/:deviceId/history', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpMetricsDeprecationResponse, 410));
snmpRoutes.get('/metrics/:deviceId/:oid', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpMetricsDeprecationResponse, 410));

// ==================== THRESHOLD ROUTES ====================

const snmpThresholdDeprecationResponse = {
  error: 'SNMP threshold endpoints have been deprecated.',
  message: 'Thresholds have been deprecated. Manage SNMP polling via /monitoring/assets/:id/snmp. Use alert rules on network monitors via /monitors/alerts as an alternative.'
} as const;

snmpRoutes.get('/thresholds/:deviceId', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpThresholdDeprecationResponse, 410));
snmpRoutes.post('/thresholds', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpThresholdDeprecationResponse, 410));
snmpRoutes.patch('/thresholds/:id', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpThresholdDeprecationResponse, 410));
snmpRoutes.delete('/thresholds/:id', requireScope('organization', 'partner', 'system'), (c) => c.json(snmpThresholdDeprecationResponse, 410));

// ==================== DASHBOARD ROUTE ====================

snmpRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dashboardQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const orgFilter = orgResult.orgId ? eq(snmpDevices.orgId, orgResult.orgId) : undefined;

    // Device count
    const [deviceCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(snmpDevices)
      .where(orgFilter);

    // Template count
    const [templateCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(snmpTemplates);

    // Threshold count
    const thresholdCountQuery = orgFilter
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(snmpAlertThresholds)
          .innerJoin(snmpDevices, eq(snmpAlertThresholds.deviceId, snmpDevices.id))
          .where(orgFilter)
      : db.select({ count: sql<number>`count(*)` }).from(snmpAlertThresholds);
    const [thresholdCount] = await thresholdCountQuery;

    // Status counts
    const statusCounts = await db
      .select({
        status: snmpDevices.lastStatus,
        count: sql<number>`count(*)`
      })
      .from(snmpDevices)
      .where(orgFilter)
      .groupBy(snmpDevices.lastStatus);

    const status: Record<string, number> = {};
    for (const row of statusCounts) {
      status[row.status ?? 'unknown'] = Number(row.count);
    }

    // Template usage
    const templateUsage = await db
      .select({
        templateId: snmpDevices.templateId,
        name: snmpTemplates.name,
        deviceCount: sql<number>`count(*)`
      })
      .from(snmpDevices)
      .leftJoin(snmpTemplates, eq(snmpDevices.templateId, snmpTemplates.id))
      .where(orgFilter)
      .groupBy(snmpDevices.templateId, snmpTemplates.name);

    // Recent polls
    const recentPolls = await db
      .select({
        deviceId: snmpDevices.id,
        name: snmpDevices.name,
        lastPolledAt: snmpDevices.lastPolled,
        status: snmpDevices.lastStatus
      })
      .from(snmpDevices)
      .where(orgFilter)
      .orderBy(desc(snmpDevices.lastPolled))
      .limit(5);

    const interfaceWindowStart = new Date(Date.now() - 30 * 60 * 1000);
    const interfaceOidFilter = or(
      like(snmpMetrics.oid, '1.3.6.1.2.1.2.2.1.10%'),
      like(snmpMetrics.oid, '1.3.6.1.2.1.2.2.1.16%'),
      like(snmpMetrics.name, '%ifInOctets%'),
      like(snmpMetrics.name, '%ifOutOctets%')
    )!;
    const interfaceMetricFilter = orgFilter
      ? and(
          orgFilter,
          gte(snmpMetrics.timestamp, interfaceWindowStart),
          interfaceOidFilter
        )
      : and(
          gte(snmpMetrics.timestamp, interfaceWindowStart),
          interfaceOidFilter
        );

    const recentInterfaceMetrics = await db
      .select({
        deviceId: snmpMetrics.deviceId,
        deviceName: snmpDevices.name,
        oid: snmpMetrics.oid,
        name: snmpMetrics.name,
        value: snmpMetrics.value,
        timestamp: snmpMetrics.timestamp
      })
      .from(snmpMetrics)
      .innerJoin(snmpDevices, eq(snmpMetrics.deviceId, snmpDevices.id))
      .where(interfaceMetricFilter)
      .orderBy(desc(snmpMetrics.timestamp))
      .limit(3000);

    const topInterfaces = buildTopInterfaces(recentInterfaceMetrics, 5);

    return c.json({
      data: {
        totals: {
          devices: Number(deviceCount?.count ?? 0),
          templates: Number(templateCount?.count ?? 0),
          thresholds: Number(thresholdCount?.count ?? 0)
        },
        status,
        templateUsage: templateUsage.map((t) => ({
          templateId: t.templateId,
          name: t.name ?? 'Unassigned',
          deviceCount: Number(t.deviceCount)
        })),
        topInterfaces,
        recentPolls: recentPolls.map((p) => ({
          deviceId: p.deviceId,
          name: p.name,
          lastPolledAt: p.lastPolledAt?.toISOString() ?? null,
          status: p.status ?? 'offline'
        }))
      }
    });
  }
);

export { snmpRoutes };
