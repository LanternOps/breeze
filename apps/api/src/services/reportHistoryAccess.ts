/**
 * #6771 — read-only report history for an active partner's OUT-OF-SERVICE orgs.
 *
 * Product decision B (#6699 / #6716): an active MSP may read the report
 * definitions and run metadata of its own suspended, churned, offboarding or
 * archived orgs; generate, schedule, export and download stay refused.
 *
 * Those orgs are never in `auth.accessibleOrgIds` (authMiddleware admits only
 * active/trial orgs, platform-wide — widening that would reopen devices,
 * scripts, remote access… for suspended tenants). This module is the separate,
 * OPT-IN capability that replaces it for exactly five GET routes
 * (`middleware/reportHistoryRoutes.ts`):
 *
 *  - DISCOVERY — `computeReportHistoryReach` runs in the auth bootstrap, next
 *    to `computeAccessibleOrgIds` and like it BEFORE the request transaction
 *    opens (its system read therefore holds no second pooled connection).
 *    It verifies everything the live report resolver would for 'read_history':
 *    active user of this partner, active non-deleted partner, exactly one live
 *    membership, org_access admitting the org (a `selected` user intersected
 *    with the RAW `partner_users.org_ids`, no Quick Support exception), and
 *    reports:read — from the org membership's role when the user has one in
 *    that org (org membership takes precedence and carries its site
 *    restriction), else from the partner role. Soft-deleted orgs are excluded:
 *    deletion must not bring access back.
 *  - DATABASE — the reach's org ids become `DbAccessContext.reportHistoryOrgIds`
 *    (GUC `breeze.report_history_org_ids`), read only by the additive FOR
 *    SELECT policies on `reports` / `report_runs`
 *    (migrations/2026-10-28-130000-report-history-read-policies.sql).
 *  - AUTHORITY — `resolveRequestReportHistoryAuthority` turns the verified
 *    reach into a report authority with NO database access at all, so the
 *    history path never escapes the request transaction (no
 *    `runOutsideDbContext` / `withSystemDbAccessContext`, the #1105 / #6671
 *    second-connection hazard).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  organizations,
  organizationUsers,
  partners,
  partnerUsers,
  permissions,
  rolePermissions,
  roles,
  users,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { permissionGrantMatches } from './permissionMatching';
import {
  normalizeSiteIds,
  siteScopeFingerprint,
  type LiveReportAuthorityResult,
  type LiveSiteScopeV1,
} from './siteScope';

/**
 * The org statuses whose report history an active partner may read. An
 * inclusion list, so a status added later stays excluded until someone admits
 * it. `purging` and `merging` are deliberately absent (data is being
 * destroyed / re-pointed); `active` and `trial` are ordinary accessible orgs.
 */
export const REPORT_HISTORY_ORG_STATUSES = ['suspended', 'churned', 'offboarding', 'archived'] as const;

/** An org-axis live scope: the only kinds a history reach can hold. */
export type ReportHistoryOrgScope = Extract<LiveSiteScopeV1, { kind: 'unrestricted' | 'restricted' }>;

export interface ReportHistoryReach {
  /** The history orgs, in a stable order. Never overlaps `accessibleOrgIds`. */
  readonly orgIds: readonly string[];
  /** The caller's live report scope in each history org. */
  readonly scopes: ReadonlyMap<string, ReportHistoryOrgScope>;
}

export const EMPTY_REPORT_HISTORY_REACH: ReportHistoryReach = Object.freeze({
  orgIds: Object.freeze([]) as readonly string[],
  scopes: new Map<string, ReportHistoryOrgScope>(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RoleGrantRow = {
  roleId: string;
  resource: string;
  action: string;
  roleScope: string;
  roleIsSystem: boolean;
  roleOrgId: string | null;
  rolePartnerId: string | null;
};

/**
 * Same ownership rule as siteScope's `roleGrantsReportAction` for the 'read'
 * permission: the role is of the expected scope and either a system role or
 * owned by the expected org/partner, and some grant matches reports:read
 * (wildcards included).
 */
function roleGrantsReportsRead(
  grants: readonly RoleGrantRow[],
  roleId: string,
  expected: { scope: 'organization'; orgId: string } | { scope: 'partner'; partnerId: string },
): boolean {
  return grants.some(
    (row) =>
      row.roleId === roleId &&
      row.roleScope === expected.scope &&
      (row.roleIsSystem ||
        (expected.scope === 'organization'
          ? row.roleOrgId === expected.orgId
          : row.rolePartnerId === expected.partnerId)) &&
      permissionGrantMatches(row, 'reports', 'read'),
  );
}

async function computeReachInSystemContext(partnerId: string, userId: string): Promise<ReportHistoryReach> {
  const memberships = await db
    .select({
      userStatus: users.status,
      userPartnerId: users.partnerId,
      partnerStatus: partners.status,
      partnerDeletedAt: partners.deletedAt,
      orgAccess: partnerUsers.orgAccess,
      orgIds: partnerUsers.orgIds,
      roleId: partnerUsers.roleId,
    })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .innerJoin(partners, eq(partners.id, partnerUsers.partnerId))
    .where(and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, partnerId)))
    .limit(2);
  // Zero rows = no live membership; two = unverifiable. Either way: nothing.
  if (memberships.length !== 1) return EMPTY_REPORT_HISTORY_REACH;
  const membership = memberships[0]!;
  if (membership.userStatus !== 'active' || membership.userPartnerId !== partnerId) {
    return EMPTY_REPORT_HISTORY_REACH;
  }
  if (membership.partnerStatus !== 'active' || membership.partnerDeletedAt != null) {
    return EMPTY_REPORT_HISTORY_REACH;
  }

  let selectedOrgIds: string[] | null = null;
  if (membership.orgAccess === 'selected') {
    // The RAW curated list — deliberately without computeAccessibleOrgIds'
    // Quick Support exception.
    selectedOrgIds = (membership.orgIds ?? []).filter(
      (value): value is string => typeof value === 'string' && UUID_RE.test(value),
    );
    if (selectedOrgIds.length === 0) return EMPTY_REPORT_HISTORY_REACH;
  } else if (membership.orgAccess !== 'all') {
    return EMPTY_REPORT_HISTORY_REACH;
  }

  const candidateRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.partnerId, partnerId),
        inArray(organizations.status, [...REPORT_HISTORY_ORG_STATUSES]),
        isNull(organizations.deletedAt),
        ...(selectedOrgIds ? [inArray(organizations.id, selectedOrgIds)] : []),
      ),
    );
  if (candidateRows.length === 0) return EMPTY_REPORT_HISTORY_REACH;
  const candidateOrgIds = candidateRows.map((row) => row.id);

  const orgMemberships = await db
    .select({
      orgId: organizationUsers.orgId,
      roleId: organizationUsers.roleId,
      siteIds: organizationUsers.siteIds,
    })
    .from(organizationUsers)
    .where(and(eq(organizationUsers.userId, userId), inArray(organizationUsers.orgId, candidateOrgIds)));
  const orgMembershipsByOrg = new Map<string, typeof orgMemberships>();
  for (const row of orgMemberships) {
    const list = orgMembershipsByOrg.get(row.orgId) ?? [];
    list.push(row);
    orgMembershipsByOrg.set(row.orgId, list);
  }

  const roleIds = new Set<string>();
  if (membership.roleId) roleIds.add(membership.roleId);
  for (const row of orgMemberships) if (row.roleId) roleIds.add(row.roleId);
  const grants: RoleGrantRow[] = roleIds.size === 0
    ? []
    : await db
      .select({
        roleId: rolePermissions.roleId,
        resource: permissions.resource,
        action: permissions.action,
        roleScope: roles.scope,
        roleIsSystem: roles.isSystem,
        roleOrgId: roles.orgId,
        rolePartnerId: roles.partnerId,
      })
      .from(rolePermissions)
      .innerJoin(roles, eq(rolePermissions.roleId, roles.id))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(
        and(
          inArray(rolePermissions.roleId, [...roleIds]),
          // '*' rows must survive so wildcard super-roles are honored.
          inArray(permissions.resource, ['reports', '*']),
          inArray(permissions.action, ['read', '*']),
        ),
      );

  const partnerRoleGrants = membership.roleId !== null
    && roleGrantsReportsRead(grants, membership.roleId, { scope: 'partner', partnerId });

  const scopes = new Map<string, ReportHistoryOrgScope>();
  for (const orgId of [...candidateOrgIds].sort()) {
    const orgRows = orgMembershipsByOrg.get(orgId) ?? [];
    if (orgRows.length > 1) continue; // unverifiable, as in the live resolver
    const orgMembership = orgRows[0];
    if (orgMembership) {
      // Org membership takes precedence: its role and its site restriction.
      if (
        !orgMembership.roleId
        || !roleGrantsReportsRead(grants, orgMembership.roleId, { scope: 'organization', orgId })
      ) {
        continue;
      }
      if (orgMembership.siteIds === null) {
        scopes.set(orgId, { version: 1, kind: 'unrestricted', orgId });
        continue;
      }
      const siteIds = normalizeSiteIds(orgMembership.siteIds);
      if (siteIds.length === 0) continue; // empty scope
      scopes.set(orgId, { version: 1, kind: 'restricted', orgId, siteIds });
      continue;
    }
    if (!partnerRoleGrants) continue;
    scopes.set(orgId, { version: 1, kind: 'unrestricted', orgId });
  }

  if (scopes.size === 0) return EMPTY_REPORT_HISTORY_REACH;
  return { orgIds: Object.freeze([...scopes.keys()]), scopes };
}

/**
 * Discover the report-history reach of a PARTNER-scope request. Call ONLY
 * from the auth bootstrap, before the request transaction opens (it reads
 * under its own short system transaction, exactly like
 * `computeAccessibleOrgIds`), and only for a route that
 * `isReportHistoryReadRoute` admits.
 */
export async function computeReportHistoryReach(args: {
  partnerId: string;
  userId: string;
}): Promise<ReportHistoryReach> {
  return withSystemDbAccessContext(
    () => computeReachInSystemContext(args.partnerId, args.userId),
    'reportHistoryReach',
  );
}

/**
 * Is `orgId` reachable ONLY through the report-history capability on this
 * request? False for an org the caller can reach normally (an accessible org
 * always takes the ordinary resolver), for any non-partner scope, and for a
 * request that never computed a reach (every route but the five history GETs).
 */
export function isReportHistoryOrg(
  auth: Pick<AuthContext, 'scope' | 'accessibleOrgIds' | 'reportHistory'>,
  orgId: string,
): boolean {
  return (
    auth.scope === 'partner'
    && auth.reportHistory?.scopes.has(orgId) === true
    && !(auth.accessibleOrgIds?.includes(orgId) ?? false)
  );
}

/**
 * The org ids a history read may add to its tenant condition: the reach for a
 * partner-scope request, nothing otherwise.
 */
export function reportHistoryOrgIdsFor(
  auth: Pick<AuthContext, 'scope' | 'reportHistory'>,
): readonly string[] {
  return auth.scope === 'partner' ? auth.reportHistory?.orgIds ?? [] : [];
}

/**
 * The 'read_history' report authority for a history org, consumed from the
 * capability the auth bootstrap verified moments ago in this same request. No
 * database access, so no system wrapper and no second connection. Callers must
 * use it ONLY for the 'read_history' action (see `resolveOrgReportAuthority`
 * in routes/reports/helpers.ts).
 */
export function resolveRequestReportHistoryAuthority(
  auth: Pick<AuthContext, 'scope' | 'accessibleOrgIds' | 'reportHistory' | 'user'>,
  orgId: string,
): LiveReportAuthorityResult {
  if (!isReportHistoryOrg(auth, orgId)) {
    return { ok: false, reason: 'organization_inaccessible' };
  }
  const scope = auth.reportHistory!.scopes.get(orgId)!;
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: auth.user.id,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}
