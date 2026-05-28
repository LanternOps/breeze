import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, like, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  devices,
  deviceHardware,
  deviceMetrics,
} from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getPagination } from './helpers';
import { buildGroupSQL } from '../../services/filterEngine';
import type { FilterConditionGroup } from '@breeze/shared';
import { filterConditionGroupSchema } from '@breeze/shared/validators/filters';

export const queryRoutes = new Hono();

queryRoutes.use('*', authMiddleware);

// Cap on matchingIds list when includeMatchingIds=true. The set is consumed by
// AlertsPage/ScriptExecutionModal/ReportBuilder to gate other lists. 10k covers
// any realistic MSP fleet; consumers that need more should paginate.
const MATCHING_IDS_MAX = 10000;

const queryDevicesSchema = z.object({
  filter: filterConditionGroupSchema.nullable().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional(),
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  status: z.enum(['online', 'offline', 'maintenance', 'decommissioned', 'updating']).optional(),
  osType: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional(),
  includeDecommissioned: z.boolean().optional(),
  includeMatchingIds: z.boolean().optional(),
  matchingIdsLimit: z.number().int().positive().max(MATCHING_IDS_MAX).optional(),
});

// POST /devices/query - Unified list endpoint that applies a FilterConditionGroup
// in the SAME SQL query that returns the row data. Eliminates the two-snapshot
// drift bug where /devices and /devices/filter-preview returned IDs and rows
// from independent snapshots and a status flip between them produced rows whose
// displayed state contradicted the filter that selected them.
//
// includeMatchingIds=true additionally returns the full (uncapped, up to
// MATCHING_IDS_MAX) set of matching device IDs for consumers like AlertsPage,
// ScriptExecutionModal, and ReportBuilder that gate a different list by device
// membership. They previously called /filters/preview which capped at 10 or 100
// rows and silently truncated.
queryRoutes.post(
  '/query',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', queryDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const { page, limit, offset } = getPagination(
      { page: body.page?.toString(), limit: body.limit?.toString() },
      500
    );

    const conditions: ReturnType<typeof eq>[] = [];

    const orgFilter = auth.orgCondition(devices.orgId);
    if (orgFilter) {
      conditions.push(orgFilter);
    }

    if (body.orgId) {
      if (!auth.canAccessOrg(body.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, body.orgId));
    }

    if (body.siteId) {
      conditions.push(eq(devices.siteId, body.siteId));
    }

    if (body.status) {
      conditions.push(eq(devices.status, body.status));
    }

    if (body.osType) {
      conditions.push(eq(devices.osType, body.osType));
    }

    if (body.search) {
      conditions.push(like(devices.hostname, `%${body.search}%`));
    }

    if (!body.status && body.includeDecommissioned !== true) {
      conditions.push(sql`${devices.status} != 'decommissioned'`);
    }

    // Apply the FilterConditionGroup, if any has valid conditions.
    if (body.filter && hasValidFilterConditions(body.filter as FilterConditionGroup)) {
      try {
        const filterSQL = buildGroupSQL(body.filter as FilterConditionGroup);
        conditions.push(filterSQL);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : 'Invalid filter' },
          400
        );
      }
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const deviceList = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        agentId: devices.agentId,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        deviceRole: devices.deviceRole,
        deviceRoleSource: devices.deviceRoleSource,
        osVersion: devices.osVersion,
        osBuild: devices.osBuild,
        architecture: devices.architecture,
        agentVersion: devices.agentVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        enrolledAt: devices.enrolledAt,
        tags: devices.tags,
        customFields: devices.customFields,
        desktopAccess: devices.desktopAccess,
        lastUser: devices.lastUser,
        uptimeSeconds: devices.uptimeSeconds,
        isHeadless: devices.isHeadless,
        createdAt: devices.createdAt,
        updatedAt: devices.updatedAt,
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb,
      })
      .from(devices)
      .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
      .where(whereCondition)
      .orderBy(desc(devices.lastSeenAt))
      .limit(limit)
      .offset(offset);

    const deviceIds = deviceList.map((d) => d.id);

    const latestMetricsByDevice = new Map<string, {
      cpuPercent: number;
      ramPercent: number;
      timestamp: Date;
    }>();

    if (deviceIds.length > 0) {
      // Same LATERAL + LIMIT 1 pattern as GET /devices for per-device latest
      // metrics. See core.ts:298-340 for the rationale on the VALUES tuple
      // binding (Drizzle's array spread breaks uuid[] casts in unnest).
      const idTuples = sql.join(
        deviceIds.map((id) => sql`(${id}::uuid)`),
        sql`, `
      );
      const rows = await db.execute<{
        device_id: string;
        cpu_percent: number;
        ram_percent: number;
        timestamp: Date;
      }>(sql`
        SELECT d.device_id, m.cpu_percent, m.ram_percent, m.timestamp
        FROM (VALUES ${idTuples}) AS d(device_id)
        INNER JOIN LATERAL (
          SELECT cpu_percent, ram_percent, timestamp
          FROM ${deviceMetrics}
          WHERE device_id = d.device_id
          ORDER BY timestamp DESC
          LIMIT 1
        ) AS m ON true
      `);

      for (const row of rows) {
        latestMetricsByDevice.set(row.device_id, {
          cpuPercent: row.cpu_percent,
          ramPercent: row.ram_percent,
          timestamp: row.timestamp,
        });
      }
    }

    const data = deviceList.map((d) => {
      const latestMetrics = latestMetricsByDevice.get(d.id);
      return {
        id: d.id,
        orgId: d.orgId,
        siteId: d.siteId,
        agentId: d.agentId,
        hostname: d.hostname,
        displayName: d.displayName,
        osType: d.osType,
        deviceRole: d.deviceRole,
        deviceRoleSource: d.deviceRoleSource,
        osVersion: d.osVersion,
        osBuild: d.osBuild,
        architecture: d.architecture,
        agentVersion: d.agentVersion,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        enrolledAt: d.enrolledAt,
        tags: d.tags,
        customFields: d.customFields,
        desktopAccess: d.desktopAccess,
        lastUser: d.lastUser,
        uptimeSeconds: d.uptimeSeconds,
        isHeadless: d.isHeadless,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        cpuPercent: latestMetrics?.cpuPercent ?? 0,
        ramPercent: latestMetrics?.ramPercent ?? 0,
        hardware: {
          cpuModel: d.cpuModel,
          cpuCores: d.cpuCores,
          ramTotalMb: d.ramTotalMb,
          diskTotalGb: d.diskTotalGb,
        },
        metrics: latestMetrics
          ? {
              cpuPercent: latestMetrics.cpuPercent,
              ramPercent: latestMetrics.ramPercent,
              timestamp: latestMetrics.timestamp,
            }
          : null,
      };
    });

    // matchingIds is the full (uncapped up to MATCHING_IDS_MAX) set of
    // matching devices for consumers (AlertsPage, ScriptExecutionModal,
    // ReportBuilder) that gate a different list by device membership. We
    // return {id, hostname} pairs because ReportBuilder's report rows carry
    // hostname strings (not device IDs), and other consumers only need .id.
    let matchingIds: Array<{ id: string; hostname: string }> | undefined;
    if (body.includeMatchingIds) {
      const cap = body.matchingIdsLimit ?? MATCHING_IDS_MAX;
      const idRows = await db
        .select({ id: devices.id, hostname: devices.hostname })
        .from(devices)
        .where(whereCondition)
        .orderBy(desc(devices.lastSeenAt))
        .limit(cap);
      matchingIds = idRows.map((r) => ({ id: r.id, hostname: r.hostname }));
    }

    return c.json({
      data,
      pagination: { page, limit, total },
      ...(matchingIds !== undefined && { matchingIds }),
    });
  }
);

function hasValidFilterConditions(group: FilterConditionGroup): boolean {
  return group.conditions.some((c) => {
    if ('conditions' in c) return hasValidFilterConditions(c as FilterConditionGroup);
    return c.value !== '' && c.value !== null && c.value !== undefined;
  });
}
