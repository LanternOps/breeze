import { createHash } from 'node:crypto';
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  organizations,
  organizationUsers,
  partnerUsers,
  permissions,
  rolePermissions,
  roles,
  users,
} from '../db/schema';
import type { reportRuns, reports } from '../db/schema';
import {
  db,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import type { AuthContext } from '../middleware/auth';
import type { UserPermissions } from './permissions';
import { permissionGrantMatches } from './permissionMatching';

export type SiteScopeV1 =
  | { version: 1; kind: 'unrestricted'; orgId: string }
  | { version: 1; kind: 'restricted'; orgId: string; siteIds: string[] }
  | { version: 1; kind: 'legacy_unscoped'; orgId: string };

export type LiveSiteScopeV1 = Exclude<SiteScopeV1, { kind: 'legacy_unscoped' }>;
export type ReportAction = 'read' | 'write' | 'export' | 'delete';

export interface PersistedSiteScopeColumns {
  executionScopeVersion: number | null;
  executionScopeKind: 'unrestricted' | 'restricted' | 'legacy_unscoped' | null;
  executionScopeSiteIds: string[] | null;
  executionScopeUserId: string | null;
  executionScopeFingerprint: string | null;
  executionScopeCapturedAt: Date | null;
}

export interface ReportExecutionAuthority {
  scope: SiteScopeV1;
  principalUserId: string;
  capturedAt: Date;
  fingerprint: string;
}

export type LiveReportAuthorityResult =
  | { ok: true; authority: ReportExecutionAuthority }
  | {
      ok: false;
      reason:
        | 'user_inactive'
        | 'membership_removed'
        | 'permission_removed'
        | 'organization_inaccessible'
        | 'empty_scope'
        | 'unverifiable_scope';
    };

function assertNever(value: never): never {
  throw new Error(`unsupported site scope kind: ${String(value)}`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
}

function assertValidDate(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid execution scope capture time');
  }
}

export function normalizeSiteIds(siteIds: readonly string[]): string[] {
  if (!Array.isArray(siteIds)) {
    throw new Error('invalid site ID array');
  }

  const normalized = new Set<string>();
  for (const siteId of siteIds) {
    assertNonEmptyString(siteId, 'site ID');
    normalized.add(siteId);
  }

  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeScope(scope: SiteScopeV1): SiteScopeV1 {
  assertNonEmptyString(scope.orgId, 'organization ID');

  switch (scope.kind) {
    case 'unrestricted':
      return { version: 1, kind: 'unrestricted', orgId: scope.orgId };
    case 'restricted':
      return {
        version: 1,
        kind: 'restricted',
        orgId: scope.orgId,
        siteIds: normalizeSiteIds(scope.siteIds),
      };
    case 'legacy_unscoped':
      return { version: 1, kind: 'legacy_unscoped', orgId: scope.orgId };
    default:
      return assertNever(scope);
  }
}

export function siteScopeFromPermissions(
  orgId: string,
  permissions: UserPermissions,
): SiteScopeV1 {
  assertNonEmptyString(orgId, 'organization ID');

  if (permissions.allowedSiteIds === undefined) {
    return { version: 1, kind: 'unrestricted', orgId };
  }

  return {
    version: 1,
    kind: 'restricted',
    orgId,
    siteIds: normalizeSiteIds(permissions.allowedSiteIds),
  };
}

export function siteScopeFingerprint(scope: SiteScopeV1): string {
  const normalized = normalizeScope(scope);
  let stableValue: Record<string, unknown>;

  switch (normalized.kind) {
    case 'unrestricted':
      stableValue = {
        version: normalized.version,
        kind: normalized.kind,
        orgId: normalized.orgId,
      };
      break;
    case 'restricted':
      stableValue = {
        version: normalized.version,
        kind: normalized.kind,
        orgId: normalized.orgId,
        siteIds: normalized.siteIds,
      };
      break;
    case 'legacy_unscoped':
      stableValue = {
        version: normalized.version,
        kind: normalized.kind,
        orgId: normalized.orgId,
      };
      break;
    default:
      return assertNever(normalized);
  }

  return createHash('sha256').update(JSON.stringify(stableValue)).digest('hex');
}

export function intersectSiteScopes(
  persisted: SiteScopeV1,
  current: SiteScopeV1,
): SiteScopeV1 | null {
  const normalizedPersisted = normalizeScope(persisted);
  const normalizedCurrent = normalizeScope(current);

  if (normalizedPersisted.orgId !== normalizedCurrent.orgId) {
    return null;
  }

  switch (normalizedPersisted.kind) {
    case 'unrestricted':
      switch (normalizedCurrent.kind) {
        case 'unrestricted':
        case 'restricted':
          return normalizedCurrent;
        case 'legacy_unscoped':
          return null;
        default:
          return assertNever(normalizedCurrent);
      }
    case 'restricted':
      switch (normalizedCurrent.kind) {
        case 'unrestricted':
          return normalizedPersisted;
        case 'restricted': {
          const currentSiteIds = new Set(normalizedCurrent.siteIds);
          const siteIds = normalizedPersisted.siteIds.filter((siteId) =>
            currentSiteIds.has(siteId),
          );
          return siteIds.length === 0
            ? null
            : {
                version: 1,
                kind: 'restricted',
                orgId: normalizedPersisted.orgId,
                siteIds,
              };
        }
        case 'legacy_unscoped':
          return null;
        default:
          return assertNever(normalizedCurrent);
      }
    case 'legacy_unscoped':
      return null;
    default:
      return assertNever(normalizedPersisted);
  }
}

export function isSiteScopeSubset(
  candidate: SiteScopeV1,
  current: SiteScopeV1,
): boolean {
  const normalizedCandidate = normalizeScope(candidate);
  const normalizedCurrent = normalizeScope(current);

  if (normalizedCandidate.orgId !== normalizedCurrent.orgId) {
    return false;
  }

  switch (normalizedCandidate.kind) {
    case 'unrestricted':
      switch (normalizedCurrent.kind) {
        case 'unrestricted':
          return true;
        case 'restricted':
        case 'legacy_unscoped':
          return false;
        default:
          return assertNever(normalizedCurrent);
      }
    case 'restricted':
      switch (normalizedCurrent.kind) {
        case 'unrestricted':
          return true;
        case 'restricted': {
          const currentSiteIds = new Set(normalizedCurrent.siteIds);
          return normalizedCandidate.siteIds.every((siteId) =>
            currentSiteIds.has(siteId),
          );
        }
        case 'legacy_unscoped':
          return false;
        default:
          return assertNever(normalizedCurrent);
      }
    case 'legacy_unscoped':
      switch (normalizedCurrent.kind) {
        case 'unrestricted':
          return true;
        case 'restricted':
        case 'legacy_unscoped':
          return false;
        default:
          return assertNever(normalizedCurrent);
      }
    default:
      return assertNever(normalizedCandidate);
  }
}

function allPersistedValuesAreNull(row: PersistedSiteScopeColumns): boolean {
  return (
    row.executionScopeVersion === null &&
    row.executionScopeKind === null &&
    row.executionScopeSiteIds === null &&
    row.executionScopeUserId === null &&
    row.executionScopeFingerprint === null &&
    row.executionScopeCapturedAt === null
  );
}

function assertCompletePersistedBase(row: PersistedSiteScopeColumns): void {
  if (
    row.executionScopeVersion !== 1 ||
    row.executionScopeFingerprint === null ||
    row.executionScopeFingerprint.length === 0 ||
    row.executionScopeCapturedAt === null
  ) {
    throw new Error('partial or invalid persisted site scope');
  }
  assertValidDate(row.executionScopeCapturedAt);
}

function validateDecodedScopeFingerprint(
  row: PersistedSiteScopeColumns,
  scope: SiteScopeV1,
): SiteScopeV1 {
  const fingerprint = row.executionScopeFingerprint;
  if (
    fingerprint === null ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    fingerprint !== siteScopeFingerprint(scope)
  ) {
    throw new Error('invalid persisted site scope fingerprint');
  }
  return scope;
}

export function decodeSiteScope(
  row: PersistedSiteScopeColumns,
  orgId: string,
): SiteScopeV1 {
  assertNonEmptyString(orgId, 'organization ID');

  if (allPersistedValuesAreNull(row)) {
    return { version: 1, kind: 'legacy_unscoped', orgId };
  }

  assertCompletePersistedBase(row);

  switch (row.executionScopeKind) {
    case 'unrestricted':
      if (
        row.executionScopeSiteIds !== null ||
        row.executionScopeUserId === null
      ) {
        throw new Error('partial or invalid persisted unrestricted site scope');
      }
      assertNonEmptyString(row.executionScopeUserId, 'execution scope user ID');
      return validateDecodedScopeFingerprint(row, {
        version: 1,
        kind: 'unrestricted',
        orgId,
      });
    case 'restricted':
      if (
        row.executionScopeSiteIds === null ||
        row.executionScopeUserId === null
      ) {
        throw new Error('partial or invalid persisted restricted site scope');
      }
      assertNonEmptyString(row.executionScopeUserId, 'execution scope user ID');
      return validateDecodedScopeFingerprint(row, {
        version: 1,
        kind: 'restricted',
        orgId,
        siteIds: normalizeSiteIds(row.executionScopeSiteIds),
      });
    case 'legacy_unscoped':
      if (row.executionScopeSiteIds !== null) {
        throw new Error('partial or invalid persisted legacy site scope');
      }
      if (row.executionScopeUserId !== null) {
        assertNonEmptyString(row.executionScopeUserId, 'execution scope user ID');
      }
      return validateDecodedScopeFingerprint(row, {
        version: 1,
        kind: 'legacy_unscoped',
        orgId,
      });
    case null:
      throw new Error('partial or invalid persisted site scope');
    default:
      throw new Error('invalid persisted site scope kind');
  }
}

export function persistedSiteScopeValues(
  authority: ReportExecutionAuthority,
): PersistedSiteScopeColumns {
  const scope = normalizeScope(authority.scope);
  assertNonEmptyString(authority.principalUserId, 'principal user ID');
  assertValidDate(authority.capturedAt);

  if (authority.fingerprint !== siteScopeFingerprint(scope)) {
    throw new Error('invalid execution scope fingerprint');
  }

  switch (scope.kind) {
    case 'unrestricted':
      return {
        executionScopeVersion: 1,
        executionScopeKind: scope.kind,
        executionScopeSiteIds: null,
        executionScopeUserId: authority.principalUserId,
        executionScopeFingerprint: authority.fingerprint,
        executionScopeCapturedAt: authority.capturedAt,
      };
    case 'restricted':
      return {
        executionScopeVersion: 1,
        executionScopeKind: scope.kind,
        executionScopeSiteIds: scope.siteIds,
        executionScopeUserId: authority.principalUserId,
        executionScopeFingerprint: authority.fingerprint,
        executionScopeCapturedAt: authority.capturedAt,
      };
    case 'legacy_unscoped':
      return {
        executionScopeVersion: 1,
        executionScopeKind: scope.kind,
        executionScopeSiteIds: null,
        executionScopeUserId: authority.principalUserId,
        executionScopeFingerprint: authority.fingerprint,
        executionScopeCapturedAt: authority.capturedAt,
      };
    default:
      return assertNever(scope);
  }
}

type ReportScopeColumns = Pick<
  typeof reports | typeof reportRuns,
  | 'executionScopeVersion'
  | 'executionScopeKind'
  | 'executionScopeSiteIds'
  | 'executionScopeUserId'
  | 'executionScopeFingerprint'
  | 'executionScopeCapturedAt'
>;

function sqlFalse(): SQL<unknown> {
  return sql<unknown>`FALSE`;
}

function uuidArraySql(siteIds: readonly string[]): SQL<unknown> {
  return siteIds.length === 0
    ? sql<unknown>`ARRAY[]::uuid[]`
    : sql<unknown>`ARRAY[${sql.join(
        siteIds.map((siteId) => sql`${siteId}::uuid`),
        sql`, `,
      )}]`;
}

function completeVersionOneBase(
  columns: ReportScopeColumns,
): SQL<unknown> {
  return and(
    eq(columns.executionScopeVersion, 1),
    isNotNull(columns.executionScopeUserId),
    isNotNull(columns.executionScopeFingerprint),
    isNotNull(columns.executionScopeCapturedAt),
  )!;
}

function unrestrictedDefinitionPredicate(
  columns: ReportScopeColumns,
): SQL<unknown> {
  const completeBase = completeVersionOneBase(columns);
  return or(
    and(
      completeBase,
      eq(columns.executionScopeKind, 'unrestricted'),
      isNull(columns.executionScopeSiteIds),
    ),
    and(
      completeBase,
      eq(columns.executionScopeKind, 'restricted'),
      isNotNull(columns.executionScopeSiteIds),
    ),
    and(
      eq(columns.executionScopeVersion, 1),
      eq(columns.executionScopeKind, 'legacy_unscoped'),
      isNull(columns.executionScopeSiteIds),
      isNotNull(columns.executionScopeFingerprint),
      isNotNull(columns.executionScopeCapturedAt),
    ),
    and(
      isNull(columns.executionScopeVersion),
      isNull(columns.executionScopeKind),
      isNull(columns.executionScopeSiteIds),
      isNull(columns.executionScopeUserId),
      isNull(columns.executionScopeFingerprint),
      isNull(columns.executionScopeCapturedAt),
    ),
  )!;
}

function definitionScopePredicate(
  columns: ReportScopeColumns,
  currentScope: LiveSiteScopeV1,
): SQL<unknown> {
  switch (currentScope.kind) {
    case 'unrestricted':
      return unrestrictedDefinitionPredicate(columns);
    case 'restricted': {
      const normalizedSiteIds = normalizeSiteIds(currentScope.siteIds);
      return and(
        completeVersionOneBase(columns),
        eq(columns.executionScopeKind, 'restricted'),
        isNotNull(columns.executionScopeSiteIds),
        sql`${columns.executionScopeSiteIds} <@ ${uuidArraySql(normalizedSiteIds)}`,
      )!;
    }
    default:
      return sqlFalse();
  }
}

export function reportDefinitionScopeSqlPredicate(
  columns: ReportScopeColumns,
  currentScope: LiveSiteScopeV1,
): SQL<unknown> {
  return definitionScopePredicate(columns, currentScope);
}

export function unrestrictedReportDefinitionScopeSqlPredicate(
  columns: ReportScopeColumns,
): SQL<unknown> {
  return unrestrictedDefinitionPredicate(columns);
}

export function reportDefinitionMultiOrgScopeSqlPredicate(
  rowOrgId: typeof reports.orgId,
  columns: ReportScopeColumns,
  authorizedScopes: readonly LiveSiteScopeV1[],
): SQL<unknown> {
  const scopesByOrgId = new Map<string, LiveSiteScopeV1>();

  for (const scope of authorizedScopes) {
    assertNonEmptyString(scope.orgId, 'organization ID');
    if (scope.kind === 'restricted' && scope.siteIds.length === 0) {
      continue;
    }
    if (!scopesByOrgId.has(scope.orgId)) {
      scopesByOrgId.set(
        scope.orgId,
        scope.kind === 'restricted'
          ? { ...scope, siteIds: normalizeSiteIds(scope.siteIds) }
          : scope,
      );
    }
  }

  const branches = [...scopesByOrgId.values()]
    .sort((left, right) => left.orgId.localeCompare(right.orgId))
    .map((scope) =>
      and(
        eq(rowOrgId, scope.orgId),
        definitionScopePredicate(columns, scope),
      )!,
    );

  return branches.length === 0 ? sqlFalse() : or(...branches)!;
}

export function reportRunScopeSqlPredicate(
  columns: ReportScopeColumns,
  currentScope: LiveSiteScopeV1,
): SQL<unknown> {
  return definitionScopePredicate(columns, currentScope);
}

export function unrestrictedReportRunScopeSqlPredicate(
  columns: ReportScopeColumns,
): SQL<unknown> {
  return unrestrictedDefinitionPredicate(columns);
}

export function reportRunMultiOrgScopeSqlPredicate(
  rowOrgId: typeof reports.orgId,
  columns: ReportScopeColumns,
  authorizedScopes: readonly LiveSiteScopeV1[],
): SQL<unknown> {
  const scopesByOrgId = new Map<string, LiveSiteScopeV1>();

  for (const scope of authorizedScopes) {
    assertNonEmptyString(scope.orgId, 'organization ID');
    if (scope.kind === 'restricted' && scope.siteIds.length === 0) {
      continue;
    }
    if (!scopesByOrgId.has(scope.orgId)) {
      scopesByOrgId.set(
        scope.orgId,
        scope.kind === 'restricted'
          ? { ...scope, siteIds: normalizeSiteIds(scope.siteIds) }
          : scope,
      );
    }
  }

  const branches = [...scopesByOrgId.values()]
    .sort((left, right) => left.orgId.localeCompare(right.orgId))
    .map((scope) =>
      and(
        eq(rowOrgId, scope.orgId),
        definitionScopePredicate(columns, scope),
      )!,
    );

  return branches.length === 0 ? sqlFalse() : or(...branches)!;
}

function denied(
  reason: Exclude<LiveReportAuthorityResult, { ok: true }>['reason'],
): LiveReportAuthorityResult {
  return { ok: false, reason };
}

function liveAuthority(
  scope: LiveSiteScopeV1,
  principalUserId: string,
  capturedAt = new Date(),
): LiveReportAuthorityResult {
  return {
    ok: true,
    authority: {
      scope,
      principalUserId,
      capturedAt,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

async function roleGrantsReportAction(
  roleId: string,
  action: ReportAction,
  expectedRole:
    | {
        scope: 'organization';
        orgId: string;
        partnerId: string;
      }
    | {
        scope: 'partner';
        partnerId: string;
      },
): Promise<boolean> {
  const rows = await db
    .select({
      resource: permissions.resource,
      action: permissions.action,
      roleScope: roles.scope,
      roleIsSystem: roles.isSystem,
      roleOrgId: roles.orgId,
      rolePartnerId: roles.partnerId,
    })
    .from(rolePermissions)
    .innerJoin(roles, eq(rolePermissions.roleId, roles.id))
    .innerJoin(
      permissions,
      eq(rolePermissions.permissionId, permissions.id),
    )
    .where(
      and(
        eq(rolePermissions.roleId, roleId),
        // '*' rows must survive the SQL filter so wildcard super-roles
        // (Partner Admin's `*|*`) are honored — see permissionGrantMatches.
        inArray(permissions.resource, ['reports', '*']),
        inArray(permissions.action, [action, '*']),
        eq(roles.scope, expectedRole.scope),
        or(
          eq(roles.isSystem, true),
          expectedRole.scope === 'organization'
            ? eq(roles.orgId, expectedRole.orgId)
            : eq(roles.partnerId, expectedRole.partnerId),
        ),
      ),
    );

  return rows.some(
    (row) =>
      permissionGrantMatches(row, 'reports', action) &&
      row.roleScope === expectedRole.scope &&
      (row.roleIsSystem ||
        (expectedRole.scope === 'organization'
          ? row.roleOrgId === expectedRole.orgId
          : row.rolePartnerId === expectedRole.partnerId)),
  );
}

function partnerMembershipAdmitsOrg(
  membership: {
    orgAccess: 'all' | 'selected' | 'none';
    orgIds: string[] | null;
  },
  orgId: string,
): boolean {
  switch (membership.orgAccess) {
    case 'all':
      return true;
    case 'selected':
      return membership.orgIds?.includes(orgId) ?? false;
    case 'none':
      return false;
    default:
      return false;
  }
}

async function resolveExactReportAuthorityInSystemContext(
  userId: string,
  orgId: string,
  action: ReportAction,
  allowPlatformAuthority: boolean,
): Promise<LiveReportAuthorityResult> {
  const [user] = await db
    .select({
      id: users.id,
      status: users.status,
      isPlatformAdmin: users.isPlatformAdmin,
      partnerId: users.partnerId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.status !== 'active') {
    return denied('user_inactive');
  }

  const [organization] = await db
    .select({
      id: organizations.id,
      partnerId: organizations.partnerId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!organization) {
    return denied('organization_inaccessible');
  }

  if (allowPlatformAuthority && user.isPlatformAdmin) {
    return liveAuthority(
      { version: 1, kind: 'unrestricted', orgId },
      user.id,
    );
  }

  const organizationMemberships = await db
    .select({
      roleId: organizationUsers.roleId,
      siteIds: organizationUsers.siteIds,
    })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.userId, user.id),
        eq(organizationUsers.orgId, orgId),
      ),
    )
    .limit(2);
  if (organizationMemberships.length > 1) {
    return denied('unverifiable_scope');
  }
  const organizationMembership = organizationMemberships[0];

  if (organizationMembership) {
    if (
      !organizationMembership.roleId ||
      !(await roleGrantsReportAction(
        organizationMembership.roleId,
        action,
        {
          scope: 'organization',
          orgId,
          partnerId: organization.partnerId,
        },
      ))
    ) {
      return denied('permission_removed');
    }

    if (organizationMembership.siteIds === null) {
      return liveAuthority(
        { version: 1, kind: 'unrestricted', orgId },
        user.id,
      );
    }

    const siteIds = normalizeSiteIds(organizationMembership.siteIds);
    if (siteIds.length === 0) {
      return denied('empty_scope');
    }
    return liveAuthority(
      { version: 1, kind: 'restricted', orgId, siteIds },
      user.id,
    );
  }

  if (organization.partnerId !== user.partnerId) {
    return denied('organization_inaccessible');
  }

  const partnerMemberships = await db
    .select({
      roleId: partnerUsers.roleId,
      orgAccess: partnerUsers.orgAccess,
      orgIds: partnerUsers.orgIds,
    })
    .from(partnerUsers)
    .where(
      and(
        eq(partnerUsers.userId, user.id),
        eq(partnerUsers.partnerId, organization.partnerId),
      ),
    )
    .limit(2);
  if (partnerMemberships.length > 1) {
    return denied('unverifiable_scope');
  }
  const partnerMembership = partnerMemberships[0];
  if (!partnerMembership) {
    return denied('membership_removed');
  }
  if (!partnerMembershipAdmitsOrg(partnerMembership, orgId)) {
    return denied('organization_inaccessible');
  }
  if (
    !partnerMembership.roleId ||
    !(await roleGrantsReportAction(partnerMembership.roleId, action, {
      scope: 'partner',
      partnerId: organization.partnerId,
    }))
  ) {
    return denied('permission_removed');
  }

  return liveAuthority(
    { version: 1, kind: 'unrestricted', orgId },
    user.id,
  );
}

async function resolveExactReportAuthority(
  userId: string,
  orgId: string,
  action: ReportAction,
  allowPlatformAuthority: boolean,
): Promise<LiveReportAuthorityResult> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        resolveExactReportAuthorityInSystemContext(
          userId,
          orgId,
          action,
          allowPlatformAuthority,
        ),
      ),
    );
  } catch {
    return denied('unverifiable_scope');
  }
}

export async function resolveLiveReportAuthority(
  userId: string,
  orgId: string,
  action: ReportAction,
): Promise<LiveReportAuthorityResult> {
  return resolveExactReportAuthority(userId, orgId, action, true);
}

function requestAuthAdmitsOrg(auth: AuthContext, orgId: string): boolean {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId && auth.canAccessOrg(orgId);
  }
  if (auth.scope === 'partner') {
    return (
      (auth.accessibleOrgIds?.includes(orgId) ?? false) &&
      auth.canAccessOrg(orgId)
    );
  }
  return auth.scope === 'system' && auth.canAccessOrg(orgId);
}

export async function resolveRequestReportAuthority(
  auth: AuthContext,
  orgId: string,
  action: ReportAction,
): Promise<LiveReportAuthorityResult> {
  if (!requestAuthAdmitsOrg(auth, orgId)) {
    return denied('organization_inaccessible');
  }
  return resolveExactReportAuthority(
    auth.user.id,
    orgId,
    action,
    auth.scope === 'system',
  );
}

type BatchOrganization = {
  id: string;
  partnerId: string;
};

type BatchOrganizationMembership = {
  orgId: string;
  roleId: string;
  siteIds: string[] | null;
};

type BatchPartnerMembership = {
  partnerId: string;
  roleId: string;
  orgAccess: 'all' | 'selected' | 'none';
  orgIds: string[] | null;
};

type BatchPermissionGrant = {
  roleId: string;
  resource: string;
  action: string;
  roleScope: 'system' | 'partner' | 'organization';
  roleIsSystem: boolean;
  roleOrgId: string | null;
  rolePartnerId: string | null;
};

function batchRoleGrantsReportAction(
  rows: readonly BatchPermissionGrant[],
  roleId: string,
  action: ReportAction,
  expectedRole:
    | { scope: 'organization'; orgId: string }
    | { scope: 'partner'; partnerId: string },
): boolean {
  return rows.some(
    (row) =>
      row.roleId === roleId &&
      permissionGrantMatches(row, 'reports', action) &&
      row.roleScope === expectedRole.scope &&
      (row.roleIsSystem ||
        (expectedRole.scope === 'organization'
          ? row.roleOrgId === expectedRole.orgId
          : row.rolePartnerId === expectedRole.partnerId)),
  );
}

async function resolveRequestReportAuthorityMapInSystemContext(
  auth: AuthContext,
  accessibleOrgIds: readonly string[],
  action: ReportAction,
  result: Map<string, LiveReportAuthorityResult>,
): Promise<void> {
  const [user] = await db
    .select({
      id: users.id,
      status: users.status,
      isPlatformAdmin: users.isPlatformAdmin,
      partnerId: users.partnerId,
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  if (!user || user.status !== 'active') {
    for (const orgId of accessibleOrgIds) {
      result.set(orgId, denied('user_inactive'));
    }
    return;
  }

  const organizationRows = await db
    .select({
      id: organizations.id,
      partnerId: organizations.partnerId,
    })
    .from(organizations)
    .where(inArray(organizations.id, [...accessibleOrgIds]));
  const organizationsById = new Map(
    (organizationRows as BatchOrganization[]).map((organization) => [
      organization.id,
      organization,
    ]),
  );

  if (auth.scope === 'system' && user.isPlatformAdmin) {
    const capturedAt = new Date();
    for (const orgId of accessibleOrgIds) {
      result.set(
        orgId,
        organizationsById.has(orgId)
          ? liveAuthority(
              { version: 1, kind: 'unrestricted', orgId },
              user.id,
              capturedAt,
            )
          : denied('organization_inaccessible'),
      );
    }
    return;
  }

  const existingOrgIds = accessibleOrgIds.filter((orgId) =>
    organizationsById.has(orgId),
  );
  const organizationMembershipRows = existingOrgIds.length === 0
    ? []
    : await db
        .select({
          orgId: organizationUsers.orgId,
          roleId: organizationUsers.roleId,
          siteIds: organizationUsers.siteIds,
        })
        .from(organizationUsers)
        .where(
          and(
            eq(organizationUsers.userId, user.id),
            inArray(organizationUsers.orgId, [...existingOrgIds]),
          ),
        );
  const organizationMembershipsByOrgId = new Map<
    string,
    BatchOrganizationMembership
  >();
  const organizationMembershipOrgIds = new Set<string>();
  const duplicateOrganizationMembershipOrgIds = new Set<string>();
  for (
    const membership of
      organizationMembershipRows as BatchOrganizationMembership[]
  ) {
    if (organizationMembershipOrgIds.has(membership.orgId)) {
      duplicateOrganizationMembershipOrgIds.add(membership.orgId);
      organizationMembershipsByOrgId.delete(membership.orgId);
      continue;
    }
    organizationMembershipOrgIds.add(membership.orgId);
    organizationMembershipsByOrgId.set(membership.orgId, membership);
  }

  const organizationRoleIds = normalizeSiteIds(
    [...organizationMembershipsByOrgId.values()]
      .map((membership) => membership.roleId)
      .filter(Boolean),
  );
  const organizationPermissionRows = organizationRoleIds.length === 0
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
        .innerJoin(
          permissions,
          eq(rolePermissions.permissionId, permissions.id),
        )
        .where(
          and(
            inArray(rolePermissions.roleId, organizationRoleIds),
            inArray(permissions.resource, ['reports', '*']),
            inArray(permissions.action, [action, '*']),
          ),
        );

  const fallbackPartnerIds = normalizeSiteIds(
    existingOrgIds
      .filter((orgId) => !organizationMembershipOrgIds.has(orgId))
      .map((orgId) => organizationsById.get(orgId)!.partnerId)
      .filter((partnerId) => partnerId === user.partnerId),
  );
  const partnerMembershipRows = fallbackPartnerIds.length === 0
    ? []
    : await db
        .select({
          partnerId: partnerUsers.partnerId,
          roleId: partnerUsers.roleId,
          orgAccess: partnerUsers.orgAccess,
          orgIds: partnerUsers.orgIds,
        })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.userId, user.id),
            inArray(partnerUsers.partnerId, fallbackPartnerIds),
          ),
        );
  const partnerMembershipsByPartnerId = new Map<
    string,
    BatchPartnerMembership
  >();
  const partnerMembershipPartnerIds = new Set<string>();
  const duplicatePartnerMembershipPartnerIds = new Set<string>();
  for (
    const membership of partnerMembershipRows as BatchPartnerMembership[]
  ) {
    if (partnerMembershipPartnerIds.has(membership.partnerId)) {
      duplicatePartnerMembershipPartnerIds.add(membership.partnerId);
      partnerMembershipsByPartnerId.delete(membership.partnerId);
      continue;
    }
    partnerMembershipPartnerIds.add(membership.partnerId);
    partnerMembershipsByPartnerId.set(membership.partnerId, membership);
  }

  const partnerRoleIds = normalizeSiteIds(
    [...partnerMembershipsByPartnerId.values()]
      .map((membership) => membership.roleId)
      .filter(Boolean),
  );
  const partnerPermissionRows = partnerRoleIds.length === 0
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
        .innerJoin(
          permissions,
          eq(rolePermissions.permissionId, permissions.id),
        )
        .where(
          and(
            inArray(rolePermissions.roleId, partnerRoleIds),
            inArray(permissions.resource, ['reports', '*']),
            inArray(permissions.action, [action, '*']),
          ),
        );

  const capturedAt = new Date();
  for (const orgId of accessibleOrgIds) {
    const organization = organizationsById.get(orgId);
    if (!organization) {
      result.set(orgId, denied('organization_inaccessible'));
      continue;
    }

    const organizationMembership =
      organizationMembershipsByOrgId.get(orgId);
    if (duplicateOrganizationMembershipOrgIds.has(orgId)) {
      result.set(orgId, denied('unverifiable_scope'));
      continue;
    }
    if (organizationMembership) {
      if (
        !organizationMembership.roleId ||
        !batchRoleGrantsReportAction(
          organizationPermissionRows as BatchPermissionGrant[],
          organizationMembership.roleId,
          action,
          { scope: 'organization', orgId },
        )
      ) {
        result.set(orgId, denied('permission_removed'));
        continue;
      }
      if (organizationMembership.siteIds === null) {
        result.set(
          orgId,
          liveAuthority(
            { version: 1, kind: 'unrestricted', orgId },
            user.id,
            capturedAt,
          ),
        );
        continue;
      }
      const siteIds = normalizeSiteIds(organizationMembership.siteIds);
      result.set(
        orgId,
        siteIds.length === 0
          ? denied('empty_scope')
          : liveAuthority(
              { version: 1, kind: 'restricted', orgId, siteIds },
              user.id,
              capturedAt,
            ),
      );
      continue;
    }

    if (organization.partnerId !== user.partnerId) {
      result.set(orgId, denied('organization_inaccessible'));
      continue;
    }
    const partnerMembership = partnerMembershipsByPartnerId.get(
      organization.partnerId,
    );
    if (
      duplicatePartnerMembershipPartnerIds.has(organization.partnerId)
    ) {
      result.set(orgId, denied('unverifiable_scope'));
      continue;
    }
    if (!partnerMembership) {
      result.set(orgId, denied('membership_removed'));
      continue;
    }
    if (!partnerMembershipAdmitsOrg(partnerMembership, orgId)) {
      result.set(orgId, denied('organization_inaccessible'));
      continue;
    }
    if (
      !partnerMembership.roleId ||
      !batchRoleGrantsReportAction(
        partnerPermissionRows as BatchPermissionGrant[],
        partnerMembership.roleId,
        action,
        { scope: 'partner', partnerId: organization.partnerId },
      )
    ) {
      result.set(orgId, denied('permission_removed'));
      continue;
    }
    result.set(
      orgId,
      liveAuthority(
        { version: 1, kind: 'unrestricted', orgId },
        user.id,
        capturedAt,
      ),
    );
  }
}

export async function resolveRequestReportAuthorityMap(
  auth: AuthContext,
  orgIds: readonly string[],
  action: ReportAction,
): Promise<ReadonlyMap<string, LiveReportAuthorityResult>> {
  const requestedOrgIds = normalizeSiteIds(orgIds);
  const result = new Map<string, LiveReportAuthorityResult>();
  const accessibleOrgIds = requestedOrgIds.filter((orgId) =>
    requestAuthAdmitsOrg(auth, orgId),
  );
  const accessibleSet = new Set(accessibleOrgIds);
  for (const orgId of requestedOrgIds) {
    if (!accessibleSet.has(orgId)) {
      result.set(orgId, denied('organization_inaccessible'));
    }
  }
  if (accessibleOrgIds.length === 0) {
    return result;
  }

  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        resolveRequestReportAuthorityMapInSystemContext(
          auth,
          accessibleOrgIds,
          action,
          result,
        ),
      ),
    );
  } catch {
    for (const orgId of accessibleOrgIds) {
      result.set(orgId, denied('unverifiable_scope'));
    }
  }
  return result;
}
