import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, eq, gt, inArray, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { requirePartnerApiScope } from '../../middleware/partnerApiAuth';
import {
  decodePartnerExportCursor,
  encodePartnerExportCursor,
  PartnerExportCursorError,
  type PartnerExportCursorFilters,
} from './cursor';
import { safelyExportDefinition } from './exportSafety';
import { normalizePartnerExportLimit, PartnerExportPaginationError } from './pagination';
import {
  partnerDeviceStatusEnvelopeSchema,
  partnerExportCursorTokenSchema,
  PARTNER_DEVICE_STATUSES,
  type PartnerDeviceStatusRecord,
  type PartnerExportBlockedRecord,
} from './schemas';

/**
 * GET /api/v1/partner-api/device-status (device-status:read, #7577) — live
 * per-device status, last-seen time and agent version across the principal's
 * accessible organizations.
 *
 * This is LIVE STATE read at request time, deliberately outside the
 * material-change export (`/devices` and friends):
 * - no `revision` / `sourceUpdatedAt` / `snapshotAt`, and no `updatedSince` —
 *   heartbeats change these fields constantly, so there is no change feed;
 *   poll the whole list;
 * - no partner-export per-org advisory read locks and no writes to any
 *   partner-export table — liveness must never ride the watermark protocol
 *   that takes exclusive org locks on material writes (see #6698).
 *
 * Paging is a keyset on device id with the shared signed cursor. A traversal
 * covers devices created before it started; each row is its state when that
 * page was read, so two pages of one traversal can reflect different moments.
 * Tenant scope: RLS (partner context held by partnerApiAuthMiddleware) plus
 * the principal's accessible org set in the WHERE clause, same as /devices.
 */
export const partnerDeviceStatusRoutes = new Hono();

const RESOURCE = 'device-status' as const;
const CURSOR_LIFETIME_MS = 24 * 60 * 60 * 1000;
const UUID = z.string().uuid();

const statusList = z.string().max(200).transform((raw, ctx) => {
  const items = [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))].sort();
  if (items.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'empty list' });
    return z.NEVER;
  }
  for (const item of items) {
    if (!(PARTNER_DEVICE_STATUSES as readonly string[]).includes(item)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unsupported status' });
      return z.NEVER;
    }
  }
  return items as (typeof PARTNER_DEVICE_STATUSES)[number][];
});

const querySchema = z.object({
  orgId: UUID.optional(),
  siteId: UUID.optional(),
  status: statusList.optional(),
  cursor: partnerExportCursorTokenSchema.optional(),
  limit: z.string().optional(),
}).strict();

function invalidQuery(c: Context) {
  return c.json({ error: 'Invalid partner device status query.', code: 'invalid_partner_export_query' }, 400);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PartnerExportPaginationError('Invalid source timestamp.');
  return date.toISOString();
}

partnerDeviceStatusRoutes.get('/device-status', requirePartnerApiScope('device-status:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
  if (!parsed.success) return invalidQuery(c);
  const query = parsed.data;
  if (query.orgId && !principal.accessibleOrgIds.includes(query.orgId)) {
    return c.json({ error: 'Organization not found.', code: 'partner_export_org_not_found' }, 404);
  }

  try {
    const limit = normalizePartnerExportLimit(query.limit);
    const filters: PartnerExportCursorFilters = {
      orgId: query.orgId ?? null,
      siteId: query.siteId ?? null,
      status: query.status ? query.status.join(',') : null,
    };
    const cursor = query.cursor
      ? decodePartnerExportCursor(query.cursor, {
        partnerId: principal.partnerId, resource: RESOURCE, updatedSince: null, filters,
      })
      : null;
    // The traversal start bounds membership (createdAt <= startedAt) so paging
    // is stable; it is NOT a data snapshot and is never returned.
    const startedAt = cursor ? cursor.snapshotAt : new Date().toISOString();
    const orgIds = query.orgId ? [query.orgId] : [...principal.accessibleOrgIds];
    if (orgIds.length === 0) {
      return c.json(partnerDeviceStatusEnvelopeSchema.parse({
        schemaVersion: '1', data: [], nextCursor: null, hasMore: false,
      }));
    }

    const conditions: SQL[] = [
      inArray(devices.orgId, orgIds),
      // Ephemeral Quick Support devices never appear in the Partner API.
      eq(devices.isEphemeral, false),
      lte(devices.createdAt, new Date(startedAt)),
    ];
    if (query.siteId) conditions.push(eq(devices.siteId, query.siteId));
    if (query.status) conditions.push(inArray(devices.status, query.status));
    if (cursor) conditions.push(gt(devices.id, cursor.lastId));

    const rows = await db.select({
      deviceId: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      agentVersion: devices.agentVersion,
      createdAt: devices.createdAt,
    }).from(devices)
      .where(and(...conditions))
      .orderBy(asc(devices.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const data: PartnerDeviceStatusRecord[] = [];
    const blocked: PartnerExportBlockedRecord[] = [];
    for (const row of pageRows) {
      const record: PartnerDeviceStatusRecord = {
        deviceId: row.deviceId,
        orgId: row.orgId,
        siteId: row.siteId,
        status: row.status,
        lastSeenAt: iso(row.lastSeenAt),
        agentVersion: row.agentVersion,
      };
      // agentVersion is agent-reported; the precise secret layers still run.
      const inspected = safelyExportDefinition({ resource: RESOURCE, id: row.deviceId, orgId: row.orgId }, record);
      if (inspected.safe) data.push(inspected.definition);
      else blocked.push(inspected.blocked);
    }

    const last = pageRows.at(-1);
    const nextCursor = hasMore && last
      ? encodePartnerExportCursor({
        v: 1,
        resource: RESOURCE,
        partnerId: principal.partnerId,
        snapshotAt: startedAt,
        updatedSince: null,
        filters,
        lastUpdatedAt: null,
        lastId: last.deviceId,
        lastOrgId: last.orgId,
        expiresAt: new Date(Date.parse(startedAt) + CURSOR_LIFETIME_MS).toISOString(),
      })
      : null;
    return c.json(partnerDeviceStatusEnvelopeSchema.parse({
      schemaVersion: '1',
      data,
      nextCursor,
      hasMore,
      ...(blocked.length > 0 ? { blocked } : {}),
    }));
  } catch (error) {
    if (error instanceof PartnerExportCursorError || error instanceof PartnerExportPaginationError) {
      return c.json({ error: error.message, code: error.code }, 400);
    }
    return c.json({ error: 'Partner device status export failed.', code: 'partner_export_failed' }, 500);
  }
});
