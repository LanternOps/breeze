import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { alerts, devices, scripts } from '../db/schema';
import { authMiddleware, type AuthContext } from '../middleware/auth';
import { getUserPermissions, hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const SETTINGS_ENTRIES = [
  { id: 'settings-profile', type: 'settings', title: 'Profile settings', description: 'Manage your profile', href: '/settings/profile' },
  { id: 'settings-security', type: 'settings', title: 'Security settings', description: 'Manage MFA and account security', href: '/settings/security' },
  { id: 'settings-users', type: 'settings', title: 'User management', description: 'Manage users and roles', href: '/settings/users' }
] as const;

type DeviceSearchRow = {
  id: string;
  title: string | null;
  hostname: string | null;
  status: string | null;
  lastUser: string | null;
};

function deviceSearchResult(row: DeviceSearchRow): Record<string, unknown> {
  const displayName = row.title?.trim() || null;
  const hostname = row.hostname?.trim() || null;
  const title = displayName || hostname || 'Unknown device';
  const descriptionParts = [
    displayName && hostname && displayName !== hostname ? hostname : null,
    row.status,
    row.lastUser
  ];

  return {
    id: row.id,
    type: 'devices',
    title,
    description: descriptionParts.filter(Boolean).join(' · ') || undefined
  };
}

export const searchRoutes = new Hono();

searchRoutes.use('*', authMiddleware);

searchRoutes.get('/', zValidator('query', searchQuerySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { q, limit = 20 } = c.req.valid('query');
  const perCategoryLimit = Math.max(1, Math.min(8, Math.ceil(limit / 4)));
  const searchTerm = `%${q}%`;
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
  });

  const canReadDevices = Boolean(
    userPerms && hasPermission(userPerms, PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  );
  const canReadScripts = Boolean(
    userPerms && hasPermission(userPerms, PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  );
  const canReadAlerts = Boolean(
    userPerms && hasPermission(userPerms, PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action),
  );
  const canReadUsers = Boolean(
    userPerms && hasPermission(userPerms, PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  );

  const orgConditionFor = (column: PgColumn) => {
    if (typeof auth?.orgCondition !== 'function') {
      return undefined;
    }
    return auth.orgCondition(column);
  };

  // Site-axis narrowing (app-layer only; RLS does NOT enforce site isolation).
  // mirrors core.ts:~424-435 / reports/data.ts:~67-72.
  const allowedSiteIds = (userPerms as UserPermissions | null)?.allowedSiteIds;
  const deviceSiteCondition = allowedSiteIds
    ? allowedSiteIds.length > 0
      ? inArray(devices.siteId, allowedSiteIds)
      : sql`false`
    : undefined;
  const alertSiteCondition = allowedSiteIds
    ? allowedSiteIds.length > 0
      ? or(isNull(alerts.deviceId), inArray(devices.siteId, allowedSiteIds))
      : isNull(alerts.deviceId)
    : undefined;

  const deviceQuery = or(
    ilike(devices.hostname, searchTerm),
    ilike(devices.displayName, searchTerm),
    ilike(devices.lastUser, searchTerm)
  );
  const scriptQuery = and(
    isNull(scripts.deletedAt),
    or(
      ilike(scripts.name, searchTerm),
      ilike(scripts.description, searchTerm)
    )
  );
  const alertQuery = or(
    ilike(alerts.title, searchTerm),
    ilike(alerts.message, searchTerm)
  );

  const deviceWhereCondition = and(
    orgConditionFor(devices.orgId),
    deviceSiteCondition,
    deviceQuery,
  );

  const [deviceRows, scriptRows, alertRows] = await Promise.all([
    canReadDevices
      ? db
          .select({
            id: devices.id,
            title: devices.displayName,
            hostname: devices.hostname,
            status: devices.status,
            lastUser: devices.lastUser
          })
          .from(devices)
          .where(deviceWhereCondition)
          .limit(perCategoryLimit)
      : Promise.resolve([]),
    canReadScripts
      ? db
          .select({
            id: scripts.id,
            title: scripts.name,
            description: scripts.description
          })
          .from(scripts)
          .where(orgConditionFor(scripts.orgId) ? and(orgConditionFor(scripts.orgId) as never, scriptQuery as never) : scriptQuery)
          .limit(perCategoryLimit)
      : Promise.resolve([]),
    canReadAlerts
      ? allowedSiteIds
        ? db
          .select({
            id: alerts.id,
            title: alerts.title,
            message: alerts.message,
            severity: alerts.severity
          })
          .from(alerts)
          .leftJoin(devices, eq(alerts.deviceId, devices.id))
          .where(and(orgConditionFor(alerts.orgId), alertSiteCondition, alertQuery))
          .limit(perCategoryLimit)
        : db
          .select({
            id: alerts.id,
            title: alerts.title,
            message: alerts.message,
            severity: alerts.severity
          })
          .from(alerts)
          .where(orgConditionFor(alerts.orgId) ? and(orgConditionFor(alerts.orgId) as never, alertQuery as never) : alertQuery)
          .limit(perCategoryLimit)
      : Promise.resolve([])
  ]);

  const results: Array<Record<string, unknown>> = [
    ...deviceRows.map((row) => deviceSearchResult(row)),
    ...scriptRows.map((row) => ({
      id: row.id,
      type: 'scripts',
      title: row.title,
      description: row.description || undefined
    })),
    ...alertRows.map((row) => ({
      id: row.id,
      type: 'alerts',
      title: row.title,
      description: row.severity || row.message || undefined
    }))
  ];

  const loweredQuery = q.toLowerCase();
  for (const entry of SETTINGS_ENTRIES) {
    if (entry.id === 'settings-users' && !canReadUsers) {
      continue;
    }
    const haystack = `${entry.title} ${entry.description}`.toLowerCase();
    if (haystack.includes(loweredQuery)) {
      results.push({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        description: entry.description,
        href: entry.href
      });
    }
  }

  return c.json({ results: results.slice(0, limit) });
});
