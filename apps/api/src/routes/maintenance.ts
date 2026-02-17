import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, or, lte, gte, inArray, desc, asc, sql } from 'drizzle-orm';
import { db } from '../db';
import { maintenanceWindows, maintenanceOccurrences } from '../db/schema/maintenance';
import { devices } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { isDeviceInMaintenance } from '../services/maintenanceService';

export const maintenanceRoutes = new Hono();

// Helper functions
async function canAccessOrg(
  auth: { canAccessOrg: (orgId: string) => boolean },
  orgId: string
): Promise<boolean> {
  return auth.canAccessOrg(orgId);
}

function resolveOrgId(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 } as const;
    }

    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 } as const;
    }

    return { orgId: auth.orgId } as const;
  }

  if (requestedOrgId && !auth.canAccessOrg(requestedOrgId)) {
    return { error: 'Access to this organization denied', status: 403 } as const;
  }

  if (auth.scope === 'partner' && !requestedOrgId) {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && accessibleOrgIds.length === 1) {
      return { orgId: accessibleOrgIds[0] } as const;
    }
    return { error: 'orgId is required for partner scope', status: 400 } as const;
  }

  if (auth.scope === 'system' && !requestedOrgId) {
    return { error: 'orgId is required for system scope', status: 400 } as const;
  }

  if (requireForNonOrg && !requestedOrgId) {
    return { error: 'orgId is required', status: 400 } as const;
  }

  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}

// Validation schemas
const recurrenceRuleSchema = z.object({
  interval: z.number().int().positive().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  endDate: z.string().datetime().optional(),
  maxOccurrences: z.number().int().positive().optional()
}).optional();

const createWindowSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  timezone: z.string().default('UTC'),
  recurrence: z.enum(['once', 'daily', 'weekly', 'monthly', 'custom']),
  recurrenceRule: recurrenceRuleSchema,
  targetType: z.enum(['all', 'site', 'group', 'device']),
  siteIds: z.array(z.string().uuid()).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
  deviceIds: z.array(z.string().uuid()).optional(),
  suppressAlerts: z.boolean().default(true),
  suppressPatches: z.boolean().default(true),
  suppressAutomations: z.boolean().default(false),
  notifyBefore: z.number().int().positive().optional(),
  notifyOnStart: z.boolean().default(false),
  notifyOnEnd: z.boolean().default(false)
}).refine((data) => {
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);
  return end > start;
}, { message: 'End time must be after start time' });

const updateWindowSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  timezone: z.string().optional(),
  recurrence: z.enum(['once', 'daily', 'weekly', 'monthly', 'custom']).optional(),
  recurrenceRule: recurrenceRuleSchema,
  targetType: z.enum(['all', 'site', 'group', 'device']).optional(),
  siteIds: z.array(z.string().uuid()).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
  deviceIds: z.array(z.string().uuid()).optional(),
  suppressAlerts: z.boolean().optional(),
  suppressPatches: z.boolean().optional(),
  suppressAutomations: z.boolean().optional(),
  notifyBefore: z.number().int().positive().optional(),
  notifyOnStart: z.boolean().optional(),
  notifyOnEnd: z.boolean().optional()
});

const listWindowsSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
  targetType: z.enum(['all', 'site', 'group', 'device']).optional()
});

const listOccurrencesSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const updateOccurrenceSchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  notes: z.string().optional()
});

const activeWindowsSchema = z.object({
  deviceId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional()
});

// Helper to generate occurrences based on recurrence rule
function generateOccurrences(
  windowId: string,
  startTime: Date,
  endTime: Date,
  recurrence: string,
  recurrenceRule: Record<string, unknown> | null,
  count: number = 10
): Array<{ windowId: string; startTime: Date; endTime: Date; status: 'scheduled' }> {
  const occurrences: Array<{ windowId: string; startTime: Date; endTime: Date; status: 'scheduled' }> = [];
  const duration = endTime.getTime() - startTime.getTime();
  let currentStart = new Date(startTime);
  const maxOccurrences = (recurrenceRule?.maxOccurrences as number) ?? count;
  const endDate = recurrenceRule?.endDate ? new Date(recurrenceRule.endDate as string) : null;

  while (occurrences.length < Math.min(count, maxOccurrences)) {
    if (endDate && currentStart > endDate) {
      break;
    }

    occurrences.push({
      windowId,
      startTime: new Date(currentStart),
      endTime: new Date(currentStart.getTime() + duration),
      status: 'scheduled'
    });

    if (recurrence === 'once') {
      break;
    }

    // Calculate next occurrence
    const interval = (recurrenceRule?.interval as number) ?? 1;

    switch (recurrence) {
      case 'daily':
        currentStart.setDate(currentStart.getDate() + interval);
        break;
      case 'weekly': {
        const daysOfWeek = recurrenceRule?.daysOfWeek as number[] | undefined;
        if (daysOfWeek && daysOfWeek.length > 0) {
          // Find next day in the week that matches
          let found = false;
          for (let i = 1; i <= 7; i++) {
            const nextDay = new Date(currentStart);
            nextDay.setDate(nextDay.getDate() + i);
            if (daysOfWeek.includes(nextDay.getDay())) {
              currentStart = nextDay;
              found = true;
              break;
            }
          }
          if (!found) {
            currentStart.setDate(currentStart.getDate() + 7 * interval);
          }
        } else {
          currentStart.setDate(currentStart.getDate() + 7 * interval);
        }
        break;
      }
      case 'monthly': {
        const dayOfMonth = recurrenceRule?.dayOfMonth as number | undefined;
        currentStart.setMonth(currentStart.getMonth() + interval);
        if (dayOfMonth) {
          const lastDay = new Date(currentStart.getFullYear(), currentStart.getMonth() + 1, 0).getDate();
          currentStart.setDate(Math.min(dayOfMonth, lastDay));
        }
        break;
      }
      case 'custom':
        // For custom, default to weekly if no specific rule
        currentStart.setDate(currentStart.getDate() + 7 * interval);
        break;
      default:
        break;
    }
  }

  return occurrences;
}

// Apply auth middleware to all routes
maintenanceRoutes.use('*', authMiddleware);

// ============================================
// Config Policy Integration: Device Maintenance Status
// ============================================

// GET /device/:deviceId/status - Resolve maintenance status for a device.
// Checks config policy maintenance settings first (hierarchy-resolved),
// then falls back to standalone maintenance windows for backward compatibility.
maintenanceRoutes.get(
  '/device/:deviceId/status',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');

    // Verify the caller has access to this device's org
    const [device] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    if (auth.scope === 'organization' && auth.orgId !== device.orgId) {
      return c.json({ error: 'Access denied' }, 403);
    }
    if (auth.scope === 'partner' && !auth.canAccessOrg(device.orgId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const status = await isDeviceInMaintenance(deviceId);

    return c.json({
      data: {
        deviceId,
        active: status.active,
        source: status.source,
        suppressAlerts: status.suppressAlerts,
        suppressPatching: status.suppressPatching,
        suppressAutomations: status.suppressAutomations,
        suppressScripts: status.suppressScripts,
      },
    });
  }
);

// ============================================
// Standalone Maintenance Window Routes (Legacy)
// ============================================

// GET /windows - List maintenance windows for org with filters
maintenanceRoutes.get(
  '/windows',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listWindowsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, true);

    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions = [eq(maintenanceWindows.orgId, orgResult.orgId as string)];

    if (query.status) {
      conditions.push(eq(maintenanceWindows.status, query.status));
    }

    if (query.targetType) {
      conditions.push(eq(maintenanceWindows.targetType, query.targetType));
    }

    const windows = await db
      .select()
      .from(maintenanceWindows)
      .where(and(...conditions))
      .orderBy(desc(maintenanceWindows.createdAt));

    return c.json({ data: windows });
  }
);

// DEPRECATED: Maintenance windows are now managed via Configuration Policies.
// This route remains for legacy compatibility.
// POST /windows - Create maintenance window
maintenanceRoutes.post(
  '/windows',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createWindowSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId, true);

    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const startTime = new Date(body.startTime);
    const endTime = new Date(body.endTime);

    // Create the maintenance window
    const [createdWindow] = await db
      .insert(maintenanceWindows)
      .values({
        orgId: orgResult.orgId as string,
        name: body.name,
        description: body.description,
        startTime,
        endTime,
        timezone: body.timezone,
        recurrence: body.recurrence,
        recurrenceRule: body.recurrenceRule,
        targetType: body.targetType,
        siteIds: body.siteIds,
        groupIds: body.groupIds,
        deviceIds: body.deviceIds,
        suppressAlerts: body.suppressAlerts,
        suppressPatching: body.suppressPatches,
        suppressAutomations: body.suppressAutomations,
        notifyBefore: body.notifyBefore,
        notifyOnStart: body.notifyOnStart,
        notifyOnEnd: body.notifyOnEnd,
        createdBy: auth.user.id
      })
      .returning();

    if (!createdWindow) {
      return c.json({ error: 'Failed to create maintenance window' }, 500);
    }

    // Generate initial occurrences
    const occurrencesToCreate = generateOccurrences(
      createdWindow.id,
      startTime,
      endTime,
      body.recurrence,
      body.recurrenceRule ?? null,
      10
    );

    if (occurrencesToCreate.length > 0) {
      await db.insert(maintenanceOccurrences).values(occurrencesToCreate);
    }

    writeRouteAudit(c, {
      orgId: createdWindow.orgId,
      action: 'maintenance_window.create',
      resourceType: 'maintenance_window',
      resourceId: createdWindow.id,
      resourceName: createdWindow.name,
      details: {
        targetType: createdWindow.targetType,
        recurrence: createdWindow.recurrence,
        occurrenceCount: occurrencesToCreate.length,
      },
    });

    return c.json(createdWindow, 201);
  }
);

// GET /windows/:id - Get window details with upcoming occurrences
maintenanceRoutes.get(
  '/windows/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const windowId = c.req.param('id');

    const [window] = await db
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, windowId))
      .limit(1);

    if (!window || !(await canAccessOrg(auth, window.orgId))) {
      return c.json({ error: 'Maintenance window not found' }, 404);
    }

    // Get upcoming occurrences
    const occurrences = await db
      .select()
      .from(maintenanceOccurrences)
      .where(
        and(
          eq(maintenanceOccurrences.windowId, windowId),
          gte(maintenanceOccurrences.startTime, new Date())
        )
      )
      .orderBy(asc(maintenanceOccurrences.startTime))
      .limit(10);

    return c.json({ ...window, upcomingOccurrences: occurrences });
  }
);

// DEPRECATED: Maintenance windows are now managed via Configuration Policies.
// This route remains for legacy compatibility.
// PATCH /windows/:id - Update window
maintenanceRoutes.patch(
  '/windows/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateWindowSchema),
  async (c) => {
    const auth = c.get('auth');
    const windowId = c.req.param('id');
    const updates = c.req.valid('json');

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const [window] = await db
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, windowId))
      .limit(1);

    if (!window || !(await canAccessOrg(auth, window.orgId))) {
      return c.json({ error: 'Maintenance window not found' }, 404);
    }

    // Build update object
    const updateData: Record<string, unknown> = {
      updatedAt: new Date()
    };

    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.startTime !== undefined) updateData.startTime = new Date(updates.startTime);
    if (updates.endTime !== undefined) updateData.endTime = new Date(updates.endTime);
    if (updates.timezone !== undefined) updateData.timezone = updates.timezone;
    if (updates.recurrence !== undefined) updateData.recurrence = updates.recurrence;
    if (updates.recurrenceRule !== undefined) updateData.recurrenceRule = updates.recurrenceRule;
    if (updates.targetType !== undefined) updateData.targetType = updates.targetType;
    if (updates.siteIds !== undefined) updateData.siteIds = updates.siteIds;
    if (updates.groupIds !== undefined) updateData.groupIds = updates.groupIds;
    if (updates.deviceIds !== undefined) updateData.deviceIds = updates.deviceIds;
    if (updates.suppressAlerts !== undefined) updateData.suppressAlerts = updates.suppressAlerts;
    if (updates.suppressPatches !== undefined) updateData.suppressPatching = updates.suppressPatches;
    if (updates.suppressAutomations !== undefined) updateData.suppressAutomations = updates.suppressAutomations;
    if (updates.notifyBefore !== undefined) updateData.notifyBefore = updates.notifyBefore;
    if (updates.notifyOnStart !== undefined) updateData.notifyOnStart = updates.notifyOnStart;
    if (updates.notifyOnEnd !== undefined) updateData.notifyOnEnd = updates.notifyOnEnd;

    const [updated] = await db
      .update(maintenanceWindows)
      .set(updateData)
      .where(eq(maintenanceWindows.id, windowId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to update maintenance window' }, 500);
    }

    writeRouteAudit(c, {
      orgId: window.orgId,
      action: 'maintenance_window.update',
      resourceType: 'maintenance_window',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(updates),
      },
    });

    return c.json(updated);
  }
);

// DEPRECATED: Maintenance windows are now managed via Configuration Policies.
// This route remains for legacy compatibility.
// DELETE /windows/:id - Delete window (and future occurrences)
maintenanceRoutes.delete(
  '/windows/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const windowId = c.req.param('id');

    const [window] = await db
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, windowId))
      .limit(1);

    if (!window || !(await canAccessOrg(auth, window.orgId))) {
      return c.json({ error: 'Maintenance window not found' }, 404);
    }

    // Delete only future occurrences (preserve past ones for audit)
    await db
      .delete(maintenanceOccurrences)
      .where(
        and(
          eq(maintenanceOccurrences.windowId, windowId),
          gte(maintenanceOccurrences.startTime, new Date())
        )
      );

    // Delete the window
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, windowId));

    writeRouteAudit(c, {
      orgId: window.orgId,
      action: 'maintenance_window.delete',
      resourceType: 'maintenance_window',
      resourceId: window.id,
      resourceName: window.name,
    });

    return c.json({ success: true });
  }
);

// DEPRECATED: Maintenance windows are now managed via Configuration Policies.
// This route remains for legacy compatibility.
// POST /windows/:id/cancel - Cancel window
maintenanceRoutes.post(
  '/windows/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const windowId = c.req.param('id');

    const [window] = await db
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, windowId))
      .limit(1);

    if (!window || !(await canAccessOrg(auth, window.orgId))) {
      return c.json({ error: 'Maintenance window not found' }, 404);
    }

    if (window.status === 'cancelled') {
      return c.json({ error: 'Window is already cancelled' }, 400);
    }

    // Update window status
    const [updated] = await db
      .update(maintenanceWindows)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(maintenanceWindows.id, windowId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to cancel maintenance window' }, 500);
    }

    // Cancel all future occurrences
    await db
      .update(maintenanceOccurrences)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(maintenanceOccurrences.windowId, windowId),
          gte(maintenanceOccurrences.startTime, new Date())
        )
      );

    writeRouteAudit(c, {
      orgId: window.orgId,
      action: 'maintenance_window.cancel',
      resourceType: 'maintenance_window',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        previousStatus: window.status,
        nextStatus: updated.status,
      },
    });

    return c.json(updated);
  }
);

// GET /windows/:id/occurrences - List occurrences for a window
maintenanceRoutes.get(
  '/windows/:id/occurrences',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const windowId = c.req.param('id');

    const [window] = await db
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, windowId))
      .limit(1);

    if (!window || !(await canAccessOrg(auth, window.orgId))) {
      return c.json({ error: 'Maintenance window not found' }, 404);
    }

    const occurrences = await db
      .select()
      .from(maintenanceOccurrences)
      .where(eq(maintenanceOccurrences.windowId, windowId))
      .orderBy(asc(maintenanceOccurrences.startTime));

    return c.json({ data: occurrences });
  }
);

// GET /occurrences - List all occurrences across windows (for calendar view)
maintenanceRoutes.get(
  '/occurrences',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listOccurrencesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, true);

    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    // Get all windows for this org first
    const windows = await db
      .select({ id: maintenanceWindows.id })
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.orgId, orgResult.orgId as string));

    const windowIds = windows.map(w => w.id);

    if (windowIds.length === 0) {
      return c.json({ data: [] });
    }

    const conditions = [inArray(maintenanceOccurrences.windowId, windowIds)];

    if (query.status) {
      conditions.push(eq(maintenanceOccurrences.status, query.status));
    }

    if (query.from) {
      conditions.push(gte(maintenanceOccurrences.startTime, new Date(query.from)));
    }

    if (query.to) {
      conditions.push(lte(maintenanceOccurrences.endTime, new Date(query.to)));
    }

    const occurrences = await db
      .select({
        occurrence: maintenanceOccurrences,
        window: {
          id: maintenanceWindows.id,
          name: maintenanceWindows.name,
          targetType: maintenanceWindows.targetType
        }
      })
      .from(maintenanceOccurrences)
      .innerJoin(maintenanceWindows, eq(maintenanceOccurrences.windowId, maintenanceWindows.id))
      .where(and(...conditions))
      .orderBy(asc(maintenanceOccurrences.startTime));

    return c.json({
      data: occurrences.map(o => ({
        ...o.occurrence,
        window: o.window
      }))
    });
  }
);

// DEPRECATED: Maintenance windows are now managed via Configuration Policies.
// This route remains for legacy compatibility.
// PATCH /occurrences/:id - Update occurrence
maintenanceRoutes.patch(
  '/occurrences/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateOccurrenceSchema),
  async (c) => {
    const auth = c.get('auth');
    const occurrenceId = c.req.param('id');
    const updates = c.req.valid('json');

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    // Get the occurrence and its parent window
    const [occurrence] = await db
      .select({
        occurrence: maintenanceOccurrences,
        window: maintenanceWindows
      })
      .from(maintenanceOccurrences)
      .innerJoin(maintenanceWindows, eq(maintenanceOccurrences.windowId, maintenanceWindows.id))
      .where(eq(maintenanceOccurrences.id, occurrenceId))
      .limit(1);

    if (!occurrence || !(await canAccessOrg(auth, occurrence.window.orgId))) {
      return c.json({ error: 'Occurrence not found' }, 404);
    }

    // Build overrides and update data
    const currentOverrides = (occurrence.occurrence.overrides as Record<string, unknown>) || {};
    const updateData: Record<string, unknown> = {};

    if (updates.startTime !== undefined) {
      currentOverrides.startTime = updates.startTime;
      updateData.startTime = new Date(updates.startTime);
    }

    if (updates.endTime !== undefined) {
      currentOverrides.endTime = updates.endTime;
      updateData.endTime = new Date(updates.endTime);
    }

    if (updates.notes !== undefined) {
      updateData.notes = updates.notes;
    }

    updateData.overrides = currentOverrides;

    const [updated] = await db
      .update(maintenanceOccurrences)
      .set(updateData)
      .where(eq(maintenanceOccurrences.id, occurrenceId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to update maintenance occurrence' }, 500);
    }

    writeRouteAudit(c, {
      orgId: occurrence.window.orgId,
      action: 'maintenance_occurrence.update',
      resourceType: 'maintenance_occurrence',
      resourceId: updated.id,
      resourceName: occurrence.window.name,
      details: {
        updatedFields: Object.keys(updates),
      },
    });

    return c.json(updated);
  }
);

// DEPRECATED: Maintenance windows are now managed via Configuration Policies.
// This route remains for legacy compatibility.
// POST /occurrences/:id/start - Manually start occurrence early
maintenanceRoutes.post(
  '/occurrences/:id/start',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const occurrenceId = c.req.param('id');

    const [occurrence] = await db
      .select({
        occurrence: maintenanceOccurrences,
        window: maintenanceWindows
      })
      .from(maintenanceOccurrences)
      .innerJoin(maintenanceWindows, eq(maintenanceOccurrences.windowId, maintenanceWindows.id))
      .where(eq(maintenanceOccurrences.id, occurrenceId))
      .limit(1);

    if (!occurrence || !(await canAccessOrg(auth, occurrence.window.orgId))) {
      return c.json({ error: 'Occurrence not found' }, 404);
    }

    if (occurrence.occurrence.status !== 'scheduled') {
      return c.json({ error: 'Occurrence is not in scheduled status' }, 400);
    }

    const [updated] = await db
      .update(maintenanceOccurrences)
      .set({
        status: 'active',
        actualStartTime: new Date()
      })
      .where(eq(maintenanceOccurrences.id, occurrenceId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to start maintenance occurrence' }, 500);
    }

    writeRouteAudit(c, {
      orgId: occurrence.window.orgId,
      action: 'maintenance_occurrence.start',
      resourceType: 'maintenance_occurrence',
      resourceId: updated.id,
      resourceName: occurrence.window.name,
      details: {
        previousStatus: occurrence.occurrence.status,
        nextStatus: updated.status,
      },
    });

    return c.json(updated);
  }
);

// DEPRECATED: Maintenance windows are now managed via Configuration Policies.
// This route remains for legacy compatibility.
// POST /occurrences/:id/end - Manually end occurrence early
maintenanceRoutes.post(
  '/occurrences/:id/end',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const occurrenceId = c.req.param('id');

    const [occurrence] = await db
      .select({
        occurrence: maintenanceOccurrences,
        window: maintenanceWindows
      })
      .from(maintenanceOccurrences)
      .innerJoin(maintenanceWindows, eq(maintenanceOccurrences.windowId, maintenanceWindows.id))
      .where(eq(maintenanceOccurrences.id, occurrenceId))
      .limit(1);

    if (!occurrence || !(await canAccessOrg(auth, occurrence.window.orgId))) {
      return c.json({ error: 'Occurrence not found' }, 404);
    }

    if (occurrence.occurrence.status !== 'active') {
      return c.json({ error: 'Occurrence is not currently active' }, 400);
    }

    const [updated] = await db
      .update(maintenanceOccurrences)
      .set({
        status: 'completed',
        actualEndTime: new Date()
      })
      .where(eq(maintenanceOccurrences.id, occurrenceId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to end maintenance occurrence' }, 500);
    }

    writeRouteAudit(c, {
      orgId: occurrence.window.orgId,
      action: 'maintenance_occurrence.end',
      resourceType: 'maintenance_occurrence',
      resourceId: updated.id,
      resourceName: occurrence.window.name,
      details: {
        previousStatus: occurrence.occurrence.status,
        nextStatus: updated.status,
      },
    });

    return c.json(updated);
  }
);

// GET /active - Get currently active maintenance windows affecting a device/site/group
maintenanceRoutes.get(
  '/active',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', activeWindowsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, true);

    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const now = new Date();

    // Get all windows for this org
    const windows = await db
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.orgId, orgResult.orgId as string));

    if (windows.length === 0) {
      return c.json({ data: [] });
    }

    const windowIds = windows.map(w => w.id);

    // Find active occurrences (currently within the maintenance period)
    const activeOccurrences = await db
      .select({
        occurrence: maintenanceOccurrences,
        window: maintenanceWindows
      })
      .from(maintenanceOccurrences)
      .innerJoin(maintenanceWindows, eq(maintenanceOccurrences.windowId, maintenanceWindows.id))
      .where(
        and(
          inArray(maintenanceOccurrences.windowId, windowIds),
          or(
            eq(maintenanceOccurrences.status, 'active'),
            and(
              eq(maintenanceOccurrences.status, 'scheduled'),
              lte(maintenanceOccurrences.startTime, now),
              gte(maintenanceOccurrences.endTime, now)
            )
          )
        )
      );

    // Filter by target
    const results = activeOccurrences.filter(({ window }) => {
      // 'all' target type affects everything
      if (window.targetType === 'all') {
        return true;
      }

      // Check if the specified target is affected
      if (query.deviceId && window.deviceIds?.includes(query.deviceId)) {
        return true;
      }

      if (query.siteId && window.siteIds?.includes(query.siteId)) {
        return true;
      }

      if (query.groupId && window.groupIds?.includes(query.groupId)) {
        return true;
      }

      // If no specific target was requested, return all windows
      if (!query.deviceId && !query.siteId && !query.groupId) {
        return true;
      }

      return false;
    });

    return c.json({
      data: results.map(r => ({
        ...r.occurrence,
        window: {
          id: r.window.id,
          name: r.window.name,
          targetType: r.window.targetType,
          suppressAlerts: r.window.suppressAlerts,
          suppressPatching: r.window.suppressPatching,
          suppressAutomations: r.window.suppressAutomations
        }
      }))
    });
  }
);
