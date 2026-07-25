import { createHash } from 'node:crypto';
import type { UserPermissions } from './permissions';

export type SiteScopeV1 =
  | { version: 1; kind: 'unrestricted'; orgId: string }
  | { version: 1; kind: 'restricted'; orgId: string; siteIds: string[] }
  | { version: 1; kind: 'legacy_unscoped'; orgId: string };

export type LiveSiteScopeV1 = Exclude<SiteScopeV1, { kind: 'legacy_unscoped' }>;

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
