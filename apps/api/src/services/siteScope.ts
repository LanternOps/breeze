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
import { sqlUuidArray } from '../db/sqlValues';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import type { UserPermissions } from './permissions';
import { permissionGrantMatches } from './permissionMatching';
import { captureException } from './sentry';

export type SiteScopeV1 =
  | { version: 1; kind: 'unrestricted'; orgId: string }
  | { version: 1; kind: 'restricted'; orgId: string; siteIds: string[] }
  | { version: 1; kind: 'legacy_unscoped'; orgId: string }
  // #3198 W01 (spec 3.1a): every organization of `partnerId`, resolved live
  // at execution time. Carries no org list on purpose - persisting one would
  // freeze the report at creation-time membership.
  | { version: 1; kind: 'partner_wide'; partnerId: string };

export type LiveSiteScopeV1 = Exclude<SiteScopeV1, { kind: 'legacy_unscoped' }>;

/**
 * #3198 W01. A report row owns exactly ONE tenancy axis: an organization or a
 * partner (`reports_one_owner_chk`). Decoding an execution scope needs that
 * axis, so every decode site must state which one it holds rather than
 * defaulting to an org id that may be NULL.
 */
export type ReportOwner =
  | { orgId: string; partnerId?: undefined }
  | { partnerId: string; orgId?: undefined };

export function reportOwnerOf(row: {
  orgId: string | null;
  partnerId: string | null;
}): ReportOwner {
  const hasOrg = typeof row.orgId === 'string' && row.orgId.length > 0;
  const hasPartner = typeof row.partnerId === 'string' && row.partnerId.length > 0;
  if (hasOrg === hasPartner) {
    throw new Error('report row must have exactly one owner axis');
  }
  return hasOrg ? { orgId: row.orgId as string } : { partnerId: row.partnerId as string };
}

export function partnerWideScope(
  partnerId: string,
): Extract<SiteScopeV1, { kind: 'partner_wide' }> {
  assertNonEmptyString(partnerId, 'partner ID');
  return { version: 1, kind: 'partner_wide', partnerId };
}
export type ReportAction = 'read' | 'write' | 'export' | 'delete';

export type ReportPrincipalKind = 'user' | 'system' | 'portal_user';

export interface PersistedSiteScopeColumns {
  executionScopeVersion: number | null;
  executionScopeKind:
    | 'unrestricted'
    | 'restricted'
    | 'legacy_unscoped'
    | 'partner_wide'
    | null;
  executionScopeSiteIds: string[] | null;
  executionScopeUserId: string | null;
  executionScopeFingerprint: string | null;
  executionScopeCapturedAt: Date | null;
  /**
   * P2-3 (#4190). NULL on every pre-migration row and on rows written by a
   * projection that predates this column — decoding those keeps the original
   * user/legacy semantics byte for byte. 'system' and 'portal_user' are the
   * only values that license a NULL `executionScopeUserId`, and only on an
   * 'unrestricted' row (mirrors reports_execution_scope_shape_chk).
   *
   * Declared required so every hand-written literal must state its principal,
   * but READ defensively: a Drizzle projection that physically omits the column
   * hands the decoder `undefined`, which is treated as NULL. That omission is a
   * real hazard rather than a convenience — see siteScope.projections.test.ts,
   * which fails any execution-scope projection that leaves it out.
   */
  executionScopePrincipalKind: ReportPrincipalKind | null;
}

/**
 * A user-principal report authority, as resolved or decoded: its scope may be
 * any `SiteScopeV1` kind. Semantically the union of the three variants below
 * (org-axis | partner_wide | legacy_unscoped); kept as one wide interface so
 * the resolvers and decoders that build it from a scope union keep compiling.
 */
export interface UserReportExecutionAuthority {
  principalKind: 'user';
  scope: SiteScopeV1;
  principalUserId: string;
  capturedAt: Date;
  fingerprint: string;
}

/**
 * #3198 W02 (addendum B5). A user authority on the ORGANIZATION axis. Every
 * pre-#3198 org generator takes this (via `OrgReportExecutionAuthority` /
 * `OrgReportGenerationAuthority`) rather than the wide form: those generators
 * read `kind === 'restricted' ? scope : null` and treat "not restricted" as
 * whole-org, so a partner_wide (or legacy_unscoped) scope reaching one would
 * silently read as an org-wide grant. Typing them to this variant makes that a
 * compile error; `REPORT_GENERATORS` narrows with a runtime check first.
 */
export type OrgAxisUserReportExecutionAuthority =
  UserReportExecutionAuthority & { scope: OrgAxisLiveSiteScopeV1 };

/** #3198 W02 (addendum B5). A user authority on the PARTNER axis — only ever
 *  resolved for a partner-owned report, never handed to an org generator. */
export type PartnerUserReportExecutionAuthority =
  UserReportExecutionAuthority & { scope: Extract<SiteScopeV1, { kind: 'partner_wide' }> };

export interface PortalUserReportExecutionAuthority {
  principalKind: 'portal_user';
  scope: { version: 1; kind: 'unrestricted'; orgId: string };
  capturedAt: Date;
  fingerprint: string;
}

export type ReportExecutionAuthority =
  | UserReportExecutionAuthority
  | PortalUserReportExecutionAuthority;

/**
 * P2-3 (#4190) — provenance for a report the PLATFORM authored (the weekly AI
 * org narrative). Deliberately a separate type from ReportExecutionAuthority:
 * widening `principalUserId` to nullable there would let every user-path call
 * site silently drop the acting user and forge human provenance. A system
 * authority is always org-wide unrestricted — it has no user whose site grants
 * could restrict it.
 */
export interface SystemReportExecutionAuthority {
  principalKind: 'system';
  scope: { version: 1; kind: 'unrestricted'; orgId: string };
  fingerprint: string;
  capturedAt: Date;
}

/**
 * The authorities a report generator may run under. `ReportExecutionAuthority`
 * is the request-path union (user | portal_user) and stays the public surface of
 * `generateReport`. `SystemReportExecutionAuthority` is admitted ONLY through
 * `generateManagedEvidenceReport`, and only for a type the closed
 * `MANAGED_EVIDENCE_REGISTRY` names (#5784, OD-5 = B).
 */
export type ReportGenerationAuthority =
  | ReportExecutionAuthority
  | SystemReportExecutionAuthority;

/** #3198 W02 (addendum B5). The request-path authorities an ORG generator may
 *  run under: org-axis user or portal user — never partner_wide/legacy. */
export type OrgReportExecutionAuthority =
  | OrgAxisUserReportExecutionAuthority
  | PortalUserReportExecutionAuthority;

/** `OrgReportExecutionAuthority` plus the managed-evidence system authority
 *  (always org-wide unrestricted). The authority parameter of every #5784
 *  managed-evidence generator. */
export type OrgReportGenerationAuthority =
  | OrgReportExecutionAuthority
  | SystemReportExecutionAuthority;

/**
 * The authority `generateManagedEvidenceReport` runs under (#5784). Always
 * org-wide unrestricted: a restricted fingerprint must never be stamped on an
 * org-wide result, because a later reader would believe the artifact was
 * scoped when it was not. Delegates to `systemReportAuthority` (P2-3) so there
 * is exactly one minting site with its argument validation.
 */
export function systemReportAuthorityFor(orgId: string): SystemReportExecutionAuthority {
  return systemReportAuthority(orgId);
}

export type LiveReportAuthorityResult =
  | { ok: true; authority: UserReportExecutionAuthority }
  | {
      ok: false;
      reason:
        | 'user_inactive'
        | 'membership_removed'
        | 'permission_removed'
        | 'organization_inaccessible'
        | 'empty_scope'
        | 'unverifiable_scope'
        // #3198 W01 - partner-axis refusals, never emitted by an org resolver.
        | 'partner_inaccessible'
        | 'partner_access_not_all';
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
  switch (scope.kind) {
    case 'unrestricted':
      assertNonEmptyString(scope.orgId, 'organization ID');
      return { version: 1, kind: 'unrestricted', orgId: scope.orgId };
    case 'restricted':
      assertNonEmptyString(scope.orgId, 'organization ID');
      return {
        version: 1,
        kind: 'restricted',
        orgId: scope.orgId,
        siteIds: normalizeSiteIds(scope.siteIds),
      };
    case 'legacy_unscoped':
      assertNonEmptyString(scope.orgId, 'organization ID');
      return { version: 1, kind: 'legacy_unscoped', orgId: scope.orgId };
    case 'partner_wide':
      assertNonEmptyString(scope.partnerId, 'partner ID');
      return { version: 1, kind: 'partner_wide', partnerId: scope.partnerId };
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

/**
 * An INTEGRITY digest over the normalized scope, not a MAC. It is unkeyed, so
 * anyone able to write the row can also write a matching digest: it proves the
 * seven execution-scope columns are internally consistent (no half-written or
 * hand-edited envelope decodes), never that a particular principal authored
 * them. Binding to a principal is done by the per-table
 * `*_execution_scope_shape_chk` constraint (`execution_scope_user_id =
 * requested_by`) plus the worker's re-assertion of live authority before use.
 */
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
    case 'partner_wide':
      stableValue = {
        version: normalized.version,
        kind: normalized.kind,
        partnerId: normalized.partnerId,
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

  // Partner-wide lives on a different axis than every org kind: it intersects
  // only with itself, same partner. Mixing axes can never narrow safely.
  if (
    normalizedPersisted.kind === 'partner_wide'
    || normalizedCurrent.kind === 'partner_wide'
  ) {
    return normalizedPersisted.kind === 'partner_wide'
      && normalizedCurrent.kind === 'partner_wide'
      && normalizedPersisted.partnerId === normalizedCurrent.partnerId
      ? normalizedPersisted
      : null;
  }

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

  // Same axis rule as intersectSiteScopes: partner-wide is a subset only of
  // the identical partner-wide scope, and never of (or a superset of) an org
  // scope.
  if (
    normalizedCandidate.kind === 'partner_wide'
    || normalizedCurrent.kind === 'partner_wide'
  ) {
    return (
      normalizedCandidate.kind === 'partner_wide'
      && normalizedCurrent.kind === 'partner_wide'
      && normalizedCandidate.partnerId === normalizedCurrent.partnerId
    );
  }

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

/**
 * The stored principal, with an ABSENT column read as NULL. A projection that
 * forgot the column must never be mistaken for one that read a 'system' row.
 */
function persistedPrincipalKind(
  row: PersistedSiteScopeColumns,
): ReportPrincipalKind | null {
  const value = row.executionScopePrincipalKind ?? null;
  if (
    value !== null
    && value !== 'user'
    && value !== 'system'
    && value !== 'portal_user'
  ) {
    throw new Error('invalid persisted site scope principal kind');
  }
  return value;
}

function allPersistedValuesAreNull(row: PersistedSiteScopeColumns): boolean {
  return (
    row.executionScopeVersion === null &&
    row.executionScopeKind === null &&
    row.executionScopeSiteIds === null &&
    row.executionScopeUserId === null &&
    row.executionScopeFingerprint === null &&
    row.executionScopeCapturedAt === null &&
    // The all-NULL arm of the shape CHECK requires a NULL principal too: a
    // stamped principal with no scope at all is malformed, not legacy.
    persistedPrincipalKind(row) === null
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

/**
 * `owner` is the report row's single tenancy axis (#3198 W01). A bare string
 * is still accepted and means an ORG owner, so every pre-existing call site
 * keeps its exact behaviour. The owner axis and the persisted kind must agree:
 * a partner_wide envelope on an org-owned row (or an org kind on a
 * partner-owned row) is a corrupted row, not a decodable one.
 */
export function decodeSiteScope(
  row: PersistedSiteScopeColumns,
  ownerOrOrgId: string | ReportOwner,
): SiteScopeV1 {
  const owner: ReportOwner =
    typeof ownerOrOrgId === 'string' ? { orgId: ownerOrOrgId } : ownerOrOrgId;
  if (owner.orgId !== undefined) {
    assertNonEmptyString(owner.orgId, 'organization ID');
  } else {
    assertNonEmptyString(owner.partnerId, 'partner ID');
  }

  if (allPersistedValuesAreNull(row)) {
    if (owner.orgId === undefined) {
      // There is no legacy partner-owned report: the axis shipped with the
      // execution-scope columns, so an empty envelope here is corruption.
      throw new Error('partner-owned report has no persisted execution scope');
    }
    return { version: 1, kind: 'legacy_unscoped', orgId: owner.orgId };
  }

  assertCompletePersistedBase(row);
  const principalKind = persistedPrincipalKind(row);
  const hasNoStaffPrincipal =
    principalKind === 'system' || principalKind === 'portal_user';

  if (row.executionScopeKind === 'partner_wide') {
    if (owner.partnerId === undefined) {
      throw new Error(
        'partner_wide execution scope on an org-owned report (owner mismatch)',
      );
    }
    if (hasNoStaffPrincipal) {
      throw new Error('invalid persisted non-user site scope kind');
    }
    if (
      row.executionScopeSiteIds !== null
      || row.executionScopeUserId === null
    ) {
      throw new Error('partial or invalid persisted partner_wide site scope');
    }
    assertNonEmptyString(row.executionScopeUserId, 'execution scope user ID');
    return validateDecodedScopeFingerprint(row, {
      version: 1,
      kind: 'partner_wide',
      partnerId: owner.partnerId,
    });
  }

  if (owner.orgId === undefined) {
    throw new Error(
      'org-kind execution scope on a partner-owned report (owner mismatch)',
    );
  }
  const orgId = owner.orgId;

  switch (row.executionScopeKind) {
    case 'unrestricted':
      if (row.executionScopeSiteIds !== null) {
        throw new Error('partial or invalid persisted unrestricted site scope');
      }
      if (hasNoStaffPrincipal) {
        if (row.executionScopeUserId !== null) {
          throw new Error('invalid persisted non-user site scope principal');
        }
      } else {
        if (row.executionScopeUserId === null) {
          throw new Error('partial or invalid persisted unrestricted site scope');
        }
        assertNonEmptyString(row.executionScopeUserId, 'execution scope user ID');
      }
      return validateDecodedScopeFingerprint(row, {
        version: 1,
        kind: 'unrestricted',
        orgId,
      });
    case 'restricted':
      if (hasNoStaffPrincipal) {
        throw new Error('invalid persisted non-user site scope kind');
      }
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
      if (hasNoStaffPrincipal) {
        throw new Error('invalid persisted non-user site scope kind');
      }
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
  assertValidDate(authority.capturedAt);
  const scope = normalizeScope(authority.scope);

  if (authority.fingerprint !== siteScopeFingerprint(scope)) {
    throw new Error('invalid execution scope fingerprint');
  }

  switch (authority.principalKind) {
    case 'portal_user':
      if (scope.kind !== 'unrestricted') {
        throw new Error('invalid portal-user execution scope kind');
      }
      if (
        'principalUserId' in authority
        && authority.principalUserId !== null
        && authority.principalUserId !== undefined
      ) {
        throw new Error('invalid portal-user execution scope principal');
      }
      return {
        executionScopeVersion: 1,
        executionScopeKind: 'unrestricted',
        executionScopeSiteIds: null,
        executionScopeUserId: null,
        executionScopeFingerprint: authority.fingerprint,
        executionScopeCapturedAt: authority.capturedAt,
        executionScopePrincipalKind: 'portal_user',
      };
    case 'user':
      assertNonEmptyString(authority.principalUserId, 'principal user ID');
      if (scope.kind === 'partner_wide') {
        // A partner-wide envelope persists exactly like an unrestricted one
        // (no site ids); the partner itself is carried by the OWNING row, so
        // guard the value that would otherwise never be validated here.
        assertNonEmptyString(scope.partnerId, 'partner ID');
      }
      return {
        executionScopeVersion: 1,
        executionScopeKind: scope.kind,
        executionScopeSiteIds:
          scope.kind === 'restricted' ? scope.siteIds : null,
        executionScopeUserId: authority.principalUserId,
        executionScopeFingerprint: authority.fingerprint,
        executionScopeCapturedAt: authority.capturedAt,
        executionScopePrincipalKind: 'user',
      };
    default:
      return assertNever(authority);
  }
}

export function portalUserReportAuthority(
  orgId: string,
  capturedAt = new Date(),
): PortalUserReportExecutionAuthority {
  assertNonEmptyString(orgId, 'organization ID');
  assertValidDate(capturedAt);
  const scope = { version: 1, kind: 'unrestricted', orgId } as const;
  return {
    principalKind: 'portal_user',
    scope,
    capturedAt,
    fingerprint: siteScopeFingerprint(scope),
  };
}

/**
 * P2-3 (#4190). Provenance for a platform-authored report in `orgId`. There is
 * no acting user anywhere in this path — the scope is org-wide unrestricted and
 * the principal is recorded as 'system'.
 */
export function systemReportAuthority(
  orgId: string,
  capturedAt = new Date(),
): SystemReportExecutionAuthority {
  assertNonEmptyString(orgId, 'organization ID');
  assertValidDate(capturedAt);

  const scope = { version: 1, kind: 'unrestricted', orgId } as const;
  return {
    principalKind: 'system',
    scope,
    fingerprint: siteScopeFingerprint(scope),
    capturedAt,
  };
}

export function persistedSystemSiteScopeValues(
  authority: SystemReportExecutionAuthority,
): PersistedSiteScopeColumns {
  if (authority.principalKind !== 'system') {
    throw new Error('invalid system execution scope principal kind');
  }
  if (authority.scope?.kind !== 'unrestricted') {
    throw new Error('invalid system execution scope kind');
  }
  assertValidDate(authority.capturedAt);

  const scope = normalizeScope(authority.scope);
  if (authority.fingerprint !== siteScopeFingerprint(scope)) {
    throw new Error('invalid execution scope fingerprint');
  }

  return {
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: null,
    executionScopeFingerprint: authority.fingerprint,
    executionScopeCapturedAt: authority.capturedAt,
    executionScopePrincipalKind: 'system',
  };
}

type ReportScopeColumns = Pick<
  typeof reports | typeof reportRuns,
  | 'executionScopeVersion'
  | 'executionScopeKind'
  | 'executionScopeSiteIds'
  | 'executionScopeUserId'
  | 'executionScopeFingerprint'
  | 'executionScopeCapturedAt'
  | 'executionScopePrincipalKind'
>;

function sqlFalse(): SQL<unknown> {
  return sql<unknown>`FALSE`;
}

function completeVersionOneBase(
  columns: ReportScopeColumns,
): SQL<unknown> {
  // Human-authored rows may predate the principal column (NULL) or carry the
  // explicit discriminator. Non-user principals never enter restricted arms.
  return and(
    eq(columns.executionScopeVersion, 1),
    isNotNull(columns.executionScopeUserId),
    or(
      isNull(columns.executionScopePrincipalKind),
      eq(columns.executionScopePrincipalKind, 'user'),
    ),
    isNotNull(columns.executionScopeFingerprint),
    isNotNull(columns.executionScopeCapturedAt),
  )!;
}

function completeVersionOnePortalUserBase(
  columns: ReportScopeColumns,
): SQL<unknown> {
  return and(
    eq(columns.executionScopeVersion, 1),
    isNull(columns.executionScopeUserId),
    eq(columns.executionScopePrincipalKind, 'portal_user'),
    isNotNull(columns.executionScopeFingerprint),
    isNotNull(columns.executionScopeCapturedAt),
  )!;
}

/**
 * P2-3 (#4190) — the system-principal twin of completeVersionOneBase: version 1
 * and complete, but with NO acting user, which is legal only when the principal
 * is explicitly 'system'. Without this branch every predicate below would drop
 * platform-authored rows (they all require execution_scope_user_id NOT NULL),
 * 404ing an unrestricted reader on a report the platform wrote for them.
 */
function completeVersionOneSystemBase(
  columns: ReportScopeColumns,
): SQL<unknown> {
  return and(
    eq(columns.executionScopeVersion, 1),
    isNull(columns.executionScopeUserId),
    eq(columns.executionScopePrincipalKind, 'system'),
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
    // Platform-authored: unrestricted, no acting user, principal 'system'.
    and(
      completeVersionOneSystemBase(columns),
      eq(columns.executionScopeKind, 'unrestricted'),
      isNull(columns.executionScopeSiteIds),
    ),
    // Portal-authored: unrestricted, no MSP acting user.
    and(
      completeVersionOnePortalUserBase(columns),
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
      sql`${columns.executionScopePrincipalKind} IS DISTINCT FROM 'system'`,
      sql`${columns.executionScopePrincipalKind} IS DISTINCT FROM 'portal_user'`,
    ),
    and(
      isNull(columns.executionScopeVersion),
      isNull(columns.executionScopeKind),
      isNull(columns.executionScopeSiteIds),
      isNull(columns.executionScopeUserId),
      isNull(columns.executionScopeFingerprint),
      isNull(columns.executionScopeCapturedAt),
      isNull(columns.executionScopePrincipalKind),
    ),
  )!;
}

function definitionScopePredicate(
  columns: ReportScopeColumns,
  currentScope: LiveSiteScopeV1,
): SQL<unknown> {
  // Widened to the full SiteScopeV1 so the switch names every kind and the
  // default arm is a true `never` (#3198 W02, addendum B6).
  const scope = currentScope as SiteScopeV1;
  switch (scope.kind) {
    case 'unrestricted':
      return unrestrictedDefinitionPredicate(columns);
    case 'restricted': {
      const normalizedSiteIds = normalizeSiteIds(scope.siteIds);
      return and(
        completeVersionOneBase(columns),
        eq(columns.executionScopeKind, 'restricted'),
        isNotNull(columns.executionScopeSiteIds),
        sql`${columns.executionScopeSiteIds} <@ ${sqlUuidArray(normalizedSiteIds)}`,
      )!;
    }
    case 'partner_wide':
      // #3198 W01. A partner_wide scope has no org to bind, and these
      // single-scope predicates cannot see the row's partner_id. Falling to
      // sqlFalse would disguise a wiring bug as "no rows"; callers holding a
      // partner_wide authority use reportPartnerWideScopeSqlPredicate.
      throw new Error(
        'partner_wide scope requires the partner-axis predicate (reportPartnerWideScopeSqlPredicate)',
      );
    case 'legacy_unscoped':
      // Excluded from LiveSiteScopeV1, so reachable only through a cast. A
      // legacy caller scope matches nothing — fail closed (pinned by
      // siteScope.test.ts "fails closed for a forced legacy live caller value").
      return sqlFalse();
    default:
      // A kind with no arm is a wiring bug, not "no rows": a compile error for
      // a new SiteScopeV1 kind, a throw at runtime for a value that escaped
      // the types.
      return assertNever(scope);
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

/**
 * #3198 W01. The org axis of the multi-org predicates. Partner-wide is not an
 * organization-axis scope and is delivered through the explicit `partnerWide`
 * argument instead, so it is rejected here rather than silently dropped.
 */
export type OrgAxisLiveSiteScopeV1 = Exclude<LiveSiteScopeV1, { kind: 'partner_wide' }>;

/**
 * #3198 W01 (spec 3.1a). Matches a PARTNER-OWNED row whose execution-scope
 * envelope is a complete v1 partner_wide capture by a real user. The partner
 * itself is matched on the row's own `partner_id`; the envelope never stores
 * it, so the two must be asserted together or a row from another partner with
 * the same kind would match.
 */
function partnerWideRowPredicate(
  columns: ReportScopeColumns,
  partnerWide: PartnerWideScopeSqlTarget,
): SQL<unknown> {
  assertNonEmptyString(partnerWide.partnerId, 'partner ID');
  return and(
    eq(partnerWide.rowPartnerId, partnerWide.partnerId),
    completeVersionOneBase(columns),
    eq(columns.executionScopeKind, 'partner_wide'),
    isNull(columns.executionScopeSiteIds),
    eq(columns.executionScopePrincipalKind, 'user'),
  )!;
}

/**
 * The partner axis of a multi-org predicate: the row's `partner_id` column and
 * the partner the caller holds live partner-wide authority for. Omitted by
 * every org-axis caller, which therefore gets exactly today's SQL.
 */
export type PartnerWideScopeSqlTarget = {
  rowPartnerId: typeof reports.partnerId;
  partnerId: string;
};

/**
 * #3198 W01. The single-row predicate for a PARTNER-OWNED definition or run
 * read under a live partner_wide authority: the joined/owning report row's
 * `partner_id` is the caller's partner AND the row's envelope is a complete v1
 * partner_wide capture by a real user. `columns` is `reports` for a definition
 * read and `reportRuns` for a run read (the run carries its own envelope).
 */
export function reportPartnerWideScopeSqlPredicate(
  columns: ReportScopeColumns,
  partnerWide: PartnerWideScopeSqlTarget,
): SQL<unknown> {
  return partnerWideRowPredicate(columns, partnerWide);
}

export function reportDefinitionMultiOrgScopeSqlPredicate(
  rowOrgId: typeof reports.orgId,
  columns: ReportScopeColumns,
  authorizedScopes: readonly LiveSiteScopeV1[],
  partnerWide?: PartnerWideScopeSqlTarget,
): SQL<unknown> {
  const scopesByOrgId = new Map<string, OrgAxisLiveSiteScopeV1>();

  for (const scope of authorizedScopes) {
    if (scope.kind === 'partner_wide') {
      throw new Error('partner-wide scope is not an organization-axis scope');
    }
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

  if (partnerWide) {
    branches.push(partnerWideRowPredicate(columns, partnerWide));
  }

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
  partnerWide?: PartnerWideScopeSqlTarget,
): SQL<unknown> {
  const scopesByOrgId = new Map<string, OrgAxisLiveSiteScopeV1>();

  for (const scope of authorizedScopes) {
    if (scope.kind === 'partner_wide') {
      throw new Error('partner-wide scope is not an organization-axis scope');
    }
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

  if (partnerWide) {
    branches.push(partnerWideRowPredicate(columns, partnerWide));
  }

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
      principalKind: 'user',
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

// #3198 W02 (B4): a DB failure during the live authority read still fails
// closed as 'unverifiable_scope', but must not be silent - an outage would
// otherwise read as a wave of ordinary permission refusals.
function reportAuthorityLookupFailed(
  context: Record<string, unknown>,
  err: unknown,
): void {
  console.error('[siteScope] live report authority lookup failed', { ...context, err });
  captureException(err);
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
  } catch (err) {
    reportAuthorityLookupFailed({ userId, orgId }, err);
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

/**
 * #3198 W01 (spec 3.1a). Live authority for a PARTNER-OWNED report: the user
 * must be active, hold exactly one partner_users membership for `partnerId`
 * with org_access = 'all', and that membership's role must grant the report
 * action. 'selected' / 'none' access is refused - a user who cannot open every
 * org individually must not read an aggregate over all of them. Platform
 * admins pass under `allowPlatformAuthority` exactly as for org authorities.
 */
export async function resolveLivePartnerReportAuthority(
  userId: string,
  partnerId: string,
  action: ReportAction,
): Promise<LiveReportAuthorityResult> {
  return resolveExactPartnerReportAuthority(userId, partnerId, action, true);
}

/**
 * The request-path twin. The token is a pre-filter only: it can refuse early,
 * but it never grants - the membership and its org_access are re-read from the
 * database below, because a token outlives a demotion from 'all' to 'selected'.
 */
export async function resolveRequestPartnerReportAuthority(
  auth: AuthContext,
  partnerId: string,
  action: ReportAction,
): Promise<LiveReportAuthorityResult> {
  if (auth.scope === 'system') {
    return resolveExactPartnerReportAuthority(
      auth.user.id,
      partnerId,
      action,
      true,
    );
  }
  if (auth.scope !== 'partner' || auth.partnerId !== partnerId) {
    return denied('partner_inaccessible');
  }
  // Same capability as every other partner-wide surface (epic #2135); the live
  // re-read below is the authority, this is the cheap token-side refusal.
  if (!canManagePartnerWidePolicies(auth)) {
    return denied('partner_access_not_all');
  }
  return resolveExactPartnerReportAuthority(
    auth.user.id,
    partnerId,
    action,
    false,
  );
}

async function resolveExactPartnerReportAuthority(
  userId: string,
  partnerId: string,
  action: ReportAction,
  allowPlatformAuthority: boolean,
): Promise<LiveReportAuthorityResult> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        resolveExactPartnerReportAuthorityInSystemContext(
          userId,
          partnerId,
          action,
          allowPlatformAuthority,
        ),
      ),
    );
  } catch (err) {
    reportAuthorityLookupFailed({ userId, partnerId }, err);
    return denied('unverifiable_scope');
  }
}

async function resolveExactPartnerReportAuthorityInSystemContext(
  userId: string,
  partnerId: string,
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

  if (allowPlatformAuthority && user.isPlatformAdmin) {
    return liveAuthority(partnerWideScope(partnerId), user.id);
  }
  if (user.partnerId !== partnerId) {
    return denied('partner_inaccessible');
  }

  const memberships = await db
    .select({
      roleId: partnerUsers.roleId,
      orgAccess: partnerUsers.orgAccess,
    })
    .from(partnerUsers)
    .where(
      and(
        eq(partnerUsers.userId, user.id),
        eq(partnerUsers.partnerId, partnerId),
      ),
    )
    .limit(2);
  if (memberships.length > 1) {
    return denied('unverifiable_scope');
  }
  const membership = memberships[0];
  if (!membership) {
    return denied('membership_removed');
  }
  if (membership.orgAccess !== 'all') {
    return denied('partner_access_not_all');
  }
  if (
    !membership.roleId
    || !(await roleGrantsReportAction(membership.roleId, action, {
      scope: 'partner',
      partnerId,
    }))
  ) {
    return denied('permission_removed');
  }

  return liveAuthority(partnerWideScope(partnerId), user.id);
}

/**
 * True when `roleId` grants EVERY permission in `required` (wildcards honoured
 * through `permissionGrantMatches`, #2874), restricted to a role of the
 * expected scope that is either a system role or owned by the expected tenant —
 * the same role-ownership rule as `roleGrantsReportAction`.
 */
async function roleGrantsAllPermissions(
  roleId: string,
  required: readonly { resource: string; action: string }[],
  expectedRole:
    | { scope: 'organization'; orgId: string }
    | { scope: 'partner'; partnerId: string },
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
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      and(
        eq(rolePermissions.roleId, roleId),
        eq(roles.scope, expectedRole.scope),
        or(
          eq(roles.isSystem, true),
          expectedRole.scope === 'organization'
            ? eq(roles.orgId, expectedRole.orgId)
            : eq(roles.partnerId, expectedRole.partnerId),
        ),
      ),
    );

  const eligible = rows.filter(
    (row) =>
      row.roleScope === expectedRole.scope
      && (row.roleIsSystem
        || (expectedRole.scope === 'organization'
          ? row.roleOrgId === expectedRole.orgId
          : row.rolePartnerId === expectedRole.partnerId)),
  );
  return required.every((perm) =>
    eligible.some((row) => permissionGrantMatches(row, perm.resource, perm.action)),
  );
}

async function resolveLiveReportTypePermissionsInSystemContext(
  userId: string,
  owner: ReportOwner,
  required: readonly { resource: string; action: string }[],
): Promise<boolean> {
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
  if (!user || user.status !== 'active') return false;
  // Mirrors `allowPlatformAuthority` on the live (worker) resolvers.
  if (user.isPlatformAdmin) return true;

  const partnerRoleGrants = async (partnerId: string): Promise<boolean> => {
    if (user.partnerId !== partnerId) return false;
    const memberships = await db
      .select({ roleId: partnerUsers.roleId })
      .from(partnerUsers)
      .where(and(eq(partnerUsers.userId, user.id), eq(partnerUsers.partnerId, partnerId)))
      .limit(2);
    if (memberships.length !== 1 || !memberships[0]!.roleId) return false;
    return roleGrantsAllPermissions(memberships[0]!.roleId, required, {
      scope: 'partner',
      partnerId,
    });
  };

  if (owner.partnerId !== undefined) {
    return partnerRoleGrants(owner.partnerId);
  }

  const [organization] = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, owner.orgId))
    .limit(1);
  if (!organization) return false;

  // Org membership takes precedence over the partner membership — the same
  // axis `resolveExactReportAuthorityInSystemContext` authorizes through.
  const orgMemberships = await db
    .select({ roleId: organizationUsers.roleId })
    .from(organizationUsers)
    .where(and(eq(organizationUsers.userId, user.id), eq(organizationUsers.orgId, owner.orgId)))
    .limit(2);
  if (orgMemberships.length > 1) return false;
  const orgMembership = orgMemberships[0];
  if (orgMembership) {
    return !!orgMembership.roleId
      && roleGrantsAllPermissions(orgMembership.roleId, required, {
        scope: 'organization',
        orgId: owner.orgId,
      });
  }
  return partnerRoleGrants(organization.partnerId);
}

/**
 * #3198 W02 (spec §2, ruling P8). Whether the report's EXECUTION user still
 * holds a report type's underlying read permissions (`requiredPermissions` in
 * the registry, e.g. invoices:read for ar_aging) through the same membership
 * axis the live authority resolvers use: the partner membership for a
 * partner owner; the org membership, else the partner membership of the org's
 * partner, for an org owner. The request routes check the caller's resolved
 * permission set instead; the schedule worker has no request, so this is its
 * re-check — without it, a creator demoted off invoices:read would keep
 * receiving AR aging by email.
 *
 * Fails closed: a database failure answers false (the worker records a deny).
 */
export async function resolveLiveReportTypePermissions(
  userId: string,
  owner: ReportOwner,
  required: readonly { resource: string; action: string }[],
): Promise<boolean> {
  if (required.length === 0) return true;
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        resolveLiveReportTypePermissionsInSystemContext(userId, owner, required),
      ),
    );
  } catch (error) {
    console.error('[siteScope] report type permission re-check failed', {
      userId,
      owner,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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
  } catch (err) {
    reportAuthorityLookupFailed(
      { userId: auth.user.id, orgIds: accessibleOrgIds },
      err,
    );
    for (const orgId of accessibleOrgIds) {
      result.set(orgId, denied('unverifiable_scope'));
    }
  }
  return result;
}
