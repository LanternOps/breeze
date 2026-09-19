import { createHash, randomUUID } from 'crypto';
import { and, eq, inArray, or } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  organizationUsers,
  organizations,
  partnerUsers,
  permissions,
  rolePermissions,
  roles,
  users,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { PERMISSIONS } from './permissions';
import { permissionGrantMatches } from './permissionMatching';

export type SensitiveDataAuthorityKind =
  | 'organization_restricted'
  | 'organization_unrestricted'
  | 'partner_unrestricted';

export type SensitiveDataPolicyOwner =
  | { orgId: string; partnerId: null }
  | { orgId: null; partnerId: string };

export type PersistedSensitiveDataAuthority = {
  orgId: string | null;
  partnerId: string | null;
  executionAuthorityVersion: number | null;
  executionAuthorityKind: SensitiveDataAuthorityKind | null;
  executionAuthoritySiteIds: string[] | null;
  executionAuthorityUserId: string | null;
  executionAuthorityPrincipalKind: 'user' | 'system' | null;
  executionAuthorityFingerprint: string | null;
  executionAuthorityCapturedAt: Date | null;
  executionAuthorityGeneration: string | null;
};

export type SensitiveDataAuthorityValues = {
  executionAuthorityVersion: 1;
  executionAuthorityKind: SensitiveDataAuthorityKind;
  executionAuthoritySiteIds: string[] | null;
  executionAuthorityUserId: string | null;
  executionAuthorityPrincipalKind: 'user' | 'system';
  executionAuthorityFingerprint: string;
  executionAuthorityCapturedAt: Date;
  executionAuthorityGeneration: string;
};

export type EffectiveSensitiveDataAuthority = {
  kind: SensitiveDataAuthorityKind;
  siteIds: string[] | null;
  userId: string | null;
  principalKind: 'user' | 'system';
  fingerprint: string;
  generation: string;
};

export const EMPTY_SENSITIVE_DATA_AUTHORITY = {
  executionAuthorityVersion: null,
  executionAuthorityKind: null,
  executionAuthoritySiteIds: null,
  executionAuthorityUserId: null,
  executionAuthorityPrincipalKind: null,
  executionAuthorityFingerprint: null,
  executionAuthorityCapturedAt: null,
  executionAuthorityGeneration: null,
} as const;

function normalizeSiteIds(siteIds: readonly string[]): string[] {
  return [...new Set(siteIds)].sort();
}

function fingerprint(input: {
  owner: SensitiveDataPolicyOwner;
  kind: SensitiveDataAuthorityKind;
  siteIds: string[] | null;
  userId: string | null;
  principalKind: 'user' | 'system';
  generation: string;
}): string {
  const ownerAxis = input.owner.orgId ? 'organization' : 'partner';
  const ownerId = input.owner.orgId ?? input.owner.partnerId;
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    ownerAxis,
    ownerId,
    kind: input.kind,
    siteIds: input.siteIds,
    userId: input.userId,
    principalKind: input.principalKind,
    generation: input.generation,
  })).digest('hex');
}

export function captureSensitiveDataAuthority(
  auth: AuthContext,
  owner: SensitiveDataPolicyOwner,
  capturedAt = new Date(),
): SensitiveDataAuthorityValues | null {
  let kind: SensitiveDataAuthorityKind;
  let siteIds: string[] | null = null;

  if (owner.orgId) {
    if (!auth.canAccessOrg(owner.orgId)) return null;
    if (auth.scope === 'organization') {
      if (auth.orgId !== owner.orgId) return null;
      if (auth.allowedSiteIds !== undefined) {
        siteIds = normalizeSiteIds(auth.allowedSiteIds);
        if (siteIds.length === 0) return null;
        kind = 'organization_restricted';
      } else {
        kind = 'organization_unrestricted';
      }
    } else {
      kind = 'organization_unrestricted';
    }
  } else {
    if (auth.scope !== 'system' && (
      auth.scope !== 'partner'
      || auth.partnerId !== owner.partnerId
      || auth.partnerOrgAccess !== 'all'
    )) return null;
    kind = 'partner_unrestricted';
  }

  // Policies created through an authenticated HTTP route remain creator-bound,
  // even while that creator has platform scope. Only an explicit internal
  // caller may mint a durable system principal.
  const principalKind = 'user' as const;
  const userId = auth.user.id;
  const executionAuthorityGeneration = randomUUID();
  const executionAuthorityFingerprint = fingerprint({
    owner,
    kind,
    siteIds,
    userId,
    principalKind,
    generation: executionAuthorityGeneration,
  });
  return {
    executionAuthorityVersion: 1,
    executionAuthorityKind: kind,
    executionAuthoritySiteIds: siteIds,
    executionAuthorityUserId: userId,
    executionAuthorityPrincipalKind: principalKind,
    executionAuthorityFingerprint,
    executionAuthorityCapturedAt: capturedAt,
    executionAuthorityGeneration,
  };
}

export function captureSystemSensitiveDataAuthority(
  owner: SensitiveDataPolicyOwner,
  capturedAt = new Date(),
): SensitiveDataAuthorityValues {
  const kind = owner.orgId ? 'organization_unrestricted' : 'partner_unrestricted';
  const executionAuthorityGeneration = randomUUID();
  const executionAuthorityFingerprint = fingerprint({
    owner,
    kind,
    siteIds: null,
    userId: null,
    principalKind: 'system',
    generation: executionAuthorityGeneration,
  });
  return {
    executionAuthorityVersion: 1,
    executionAuthorityKind: kind,
    executionAuthoritySiteIds: null,
    executionAuthorityUserId: null,
    executionAuthorityPrincipalKind: 'system',
    executionAuthorityFingerprint,
    executionAuthorityCapturedAt: capturedAt,
    executionAuthorityGeneration,
  };
}

export function decodeSensitiveDataAuthority(
  row: PersistedSensitiveDataAuthority,
): EffectiveSensitiveDataAuthority | null {
  if (
    row.executionAuthorityVersion !== 1
    || !row.executionAuthorityKind
    || !row.executionAuthorityPrincipalKind
    || !row.executionAuthorityFingerprint
    || !row.executionAuthorityCapturedAt
    || !row.executionAuthorityGeneration
  ) return null;

  const owner: SensitiveDataPolicyOwner | null = row.orgId && !row.partnerId
    ? { orgId: row.orgId, partnerId: null }
    : row.partnerId && !row.orgId
      ? { orgId: null, partnerId: row.partnerId }
      : null;
  if (!owner) return null;

  const siteIds = row.executionAuthorityKind === 'organization_restricted'
    ? normalizeSiteIds(row.executionAuthoritySiteIds ?? [])
    : null;
  if (row.executionAuthorityKind === 'organization_restricted' && siteIds?.length === 0) return null;
  if (row.executionAuthorityKind !== 'organization_restricted' && row.executionAuthoritySiteIds !== null) return null;
  if (row.executionAuthorityKind.startsWith('organization_') !== Boolean(row.orgId)) return null;
  if (row.executionAuthorityKind === 'partner_unrestricted' !== Boolean(row.partnerId)) return null;
  const userId = row.executionAuthorityPrincipalKind === 'user'
    ? row.executionAuthorityUserId
    : null;
  if (row.executionAuthorityPrincipalKind === 'user' && !userId) return null;
  if (row.executionAuthorityPrincipalKind === 'system' && row.executionAuthorityUserId !== null) return null;

  const expected = fingerprint({
    owner,
    kind: row.executionAuthorityKind,
    siteIds,
    userId,
    principalKind: row.executionAuthorityPrincipalKind,
    generation: row.executionAuthorityGeneration,
  });
  if (expected !== row.executionAuthorityFingerprint) return null;
  return {
    kind: row.executionAuthorityKind,
    siteIds,
    userId,
    principalKind: row.executionAuthorityPrincipalKind,
    fingerprint: expected,
    generation: row.executionAuthorityGeneration,
  };
}

export async function resolveSensitiveDataAuthorityInCurrentSystemContext(
  row: PersistedSensitiveDataAuthority,
): Promise<EffectiveSensitiveDataAuthority | null> {
  const persisted = decodeSensitiveDataAuthority(row);
  if (!persisted) return null;
  if (persisted.principalKind === 'system') return persisted;
  if (!persisted.userId) return null;

  const [user] = await db
    .select({ status: users.status, isPlatformAdmin: users.isPlatformAdmin, partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, persisted.userId))
    .limit(1);
  if (!user || user.status !== 'active') return null;
  // A later privilege increase must not widen the captured ceiling.
  if (user.isPlatformAdmin) return persisted;

  const roleGrantsExecute = async (
    roleId: string,
    expected: { scope: 'organization'; orgId: string } | { scope: 'partner'; partnerId: string },
  ): Promise<boolean> => {
    const grants = await db
      .select({
        resource: permissions.resource, action: permissions.action,
        roleScope: roles.scope, roleIsSystem: roles.isSystem,
        roleOrgId: roles.orgId, rolePartnerId: roles.partnerId,
      })
      .from(rolePermissions)
      .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(and(
        eq(rolePermissions.roleId, roleId),
        inArray(permissions.resource, [PERMISSIONS.DEVICES_EXECUTE.resource, '*']),
        inArray(permissions.action, [PERMISSIONS.DEVICES_EXECUTE.action, '*']),
        eq(roles.scope, expected.scope),
        or(
          eq(roles.isSystem, true),
          expected.scope === 'organization'
            ? eq(roles.orgId, expected.orgId)
            : eq(roles.partnerId, expected.partnerId),
        ),
      ));
    return grants.some((grant) => permissionGrantMatches(
      grant, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action,
    ));
  };

  if (row.orgId) {
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, row.orgId))
      .limit(1);
    if (!org) return null;
    const orgMemberships = await db
      .select({ roleId: organizationUsers.roleId, siteIds: organizationUsers.siteIds })
      .from(organizationUsers)
      .where(and(eq(organizationUsers.userId, persisted.userId), eq(organizationUsers.orgId, row.orgId)))
      .limit(2);
    if (orgMemberships.length > 1) return null;
    let liveSiteIds: string[] | null;
    if (orgMemberships[0]) {
      if (!(await roleGrantsExecute(orgMemberships[0].roleId, { scope: 'organization', orgId: row.orgId }))) {
        return null;
      }
      liveSiteIds = orgMemberships[0].siteIds === null
        ? null
        : normalizeSiteIds(orgMemberships[0].siteIds);
    } else {
      if (user.partnerId !== org.partnerId) return null;
      const memberships = await db
        .select({ roleId: partnerUsers.roleId, orgAccess: partnerUsers.orgAccess, orgIds: partnerUsers.orgIds })
        .from(partnerUsers)
        .where(and(eq(partnerUsers.userId, persisted.userId), eq(partnerUsers.partnerId, org.partnerId)))
        .limit(2);
      if (memberships.length !== 1) return null;
      const membership = memberships[0]!;
      const admitsOrg = membership.orgAccess === 'all'
        || (membership.orgAccess === 'selected' && (membership.orgIds?.includes(row.orgId) ?? false));
      if (!admitsOrg || !(await roleGrantsExecute(membership.roleId, { scope: 'partner', partnerId: org.partnerId }))) {
        return null;
      }
      liveSiteIds = null;
    }
    if (liveSiteIds !== null && liveSiteIds.length === 0) return null;
    if (persisted.siteIds === null) {
      return {
        ...persisted,
        kind: liveSiteIds === null ? 'organization_unrestricted' : 'organization_restricted',
        siteIds: liveSiteIds,
      };
    }
    const allowed = liveSiteIds === null
      ? persisted.siteIds
      : persisted.siteIds.filter((siteId) => liveSiteIds.includes(siteId));
    if (allowed.length === 0) return null;
    return { ...persisted, kind: 'organization_restricted', siteIds: allowed };
  }

  if (!row.partnerId) return null;
  const memberships = await db
    .select({ roleId: partnerUsers.roleId, orgAccess: partnerUsers.orgAccess })
    .from(partnerUsers)
    .where(and(eq(partnerUsers.userId, persisted.userId), eq(partnerUsers.partnerId, row.partnerId)))
    .limit(2);
  if (
    memberships.length !== 1
    || memberships[0]!.orgAccess !== 'all'
    || !(await roleGrantsExecute(memberships[0]!.roleId, { scope: 'partner', partnerId: row.partnerId }))
  ) return null;
  return persisted;
}

export async function resolveSensitiveDataAuthority(
  row: PersistedSensitiveDataAuthority,
): Promise<EffectiveSensitiveDataAuthority | null> {
  try {
    return await runOutsideDbContext(() => withSystemDbAccessContext(() => resolveSensitiveDataAuthorityInCurrentSystemContext(row)));
  } catch {
    return null;
  }
}

export function authorityAdmitsDevice(
  authority: EffectiveSensitiveDataAuthority,
  policy: SensitiveDataPolicyOwner,
  device: { orgId: string; siteId: string | null; partnerId: string },
): boolean {
  if (policy.orgId) {
    if (device.orgId !== policy.orgId) return false;
  } else if (device.partnerId !== policy.partnerId) {
    return false;
  }
  return authority.siteIds === null
    || (device.siteId !== null && authority.siteIds.includes(device.siteId));
}
