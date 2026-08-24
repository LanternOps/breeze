import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { DeviceOption, DeviceOptionPage } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { devices, deviceStatusEnum, osTypeEnum, sites } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { UUID_REGEX } from '../../utils/uuid';
import {
  buildDeviceOptionsFingerprint,
  decodeDeviceOptionsCursor,
  encodeDeviceOptionsCursor,
} from './optionsCursor';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_INCLUDE_IDS = 500;

const includeIdsSchema = z.string().optional().transform((raw, context) => {
  if (!raw) return [];
  const ids = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (ids.length > MAX_INCLUDE_IDS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `includeIds accepts at most ${MAX_INCLUDE_IDS} IDs` });
    return z.NEVER;
  }
  for (const id of ids) {
    if (!UUID_REGEX.test(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `invalid UUID: ${id}` });
      return z.NEVER;
    }
  }
  return ids;
});

const optionsQuerySchema = z.object({
  search: z.string().trim().max(255).optional().transform((value) => value || undefined),
  cursor: z.string().max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  status: z.enum(deviceStatusEnum.enumValues).optional(),
  siteId: z.string().guid().optional(),
  osType: z.enum(osTypeEnum.enumValues).optional(),
  orgId: z.string().guid().optional(),
  includeIds: includeIdsSchema,
});

type OptionRow = DeviceOption & { normalizedLabel: string };

const normalizedVisibleLabel = sql<string>`lower(coalesce(nullif(btrim(${devices.displayName}), ''), ${devices.hostname}))`;

const optionSelection = {
  id: devices.id,
  hostname: devices.hostname,
  displayName: devices.displayName,
  osType: devices.osType,
  status: devices.status,
  siteId: devices.siteId,
  siteName: sites.name,
  normalizedLabel: normalizedVisibleLabel,
};

function publicOption(row: OptionRow): DeviceOption {
  return {
    id: row.id,
    hostname: row.hostname,
    displayName: row.displayName,
    osType: row.osType,
    status: row.status,
    siteId: row.siteId,
    siteName: row.siteName,
  };
}

function compareOptionRows(left: OptionRow, right: OptionRow): number {
  if (left.normalizedLabel < right.normalizedLabel) return -1;
  if (left.normalizedLabel > right.normalizedLabel) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export const optionsRoutes = new Hono();

optionsRoutes.use('*', authMiddleware);

optionsRoutes.get(
  '/options',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', optionsQuerySchema),
  async (c) => {
    const observedAt = new Date().toISOString();
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');

    // requirePermission always installs this context. Fail closed if that
    // contract is broken because site restrictions have no RLS backstop.
    if (!permissions) {
      return c.json({ error: 'Permission context unavailable' }, 403);
    }

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const allowedSiteIds = permissions.allowedSiteIds;
    if (query.siteId && allowedSiteIds && !allowedSiteIds.includes(query.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Validate an explicit site through an org-scoped identity-only lookup.
    // Missing and foreign sites deliberately share the same response, so the
    // selector cannot be used to enumerate cross-tenant site metadata.
    if (query.siteId) {
      const siteConditions: SQL[] = [eq(sites.id, query.siteId)];
      const siteOrgCondition = auth.orgCondition(sites.orgId);
      if (siteOrgCondition) siteConditions.push(siteOrgCondition);
      if (query.orgId) siteConditions.push(eq(sites.orgId, query.orgId));
      const [site] = await db
        .select({ id: sites.id, orgId: sites.orgId })
        .from(sites)
        .where(and(...siteConditions))
        .limit(1);
      if (!site) return c.json({ error: 'Access to this site denied' }, 403);
    }

    const fingerprint = buildDeviceOptionsFingerprint({
      search: query.search,
      status: query.status,
      siteId: query.siteId,
      osType: query.osType,
      orgId: query.orgId,
      scope: auth.scope,
      accessibleOrgIds: auth.accessibleOrgIds,
      allowedSiteIds,
    });
    const cursor = query.cursor
      ? decodeDeviceOptionsCursor(query.cursor, fingerprint)
      : null;
    if (query.cursor && !cursor) {
      return c.json({ error: 'Invalid, malformed, or mismatched cursor' }, 400);
    }

    // These predicates define the authorized supporting scope. Hydrated
    // includeIds remain inside this scope even though they bypass search,
    // status, and OS filters to preserve already-selected labels.
    const scopeConditions: SQL[] = [
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
    ];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) scopeConditions.push(orgCondition);
    if (query.orgId) scopeConditions.push(eq(devices.orgId, query.orgId));

    if (allowedSiteIds) {
      const effectiveSiteIds = query.siteId ? [query.siteId] : allowedSiteIds;
      scopeConditions.push(effectiveSiteIds.length > 0
        ? inArray(devices.siteId, effectiveSiteIds)
        : sql`false`);
    } else if (query.siteId) {
      scopeConditions.push(eq(devices.siteId, query.siteId));
    }

    const filteredConditions = [...scopeConditions];
    if (query.status) filteredConditions.push(eq(devices.status, query.status));
    if (query.osType) filteredConditions.push(eq(devices.osType, query.osType));
    if (query.search) {
      const pattern = `%${query.search}%`;
      filteredConditions.push(or(
        ilike(devices.hostname, pattern),
        ilike(devices.displayName, pattern),
      )!);
    }

    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(and(...filteredConditions));
    const total = Number(totalRows[0]?.count ?? 0);

    const pageConditions = [...filteredConditions];
    if (cursor) {
      pageConditions.push(sql`(
        ${normalizedVisibleLabel} > ${cursor.label}
        OR (${normalizedVisibleLabel} = ${cursor.label} AND ${devices.id} > ${cursor.id}::uuid)
      )`);
    }

    const pageRows = await db
      .select(optionSelection)
      .from(devices)
      .leftJoin(sites, eq(devices.siteId, sites.id))
      .where(and(...pageConditions))
      .orderBy(normalizedVisibleLabel, devices.id)
      .limit(query.limit + 1) as OptionRow[];

    const hasMore = pageRows.length > query.limit;
    const visiblePage = hasMore ? pageRows.slice(0, query.limit) : pageRows;
    const lastPageRow = visiblePage.at(-1);
    const nextCursor = hasMore && lastPageRow
      ? encodeDeviceOptionsCursor({
          v: 1,
          label: lastPageRow.normalizedLabel,
          id: lastPageRow.id,
          fingerprint,
        })
      : null;

    let includedRows: OptionRow[] = [];
    if (query.includeIds.length > 0) {
      includedRows = await db
        .select(optionSelection)
        .from(devices)
        .leftJoin(sites, eq(devices.siteId, sites.id))
        .where(and(...scopeConditions, inArray(devices.id, query.includeIds)))
        .orderBy(normalizedVisibleLabel, devices.id) as OptionRow[];
    }

    const union = new Map<string, OptionRow>();
    for (const row of visiblePage) union.set(row.id, row);
    for (const row of includedRows) union.set(row.id, row);
    const data = [...union.values()].sort(compareOptionRows).map(publicOption);

    const response: DeviceOptionPage = {
      data,
      page: {
        nextCursor,
        returned: data.length,
        total,
        hasMore,
        observedAt,
      },
    };
    return c.json(response);
  },
);
