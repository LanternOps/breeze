import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  alerts,
  devices,
  networkBaselines,
  networkChangeEvents
} from '../db/schema';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const networkChangeRoutes = new Hono();

const networkEventTypes = ['new_device', 'device_disappeared', 'device_changed', 'rogue_device'] as const;

const listNetworkChangesSchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  baselineId: z.string().uuid().optional(),
  eventType: z.enum(networkEventTypes).optional(),
  acknowledged: z.coerce.boolean().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const acknowledgeChangeSchema = z.object({
  notes: z.string().max(2000).optional()
});

const linkDeviceSchema = z.object({
  deviceId: z.string().uuid()
});

const bulkAcknowledgeSchema = z.object({
  eventIds: z.array(z.string().uuid()).min(1).max(200),
  notes: z.string().max(2000).optional()
});

function mapNetworkChangeRow(row: typeof networkChangeEvents.$inferSelect) {
  return {
    ...row,
    detectedAt: row.detectedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

async function getChangeEventWithAccess(
  eventId: string,
  auth: AuthContext
): Promise<typeof networkChangeEvents.$inferSelect | null> {
  const conditions: SQL[] = [eq(networkChangeEvents.id, eventId)];
  const orgCondition = auth.orgCondition(networkChangeEvents.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [event] = await db
    .select()
    .from(networkChangeEvents)
    .where(and(...conditions))
    .limit(1);

  return event ?? null;
}

networkChangeRoutes.use('*', authMiddleware);

networkChangeRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listNetworkChangesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const conditions: SQL[] = [];

    const orgCondition = auth.orgCondition(networkChangeEvents.orgId);
    if (orgCondition) {
      conditions.push(orgCondition);
    }

    if (query.orgId) {
      conditions.push(eq(networkChangeEvents.orgId, query.orgId));
    }

    if (query.siteId) {
      conditions.push(eq(networkChangeEvents.siteId, query.siteId));
    }

    if (query.baselineId) {
      conditions.push(eq(networkChangeEvents.baselineId, query.baselineId));
    }

    if (query.eventType) {
      conditions.push(eq(networkChangeEvents.eventType, query.eventType));
    }

    if (query.acknowledged !== undefined) {
      conditions.push(eq(networkChangeEvents.acknowledged, query.acknowledged));
    }

    if (query.since) {
      conditions.push(gte(networkChangeEvents.detectedAt, new Date(query.since)));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkChangeEvents)
      .where(where);

    const rows = await db
      .select({
        event: networkChangeEvents,
        baselineSubnet: networkBaselines.subnet
      })
      .from(networkChangeEvents)
      .leftJoin(networkBaselines, eq(networkChangeEvents.baselineId, networkBaselines.id))
      .where(where)
      .orderBy(desc(networkChangeEvents.detectedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map(({ event, baselineSubnet }) => ({
        ...mapNetworkChangeRow(event),
        baselineSubnet
      })),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0)
      }
    });
  }
);

networkChangeRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const eventId = c.req.param('id');

    const event = await getChangeEventWithAccess(eventId, auth);
    if (!event) {
      return c.json({ error: 'Network change event not found' }, 404);
    }

    const [baseline] = await db
      .select({ id: networkBaselines.id, subnet: networkBaselines.subnet })
      .from(networkBaselines)
      .where(eq(networkBaselines.id, event.baselineId))
      .limit(1);

    return c.json({
      ...mapNetworkChangeRow(event),
      baselineSubnet: baseline?.subnet ?? null
    });
  }
);

networkChangeRoutes.post(
  '/:id/acknowledge',
  requireScope('organization', 'partner', 'system'),
  requirePermission('alerts', 'acknowledge'),
  zValidator('json', acknowledgeChangeSchema),
  async (c) => {
    const auth = c.get('auth');
    const eventId = c.req.param('id');
    const body = c.req.valid('json');

    const event = await getChangeEventWithAccess(eventId, auth);
    if (!event) {
      return c.json({ error: 'Network change event not found' }, 404);
    }

    if (event.acknowledged) {
      return c.json({ error: 'Network change event is already acknowledged' }, 400);
    }

    const [updated] = await db
      .update(networkChangeEvents)
      .set({
        acknowledged: true,
        acknowledgedBy: auth.user.id,
        acknowledgedAt: new Date(),
        notes: body.notes ?? event.notes
      })
      .where(eq(networkChangeEvents.id, event.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to acknowledge network change event' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'network.change.acknowledge',
      resourceType: 'network_change_event',
      resourceId: updated.id,
      resourceName: updated.ipAddress,
      details: {
        eventType: updated.eventType,
        notes: body.notes ?? null
      }
    });

    return c.json(mapNetworkChangeRow(updated));
  }
);

networkChangeRoutes.post(
  '/:id/link-device',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', linkDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const eventId = c.req.param('id');
    const body = c.req.valid('json');

    const event = await getChangeEventWithAccess(eventId, auth);
    if (!event) {
      return c.json({ error: 'Network change event not found' }, 404);
    }

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, body.deviceId))
      .limit(1);

    if (!device || device.orgId !== event.orgId) {
      return c.json({ error: 'Device not found in the same organization' }, 404);
    }

    const [updated] = await db
      .update(networkChangeEvents)
      .set({
        linkedDeviceId: body.deviceId
      })
      .where(eq(networkChangeEvents.id, event.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to link device to network change event' }, 500);
    }

    if (updated.alertId) {
      await db
        .update(alerts)
        .set({ deviceId: body.deviceId })
        .where(eq(alerts.id, updated.alertId));
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'network.change.link_device',
      resourceType: 'network_change_event',
      resourceId: updated.id,
      resourceName: updated.ipAddress,
      details: { deviceId: body.deviceId }
    });

    return c.json(mapNetworkChangeRow(updated));
  }
);

networkChangeRoutes.post(
  '/bulk-acknowledge',
  requireScope('organization', 'partner', 'system'),
  requirePermission('alerts', 'acknowledge'),
  zValidator('json', bulkAcknowledgeSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const conditions: SQL[] = [inArray(networkChangeEvents.id, body.eventIds)];
    const orgCondition = auth.orgCondition(networkChangeEvents.orgId);
    if (orgCondition) {
      conditions.push(orgCondition);
    }

    const accessibleEvents = await db
      .select({ id: networkChangeEvents.id, orgId: networkChangeEvents.orgId })
      .from(networkChangeEvents)
      .where(and(...conditions));

    if (accessibleEvents.length === 0) {
      return c.json({ error: 'No accessible network change events found' }, 404);
    }

    const eventIds = accessibleEvents.map((event) => event.id);

    const updateValues: Partial<typeof networkChangeEvents.$inferInsert> = {
      acknowledged: true,
      acknowledgedBy: auth.user.id,
      acknowledgedAt: new Date()
    };
    if (body.notes !== undefined) {
      updateValues.notes = body.notes;
    }

    const updated = await db
      .update(networkChangeEvents)
      .set(updateValues)
      .where(
        and(
          inArray(networkChangeEvents.id, eventIds),
          eq(networkChangeEvents.acknowledged, false)
        )
      )
      .returning({ id: networkChangeEvents.id, orgId: networkChangeEvents.orgId });

    writeRouteAudit(c, {
      orgId: updated[0]?.orgId ?? accessibleEvents[0]?.orgId ?? null,
      action: 'network.change.bulk_acknowledge',
      resourceType: 'network_change_event',
      details: {
        requestedCount: body.eventIds.length,
        accessibleCount: eventIds.length,
        updatedCount: updated.length
      }
    });

    return c.json({
      success: true,
      acknowledgedCount: updated.length,
      requestedCount: body.eventIds.length,
      inaccessibleCount: body.eventIds.length - eventIds.length
    });
  }
);
