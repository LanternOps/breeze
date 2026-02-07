import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, like, desc, sql, gte, lte, or } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import { snmpTemplates, snmpDevices, snmpMetrics, snmpAlertThresholds, devices } from '../db/schema';
import { enqueueSnmpPoll, buildSnmpPollCommand } from '../jobs/snmpWorker';
import { isRedisAvailable } from '../services/redis';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { writeRouteAudit } from '../services/auditEvents';

// --- Helpers ---

function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function resolveOrgId(
  auth: { scope: string; orgId: string | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 } as const;
    if (requestedOrgId && requestedOrgId !== auth.orgId) return { error: 'Access denied', status: 403 } as const;
    return { orgId: auth.orgId } as const;
  }
  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  return { orgId: requestedOrgId ?? null } as const;
}

// --- Zod Schemas ---

const listDevicesSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['online', 'offline', 'warning', 'maintenance']).optional(),
  templateId: z.string().uuid().optional(),
  search: z.string().optional()
});

const createDeviceSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1),
  ipAddress: z.string().min(1),
  snmpVersion: z.enum(['v1', 'v2c', 'v3']),
  port: z.number().int().positive().optional(),
  community: z.string().optional(),
  username: z.string().optional(),
  authProtocol: z.string().optional(),
  authPassword: z.string().optional(),
  privProtocol: z.string().optional(),
  privPassword: z.string().optional(),
  templateId: z.string().uuid().optional(),
  pollingInterval: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional()
});

const updateDeviceSchema = createDeviceSchema.partial().omit({ orgId: true });

const listTemplatesSchema = z.object({
  source: z.enum(['builtin', 'custom']).optional(),
  search: z.string().optional()
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

const metricsHistorySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  interval: z.enum(['5m', '15m', '1h', '6h', '1d']).optional()
});

const createThresholdSchema = z.object({
  deviceId: z.string().uuid(),
  oid: z.string().min(1),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
  threshold: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  message: z.string().optional(),
  isActive: z.boolean().optional()
});

const updateThresholdSchema = createThresholdSchema.partial().omit({ deviceId: true });

// --- Router ---

const snmpRoutes = new Hono();
snmpRoutes.use('*', authMiddleware);

// ==================== DEVICE ROUTES ====================

snmpRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgResult.orgId) conditions.push(eq(snmpDevices.orgId, orgResult.orgId));
    if (query.status) conditions.push(eq(snmpDevices.lastStatus, query.status));
    if (query.templateId) conditions.push(eq(snmpDevices.templateId, query.templateId));
    if (query.search) {
      const escaped = escapeLikePattern(query.search);
      conditions.push(
        or(
          like(snmpDevices.name, `%${escaped}%`),
          like(snmpDevices.ipAddress, `%${escaped}%`)
        )!
      );
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const results = await db
      .select({
        id: snmpDevices.id,
        orgId: snmpDevices.orgId,
        name: snmpDevices.name,
        ipAddress: snmpDevices.ipAddress,
        snmpVersion: snmpDevices.snmpVersion,
        port: snmpDevices.port,
        templateId: snmpDevices.templateId,
        isActive: snmpDevices.isActive,
        lastPolled: snmpDevices.lastPolled,
        lastStatus: snmpDevices.lastStatus,
        pollingInterval: snmpDevices.pollingInterval,
        createdAt: snmpDevices.createdAt,
        templateName: snmpTemplates.name
      })
      .from(snmpDevices)
      .leftJoin(snmpTemplates, eq(snmpDevices.templateId, snmpTemplates.id))
      .where(where)
      .orderBy(desc(snmpDevices.createdAt));

    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(snmpDevices)
      .where(where);

    return c.json({
      data: results.map((d) => ({
        id: d.id,
        name: d.name,
        ipAddress: d.ipAddress,
        status: d.lastStatus ?? 'offline',
        templateId: d.templateId,
        templateName: d.templateName,
        snmpVersion: d.snmpVersion,
        port: d.port,
        isActive: d.isActive,
        pollingInterval: d.pollingInterval,
        lastPolledAt: d.lastPolled?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString()
      })),
      total: Number(total[0]?.count ?? 0)
    });
  }
);

snmpRoutes.post(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth, payload.orgId, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    if (payload.templateId) {
      const [tmpl] = await db.select({ id: snmpTemplates.id }).from(snmpTemplates)
        .where(eq(snmpTemplates.id, payload.templateId)).limit(1);
      if (!tmpl) return c.json({ error: 'Template not found.' }, 400);
    }

    const [device] = await db.insert(snmpDevices).values({
      orgId: orgResult.orgId!,
      name: payload.name,
      ipAddress: payload.ipAddress,
      snmpVersion: payload.snmpVersion,
      port: payload.port ?? 161,
      community: payload.community,
      username: payload.username,
      authProtocol: payload.authProtocol,
      authPassword: payload.authPassword,
      privProtocol: payload.privProtocol,
      privPassword: payload.privPassword,
      templateId: payload.templateId ?? null,
      pollingInterval: payload.pollingInterval ?? 300,
      isActive: true,
      lastStatus: 'offline'
    }).returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'snmp.device.create',
      resourceType: 'snmp_device',
      resourceId: device.id,
      resourceName: device.name,
      details: {
        ipAddress: device.ipAddress,
        snmpVersion: device.snmpVersion,
        templateId: device.templateId,
      },
    });

    return c.json({ data: device }, 201);
  }
);

snmpRoutes.get(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) conditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select().from(snmpDevices)
      .where(and(...conditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    const template = device.templateId
      ? (await db.select().from(snmpTemplates).where(eq(snmpTemplates.id, device.templateId)).limit(1))[0] ?? null
      : null;

    const recentMetrics = await db.select().from(snmpMetrics)
      .where(eq(snmpMetrics.deviceId, deviceId))
      .orderBy(desc(snmpMetrics.timestamp))
      .limit(20);

    return c.json({
      data: {
        ...device,
        lastPolledAt: device.lastPolled?.toISOString() ?? null,
        status: device.lastStatus ?? 'offline',
        createdAt: device.createdAt.toISOString(),
        template: template ? {
          id: template.id,
          name: template.name,
          description: template.description,
          vendor: template.vendor,
          deviceType: template.deviceType,
          oids: template.oids,
          isBuiltIn: template.isBuiltIn
        } : null,
        recentMetrics: recentMetrics.length > 0 ? {
          deviceId,
          capturedAt: recentMetrics[0].timestamp.toISOString(),
          metrics: recentMetrics.map((m) => ({
            oid: m.oid,
            name: m.name,
            value: m.value,
            recordedAt: m.timestamp.toISOString()
          }))
        } : null
      }
    });
  }
);

snmpRoutes.patch(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) conditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [existing] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Device not found.' }, 404);

    if (payload.templateId) {
      const [tmpl] = await db.select({ id: snmpTemplates.id }).from(snmpTemplates)
        .where(eq(snmpTemplates.id, payload.templateId)).limit(1);
      if (!tmpl) return c.json({ error: 'Template not found.' }, 400);
    }

    const [updated] = await db.update(snmpDevices)
      .set(payload)
      .where(eq(snmpDevices.id, deviceId))
      .returning();

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'snmp.device.update',
      resourceType: 'snmp_device',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(payload),
      },
    });

    return c.json({ data: updated });
  }
);

snmpRoutes.delete(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) conditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [existing] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Device not found.' }, 404);

    // Delete related data first
    await db.delete(snmpMetrics).where(eq(snmpMetrics.deviceId, deviceId));
    await db.delete(snmpAlertThresholds).where(eq(snmpAlertThresholds.deviceId, deviceId));
    const [removed] = await db.delete(snmpDevices).where(eq(snmpDevices.id, deviceId)).returning();

    if (removed) {
      writeRouteAudit(c, {
        orgId: removed.orgId,
        action: 'snmp.device.delete',
        resourceType: 'snmp_device',
        resourceId: removed.id,
        resourceName: removed.name,
      });
    }

    return c.json({ data: removed });
  }
);

snmpRoutes.post(
  '/devices/:id/poll',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) conditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select({ id: snmpDevices.id, orgId: snmpDevices.orgId }).from(snmpDevices)
      .where(and(...conditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    if (!isRedisAvailable()) {
      return c.json({ error: 'Polling service unavailable. Redis is required for job queuing.' }, 503);
    }

    await enqueueSnmpPoll(deviceId, device.orgId);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'snmp.device.poll.queue',
      resourceType: 'snmp_device',
      resourceId: deviceId,
    });

    return c.json({
      data: {
        deviceId,
        status: 'queued',
        message: 'Poll request queued'
      }
    });
  }
);

snmpRoutes.post(
  '/devices/:id/test',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) conditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select().from(snmpDevices)
      .where(and(...conditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    // Load template OIDs for the test (use sysDescr as a basic check)
    let testOids = ['1.3.6.1.2.1.1.1.0']; // sysDescr
    if (device.templateId) {
      const [tmpl] = await db.select({ oids: snmpTemplates.oids }).from(snmpTemplates)
        .where(eq(snmpTemplates.id, device.templateId)).limit(1);
      if (tmpl && Array.isArray(tmpl.oids)) {
        const templateOids = (tmpl.oids as Array<{ oid: string }>).map((o) => o.oid).slice(0, 3);
        if (templateOids.length > 0) testOids = templateOids;
      }
    }

    // Find an online agent for this org
    const [onlineAgent] = await db
      .select({ agentId: devices.agentId })
      .from(devices)
      .where(and(eq(devices.orgId, device.orgId), eq(devices.status, 'online')))
      .limit(1);

    const agentId = onlineAgent?.agentId ?? null;
    if (!agentId || !isAgentConnected(agentId)) {
      return c.json({
        data: {
          deviceId,
          status: 'failed',
          error: 'No online agent available',
          snmpVersion: device.snmpVersion,
          testedAt: new Date().toISOString()
        }
      });
    }

    const command = buildSnmpPollCommand(deviceId, device, testOids, 'snmp-test');
    const sent = sendCommandToAgent(agentId, command);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'snmp.device.test',
      resourceType: 'snmp_device',
      resourceId: device.id,
      resourceName: device.name,
      details: {
        queued: sent,
      },
      result: sent ? 'success' : 'failure',
    });

    return c.json({
      data: {
        deviceId,
        status: sent ? 'queued' : 'failed',
        error: sent ? undefined : 'Failed to send test command to agent',
        snmpVersion: device.snmpVersion,
        testedAt: new Date().toISOString()
      }
    });
  }
);

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

// ==================== METRIC ROUTES ====================

snmpRoutes.get(
  '/metrics/:deviceId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const deviceConditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) deviceConditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
      .where(and(...deviceConditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    // Get the most recent metrics (one per OID)
    const metrics = await db.select().from(snmpMetrics)
      .where(eq(snmpMetrics.deviceId, deviceId))
      .orderBy(desc(snmpMetrics.timestamp))
      .limit(50);

    // Deduplicate by OID to show latest value per OID
    const seen = new Set<string>();
    const latest = metrics.filter((m) => {
      if (seen.has(m.oid)) return false;
      seen.add(m.oid);
      return true;
    });

    return c.json({
      data: {
        deviceId,
        capturedAt: latest[0]?.timestamp.toISOString() ?? new Date().toISOString(),
        metrics: latest.map((m) => ({
          oid: m.oid,
          name: m.name,
          value: m.value,
          recordedAt: m.timestamp.toISOString()
        }))
      }
    });
  }
);

snmpRoutes.get(
  '/metrics/:deviceId/history',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', metricsHistorySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const deviceConditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) deviceConditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
      .where(and(...deviceConditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    const end = query.end ? new Date(query.end) : new Date();
    const start = query.start ? new Date(query.start) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const interval = query.interval ?? '1h';

    const metrics = await db.select().from(snmpMetrics)
      .where(and(
        eq(snmpMetrics.deviceId, deviceId),
        gte(snmpMetrics.timestamp, start),
        lte(snmpMetrics.timestamp, end)
      ))
      .orderBy(snmpMetrics.timestamp);

    // Group by OID into series
    const seriesMap = new Map<string, { oid: string; name: string; points: Array<{ timestamp: string; value: string | null }> }>();
    for (const m of metrics) {
      if (!seriesMap.has(m.oid)) {
        seriesMap.set(m.oid, { oid: m.oid, name: m.name, points: [] });
      }
      seriesMap.get(m.oid)!.points.push({
        timestamp: m.timestamp.toISOString(),
        value: m.value
      });
    }

    return c.json({
      data: {
        deviceId,
        start: start.toISOString(),
        end: end.toISOString(),
        interval,
        series: Array.from(seriesMap.values())
      }
    });
  }
);

snmpRoutes.get(
  '/metrics/:deviceId/:oid',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', metricsHistorySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');
    const oid = c.req.param('oid');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const deviceConditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) deviceConditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
      .where(and(...deviceConditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    const end = query.end ? new Date(query.end) : new Date();
    const start = query.start ? new Date(query.start) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const interval = query.interval ?? '1h';

    const metrics = await db.select().from(snmpMetrics)
      .where(and(
        eq(snmpMetrics.deviceId, deviceId),
        or(eq(snmpMetrics.oid, oid), eq(snmpMetrics.name, oid)),
        gte(snmpMetrics.timestamp, start),
        lte(snmpMetrics.timestamp, end)
      ))
      .orderBy(snmpMetrics.timestamp);

    return c.json({
      data: {
        deviceId,
        oid: metrics[0]?.oid ?? oid,
        name: metrics[0]?.name ?? oid,
        interval,
        start: start.toISOString(),
        end: end.toISOString(),
        series: metrics.map((m) => ({
          timestamp: m.timestamp.toISOString(),
          value: m.value
        }))
      }
    });
  }
);

// ==================== THRESHOLD ROUTES ====================

snmpRoutes.get(
  '/thresholds/:deviceId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const deviceConditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, deviceId)];
    if (orgResult.orgId) deviceConditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
      .where(and(...deviceConditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    const results = await db.select().from(snmpAlertThresholds)
      .where(eq(snmpAlertThresholds.deviceId, deviceId));

    return c.json({ data: results });
  }
);

snmpRoutes.post(
  '/thresholds',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createThresholdSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const deviceConditions: ReturnType<typeof eq>[] = [eq(snmpDevices.id, payload.deviceId)];
    if (orgResult.orgId) deviceConditions.push(eq(snmpDevices.orgId, orgResult.orgId));

    const [device] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
      .where(and(...deviceConditions)).limit(1);
    if (!device) return c.json({ error: 'Device not found.' }, 404);

    const [threshold] = await db.insert(snmpAlertThresholds).values({
      deviceId: payload.deviceId,
      oid: payload.oid,
      operator: payload.operator,
      threshold: payload.threshold,
      severity: payload.severity,
      message: payload.message ?? null,
      isActive: payload.isActive ?? true
    }).returning();

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'snmp.threshold.create',
      resourceType: 'snmp_threshold',
      resourceId: threshold.id,
      details: {
        deviceId: threshold.deviceId,
        oid: threshold.oid,
        severity: threshold.severity,
      },
    });

    return c.json({ data: threshold }, 201);
  }
);

snmpRoutes.patch(
  '/thresholds/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateThresholdSchema),
  async (c) => {
    const auth = c.get('auth');
    const thresholdId = c.req.param('id');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    // Verify threshold exists and its device belongs to the caller's org
    const query = orgResult.orgId
      ? db.select().from(snmpAlertThresholds)
          .innerJoin(snmpDevices, eq(snmpAlertThresholds.deviceId, snmpDevices.id))
          .where(and(eq(snmpAlertThresholds.id, thresholdId), eq(snmpDevices.orgId, orgResult.orgId)))
      : db.select().from(snmpAlertThresholds)
          .where(eq(snmpAlertThresholds.id, thresholdId));

    const [existing] = await query.limit(1);
    if (!existing) return c.json({ error: 'Threshold not found.' }, 404);

    const [updated] = await db.update(snmpAlertThresholds)
      .set(payload)
      .where(eq(snmpAlertThresholds.id, thresholdId))
      .returning();

    const [thresholdContext] = await db
      .select({ orgId: snmpDevices.orgId })
      .from(snmpAlertThresholds)
      .innerJoin(snmpDevices, eq(snmpAlertThresholds.deviceId, snmpDevices.id))
      .where(eq(snmpAlertThresholds.id, thresholdId))
      .limit(1);

    writeRouteAudit(c, {
      orgId: thresholdContext?.orgId ?? orgResult.orgId,
      action: 'snmp.threshold.update',
      resourceType: 'snmp_threshold',
      resourceId: updated.id,
      details: {
        updatedFields: Object.keys(payload),
      },
    });

    return c.json({ data: updated });
  }
);

snmpRoutes.delete(
  '/thresholds/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const thresholdId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    // Verify threshold exists and its device belongs to the caller's org
    const query = orgResult.orgId
      ? db.select({ id: snmpAlertThresholds.id, deviceId: snmpAlertThresholds.deviceId }).from(snmpAlertThresholds)
          .innerJoin(snmpDevices, eq(snmpAlertThresholds.deviceId, snmpDevices.id))
          .where(and(eq(snmpAlertThresholds.id, thresholdId), eq(snmpDevices.orgId, orgResult.orgId)))
      : db.select({ id: snmpAlertThresholds.id, deviceId: snmpAlertThresholds.deviceId }).from(snmpAlertThresholds)
          .where(eq(snmpAlertThresholds.id, thresholdId));

    const [existing] = await query.limit(1);
    if (!existing) return c.json({ error: 'Threshold not found.' }, 404);

    const [removed] = await db.delete(snmpAlertThresholds)
      .where(eq(snmpAlertThresholds.id, thresholdId)).returning();

    if (removed) {
      const [thresholdContext] = await db
        .select({ orgId: snmpDevices.orgId })
        .from(snmpDevices)
        .where(eq(snmpDevices.id, removed.deviceId))
        .limit(1);

      writeRouteAudit(c, {
        orgId: thresholdContext?.orgId ?? orgResult.orgId,
        action: 'snmp.threshold.delete',
        resourceType: 'snmp_threshold',
        resourceId: removed.id,
        details: {
          deviceId: removed.deviceId,
          oid: removed.oid,
        },
      });
    }

    return c.json({ data: removed });
  }
);

// ==================== DASHBOARD ROUTE ====================

snmpRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveOrgId(auth);
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
        topInterfaces: [],
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
