import { Hono } from 'hono';
import { and, inArray, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  deviceGroupMemberships,
  deviceHardware,
  devices,
} from '../../db/schema';
import { requirePartnerApiScope } from '../../middleware/partnerApiAuth';
import { getPartnerExportFetchLimit } from './pagination';
import { deviceExportEnvelopeSchema } from './schemas';
import {
  buildEnvelope,
  bindPartnerExportSnapshot,
  clientError,
  isKnownClientError,
  normalizeSourceRow,
  paginationConditions,
  paginationOrder,
  parseExportQuery,
} from './organizations';
import { acquirePartnerExportReadLocks } from './consistency';

export const PARTNER_DEVICE_GROUP_ID_LIMIT = 500;

export const partnerDeviceRoutes = new Hono();

partnerDeviceRoutes.get('/devices', requirePartnerApiScope('devices:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = parseExportQuery(c, 'devices', principal);
  if (parsed instanceof Response) return parsed;

  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    const lockSnapshotAt = await acquirePartnerExportReadLocks(orgIds);
    bindPartnerExportSnapshot(parsed, lockSnapshotAt);
    if (orgIds.length === 0) return c.json(deviceExportEnvelopeSchema.parse(buildEnvelope({
      resource: 'devices', partnerId: principal.partnerId, rows: [], query: parsed, makeRecord: () => ({}),
    })));
    // Hardware identity is part of this DTO. Fold its change timestamp into
    // the device keyset so an inventory refresh is not missed merely because
    // the parent device row itself was untouched.
    const effectiveUpdatedAt = sql<Date>`GREATEST(
      ${devices.partnerExportUpdatedAt},
      COALESCE(${deviceHardware.partnerExportUpdatedAt}, ${devices.partnerExportUpdatedAt})
    )`.mapWith(devices.partnerExportUpdatedAt);
    const conditions = [
      inArray(devices.orgId, orgIds),
      ...(parsed.siteId ? [eq(devices.siteId, parsed.siteId)] : []),
      ...paginationConditions({
        id: devices.id,
        orgId: devices.orgId,
        createdAt: devices.createdAt,
        updatedAt: effectiveUpdatedAt,
        updatedAtParam: devices.partnerExportUpdatedAt,
      }, parsed.traversal),
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
      groupIds: sql<string[]>`COALESCE((
        SELECT jsonb_agg(m.group_id ORDER BY m.group_id)
        FROM (
          SELECT ${deviceGroupMemberships.groupId} AS group_id
          FROM ${deviceGroupMemberships}
          WHERE ${deviceGroupMemberships.deviceId} = ${devices.id}
            AND ${deviceGroupMemberships.orgId} = ${devices.orgId}
          ORDER BY ${deviceGroupMemberships.groupId}
          LIMIT ${PARTNER_DEVICE_GROUP_ID_LIMIT}
        ) AS m
      ), '[]'::jsonb)`,
      groupCount: sql<number>`(
        SELECT COUNT(*)::integer
        FROM ${deviceGroupMemberships}
        WHERE ${deviceGroupMemberships.deviceId} = ${devices.id}
          AND ${deviceGroupMemberships.orgId} = ${devices.orgId}
      )`,
      createdAt: devices.createdAt,
      updatedAt: effectiveUpdatedAt,
    }).from(devices)
      .leftJoin(deviceHardware, and(eq(deviceHardware.deviceId, devices.id), eq(deviceHardware.orgId, devices.orgId)))
      .where(and(...conditions))
      .orderBy(...paginationOrder({ id: devices.id, orgId: devices.orgId, updatedAt: effectiveUpdatedAt }, parsed.traversal))
      .limit(getPartnerExportFetchLimit(parsed.limit));

    const normalized = rows.map(normalizeSourceRow);
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
        groupIds: normalizedGroupIds(row.groupIds),
        groupMembership: groupMembershipSummary(row.groupIds, row.groupCount),
        linkGroupId: row.linkGroupId,
        linkGroupRole: row.linkGroupRole,
      }),
    });
    return c.json(deviceExportEnvelopeSchema.parse(envelope));
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
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

function normalizedGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))]
    .sort()
    .slice(0, PARTNER_DEVICE_GROUP_ID_LIMIT);
}

function groupMembershipSummary(groupIds: unknown, count: unknown) {
  const included = normalizedGroupIds(groupIds).length;
  if (!Number.isSafeInteger(count) || (count as number) < included || (count as number) < 0) {
    throw new TypeError('Invalid device group membership count.');
  }
  const total = count as number;
  const complete = total === included;
  return {
    total,
    included,
    complete,
    reason: complete ? null : 'membership_limit_exceeded' as const,
  };
}
