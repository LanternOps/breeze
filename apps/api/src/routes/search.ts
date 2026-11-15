import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { alerts, devices, organizations, scripts } from '../db/schema';
import { authMiddleware, type AuthContext } from '../middleware/auth';
import { alertSiteScopeCondition } from './alerts/helpers';
import { getUserPermissions, hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // Hard narrowing to one org: the palette's "This customer only" toggle.
  // It can never widen past the caller's access (#9612).
  orgId: z.string().uuid().optional(),
  // Ranking hint only (#11803): the org selected in the header. Its matches sort
  // first inside each category; every other accessible org still appears.
  preferOrgId: z.string().uuid().optional()
});

/**
 * Leading ORDER BY term that sorts the preferred org's rows first, or no term
 * at all without a preference (a bare constant would read as a column position).
 */
function preferFirst(preferOrgId: string | undefined, matches: (orgId: string) => SQL): SQL[] {
  if (!preferOrgId) return [];
  return [asc(sql`CASE WHEN ${matches(preferOrgId)} THEN 0 ELSE 1 END`)];
}

/**
 * Relevance rank for a case-insensitive match of `q`: 0 = some column equals
 * it exactly, 1 = some column starts with it, 2 = substring only. Callers
 * already filter on a substring match, so 2 is the floor. `starts_with` rather
 * than LIKE so `%` / `_` in the query are not wildcards here.
 */
function matchRank(q: string, columns: PgColumn[]): SQL {
  const needle = sql`lower(${q})`;
  const exact = sql.join(columns.map((col) => sql`lower(${col}) = ${needle}`), sql` OR `);
  const prefix = sql.join(columns.map((col) => sql`starts_with(lower(${col}), ${needle})`), sql` OR `);
  return sql`CASE WHEN ${exact} THEN 0 WHEN ${prefix} THEN 1 ELSE 2 END`;
}

// Settings results are intentionally NOT served here (#8365): the web palette
// builds them from its settings page catalogue (localized, gated like the nav).

type DeviceSearchRow = {
  id: string;
  orgId: string;
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
    orgId: row.orgId,
    title,
    description: descriptionParts.filter(Boolean).join(' · ') || undefined
  };
}

export const searchRoutes = new Hono();

searchRoutes.use('*', authMiddleware);

searchRoutes.get('/', zValidator('query', searchQuerySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { q, limit = 20, orgId: selectedOrgId, preferOrgId } = c.req.valid('query');
  // Validate before any query runs. canAccessOrg is the caller's own access
  // list (system scope: any org), so narrowing can only ever shrink it. The
  // ranking hint is checked the same way: it filters nothing, but answering it
  // for a foreign org would still confirm that org's id (#11803).
  for (const requested of [selectedOrgId, preferOrgId]) {
    if (requested && !auth.canAccessOrg(requested)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }
  }
  const perCategoryLimit = Math.max(1, Math.min(8, Math.ceil(limit / 4)));
  const searchTerm = `%${q}%`;
  // Pass the token scope, as requirePermission does (#5733): the resolver's
  // platform-admin branch needs it, and without it a system token resolved to
  // null and every category below came back empty.
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
    scope: auth.scope,
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

  // The caller's access condition, AND-ed with the selected org when one is
  // given. Narrowing is additive, never a replacement for the access check.
  const orgConditionFor = (column: PgColumn): SQL | undefined => {
    const access = typeof auth?.orgCondition === 'function' ? auth.orgCondition(column) : undefined;
    if (!selectedOrgId) return access;
    return access ? and(access, eq(column, selectedOrgId)) : eq(column, selectedOrgId);
  };

  // Scripts are dual-axis (org_id XOR partner_id), so a strict org condition
  // hides every partner-wide script from global search — a tech could see a
  // script on /scripts and get zero results for its exact name in Cmd+K.
  //
  // Gated on `scope === 'partner'` deliberately: an org-scoped token carries a
  // partnerId but never passes `breeze_has_partner_access`, so widening the
  // app-layer condition for it would ask for rows RLS refuses to return —
  // RLS is stricter than the app layer here, and the two must not disagree.
  const scriptsOrgCondition = (() => {
    const orgOwned = orgConditionFor(scripts.orgId);
    // No org condition at all means a system-scoped caller with no selected
    // org: already unfiltered.
    if (!orgOwned) return undefined;
    // A system caller narrowed to one org still sees that org's partner-wide
    // scripts — the partner is the selected org's own.
    if (auth?.scope === 'system' && selectedOrgId) {
      return or(
        orgOwned,
        and(
          isNull(scripts.orgId),
          sql`${scripts.partnerId} = (SELECT ${organizations.partnerId} FROM ${organizations} WHERE ${organizations.id} = ${selectedOrgId})`,
        ),
      );
    }
    if (auth?.scope !== 'partner' || !auth.partnerId) return orgOwned;
    // The selected org (when given) passed canAccessOrg, so it belongs to this
    // partner and the partner-wide branch stays correct under narrowing.
    return or(orgOwned, and(isNull(scripts.orgId), eq(scripts.partnerId, auth.partnerId)));
  })();

  // Site-axis narrowing (app-layer only; RLS does NOT enforce site isolation).
  // mirrors core.ts:~424-435 / reports/data.ts:~67-72.
  const allowedSiteIds = (userPerms as UserPermissions | null)?.allowedSiteIds;
  const deviceSiteCondition = allowedSiteIds
    ? allowedSiteIds.length > 0
      ? inArray(devices.siteId, allowedSiteIds)
      : sql`false`
    : undefined;
  // Alerts follow their OWNING site (a topology policy alert's topology site,
  // M3-D6), never only the origin device's — the shared alert predicate.
  const alertSiteCondition = alertSiteScopeCondition(allowedSiteIds);

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

  // Deterministic order before LIMIT (#9612): an unordered LIMIT returned an
  // arbitrary subset, so an exact match could be cut and results reshuffled
  // between runs. The preferred org first (#11803), then relevance, then name,
  // then id as the stable tiebreak.
  const deviceOrder = [
    ...preferFirst(preferOrgId, (orgId) => sql`${devices.orgId} = ${orgId}`),
    asc(matchRank(q, [devices.hostname, devices.displayName])),
    asc(sql`lower(coalesce(nullif(btrim(${devices.displayName}), ''), ${devices.hostname}))`),
    asc(devices.id),
  ];
  // A partner-wide script runs in every org of its partner, so it counts as the
  // preferred org's own; another partner's partner-wide script (system scope)
  // does not.
  const scriptOrder = [
    ...preferFirst(preferOrgId, (orgId) => sql`(${scripts.orgId} = ${orgId} OR (${scripts.orgId} IS NULL AND ${scripts.partnerId} = (SELECT ${organizations.partnerId} FROM ${organizations} WHERE ${organizations.id} = ${orgId})))`),
    asc(matchRank(q, [scripts.name])),
    asc(sql`lower(${scripts.name})`),
    asc(scripts.id),
  ];
  // Alerts are events: newest first is the useful order.
  const alertOrder = [
    ...preferFirst(preferOrgId, (orgId) => sql`${alerts.orgId} = ${orgId}`),
    desc(alerts.triggeredAt),
    asc(alerts.id),
  ];

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
            orgId: devices.orgId,
            title: devices.displayName,
            hostname: devices.hostname,
            status: devices.status,
            lastUser: devices.lastUser
          })
          .from(devices)
          .where(deviceWhereCondition)
          .orderBy(...deviceOrder)
          .limit(perCategoryLimit)
      : Promise.resolve([]),
    canReadScripts
      ? db
          .select({
            id: scripts.id,
            orgId: scripts.orgId,
            title: scripts.name,
            description: scripts.description
          })
          .from(scripts)
          .where(scriptsOrgCondition ? and(scriptsOrgCondition as never, scriptQuery as never) : scriptQuery)
          .orderBy(...scriptOrder)
          .limit(perCategoryLimit)
      : Promise.resolve([]),
    canReadAlerts
      ? allowedSiteIds
        ? db
          .select({
            id: alerts.id,
            orgId: alerts.orgId,
            title: alerts.title,
            message: alerts.message,
            severity: alerts.severity
          })
          .from(alerts)
          .leftJoin(devices, eq(alerts.deviceId, devices.id))
          .where(and(orgConditionFor(alerts.orgId), alertSiteCondition, alertQuery))
          .orderBy(...alertOrder)
          .limit(perCategoryLimit)
        : db
          .select({
            id: alerts.id,
            orgId: alerts.orgId,
            title: alerts.title,
            message: alerts.message,
            severity: alerts.severity
          })
          .from(alerts)
          .where(orgConditionFor(alerts.orgId) ? and(orgConditionFor(alerts.orgId) as never, alertQuery as never) : alertQuery)
          .orderBy(...alertOrder)
          .limit(perCategoryLimit)
      : Promise.resolve([])
  ]);

  const results: Array<Record<string, unknown> & { orgId: string | null }> = [
    ...deviceRows.map((row) => deviceSearchResult(row) as Record<string, unknown> & { orgId: string }),
    ...scriptRows.map((row) => ({
      id: row.id,
      type: 'scripts',
      // null = partner-wide: the script belongs to no single customer.
      orgId: row.orgId ?? null,
      title: row.title,
      description: row.description || undefined
    })),
    ...alertRows.map((row) => ({
      id: row.id,
      type: 'alerts',
      orgId: row.orgId,
      title: row.title,
      description: row.severity || row.message || undefined
    }))
  ].slice(0, limit);

  // Label every result with its customer (#11803). One lookup for the few ids
  // on this page, in the caller's own context, so RLS decides which names it
  // may read; a name it cannot read stays null rather than failing the search.
  const orgIds = [...new Set(results.map((r) => r.orgId).filter((id): id is string => typeof id === 'string'))];
  const orgNames = new Map<string, string>();
  if (orgIds.length > 0) {
    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));
    for (const row of orgRows) orgNames.set(row.id, row.name);
  }

  return c.json({
    results: results.map((r) => ({ ...r, orgName: r.orgId ? orgNames.get(r.orgId) ?? null : null })),
  });
});
