import { Hono } from 'hono';
import { and, inArray, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  deviceGroupMemberships,
  deviceGroups,
  deviceHardware,
  devices,
} from '../../db/schema';
import { requirePartnerApiScope } from '../../middleware/partnerApiAuth';
import { getPartnerExportFetchLimit } from './pagination';
import { deviceExportEnvelopeSchema } from './schemas';
import {
  buildEnvelope,
  normalizeSourceRow,
  paginationConditions,
  paginationOrder,
  parseExportQuery,
} from './organizations';

const deviceFilterSchema = z.string().uuid();

export const partnerDeviceRoutes = new Hono();

partnerDeviceRoutes.get('/devices', requirePartnerApiScope('devices:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = parseExportQuery(c, 'devices', principal);
  if (parsed instanceof Response) return parsed;

  const siteIdRaw = new URL(c.req.url).searchParams.get('siteId');
  const siteIdResult = siteIdRaw === null ? { success: true as const, data: null } : deviceFilterSchema.safeParse(siteIdRaw);
  if (!siteIdResult.success) {
    return c.json({ error: 'Invalid partner export query.', code: 'invalid_partner_export_query' }, 400);
  }

  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    if (orgIds.length === 0) return c.json(deviceExportEnvelopeSchema.parse(buildEnvelope({
      resource: 'devices', partnerId: principal.partnerId, rows: [], query: parsed, makeRecord: () => ({}),
    })));
    // Hardware identity is part of this DTO. Fold its change timestamp into
    // the device keyset so an inventory refresh is not missed merely because
    // the parent device row itself was untouched.
    const effectiveUpdatedAt = sql<Date>`GREATEST(
      ${devices.updatedAt},
      COALESCE(${deviceHardware.updatedAt}, ${devices.updatedAt})
    )`;
    const conditions = [
      inArray(devices.orgId, orgIds),
      ...(siteIdResult.data ? [eq(devices.siteId, siteIdResult.data)] : []),
      ...paginationConditions({ id: devices.id, orgId: devices.orgId, createdAt: devices.createdAt, updatedAt: effectiveUpdatedAt }, parsed.traversal),
    ];
    const rows = await db.select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      deviceRole: devices.deviceRole,
      isVirtual: devices.isVirtual,
      virtualizationPlatform: devices.virtualizationPlatform,
      osVersion: devices.osVersion,
      osBuild: devices.osBuild,
      architecture: devices.architecture,
      enrolledAt: devices.enrolledAt,
      linkGroupId: devices.linkGroupId,
      linkGroupRole: devices.linkGroupRole,
      tags: devices.tags,
      customFields: devices.customFields,
      serialNumber: deviceHardware.serialNumber,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      createdAt: devices.createdAt,
      updatedAt: effectiveUpdatedAt,
    }).from(devices)
      .leftJoin(deviceHardware, and(eq(deviceHardware.deviceId, devices.id), eq(deviceHardware.orgId, devices.orgId)))
      .where(and(...conditions))
      .orderBy(...paginationOrder({ id: devices.id, orgId: devices.orgId, updatedAt: effectiveUpdatedAt }, parsed.traversal))
      .limit(getPartnerExportFetchLimit(parsed.limit));

    const normalized = rows.map(normalizeSourceRow);
    const exportedRows = normalized.slice(0, parsed.limit);
    const ids = exportedRows.map((row) => row.id);
    const memberships = ids.length === 0 ? [] : await db.select({
      deviceId: deviceGroupMemberships.deviceId,
      groupId: deviceGroupMemberships.groupId,
    }).from(deviceGroupMemberships)
      .innerJoin(deviceGroups, and(
        eq(deviceGroups.id, deviceGroupMemberships.groupId),
        eq(deviceGroups.orgId, deviceGroupMemberships.orgId),
      ))
      .where(and(
        inArray(deviceGroupMemberships.deviceId, ids),
        inArray(deviceGroupMemberships.orgId, orgIds),
      ));
    const groupIds = new Map<string, string[]>();
    for (const membership of memberships) {
      const list = groupIds.get(membership.deviceId) ?? [];
      if (!list.includes(membership.groupId)) list.push(membership.groupId);
      groupIds.set(membership.deviceId, list);
    }
    for (const list of groupIds.values()) list.sort();

    const envelope = buildEnvelope({
      resource: 'devices', partnerId: principal.partnerId, rows: normalized, query: parsed,
      makeRecord: (row) => ({
        id: row.id, orgId: row.orgId, siteId: row.siteId, sourceUpdatedAt: row.updatedAt,
        hostname: row.hostname, displayName: row.displayName,
        type: {
          os: row.osType, role: row.deviceRole, virtual: row.isVirtual,
          virtualizationPlatform: row.virtualizationPlatform,
        },
        operatingSystem: { edition: row.osVersion, build: row.osBuild, architecture: row.architecture },
        installation: { enrolledAt: row.enrolledAt instanceof Date ? row.enrolledAt.toISOString() : new Date(row.enrolledAt as string).toISOString() },
        hardwareIdentity: {
          serialNumber: row.serialNumber, manufacturer: row.manufacturer, model: row.model,
        },
        stableIdentifiers: {
          assetTag: stringCustomIdentifier(row.customFields, ['assetTag', 'asset_tag']),
          inventoryId: stringCustomIdentifier(row.customFields, ['inventoryId', 'inventory_id']),
          externalId: stringCustomIdentifier(row.customFields, ['externalId', 'external_id']),
        },
        tags: Array.isArray(row.tags) ? row.tags : [],
        groupIds: groupIds.get(row.id) ?? [],
        linkGroupId: row.linkGroupId,
        linkGroupRole: row.linkGroupRole,
      }),
    });
    return c.json(deviceExportEnvelopeSchema.parse(envelope));
  } catch {
    return c.json({ error: 'Partner device export failed.', code: 'partner_export_failed' }, 500);
  }
});

function stringCustomIdentifier(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 255);
  }
  return null;
}
