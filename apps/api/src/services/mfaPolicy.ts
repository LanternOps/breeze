import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  getExplicitMfaAllowedMethods,
  getExplicitMfaRequirement,
  hasMfaAllowedMethodsInput,
  hasMfaPolicyInput,
  MFA_PRIMARY_METHODS,
  type MfaMethod,
  type MfaPrimaryMethod,
} from '@breeze/shared';
import {
  db,
  runOutsideDbContext,
  withSystemDbAccessContext,
  withSystemDbAccessTransaction,
} from '../db';
import {
  organizationUsers,
  organizations,
  partners,
  partnerUsers,
  roles,
  users,
} from '../db/schema';
import type { AuthLifecycleTransaction } from './authLifecycle';
import {
  getLocalMfaAuthenticationMethod,
  type AuthenticationMethod,
} from './jwt';

export type { MfaMethod } from '@breeze/shared';

export type MfaPolicyScope = 'system' | 'partner' | 'organization';

export interface EffectiveMfaPolicy {
  required: boolean;
  allowedMethods: ReadonlySet<MfaMethod>;
  sources: Array<'role' | 'partner' | 'organization'>;
}

export type MfaAssuranceFailure = 'mfa_required' | 'method_not_allowed';

/**
 * Evaluate already-verified first-party token assurance against the live
 * effective policy. Local allowlists govern Breeze-held factors only. SSO and
 * Cloudflare Access remain external primary authenticators and satisfy a
 * required policy only when their issuer set the signed, AMR-consistent
 * compatibility bit after verifying its configured MFA trust signal.
 */
export function getMfaAssuranceFailure(
  token: { mfa: boolean; amr: readonly AuthenticationMethod[] },
  policy: EffectiveMfaPolicy,
): MfaAssuranceFailure | null {
  const localMethod = getLocalMfaAuthenticationMethod(token.amr);
  if (localMethod && !policy.allowedMethods.has(localMethod)) {
    return 'method_not_allowed';
  }
  if (policy.required && token.mfa !== true) {
    return 'mfa_required';
  }
  return null;
}

export interface ResolveEffectiveMfaPolicyInput {
  userId: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: MfaPolicyScope;
  tx?: AuthLifecycleTransaction;
}

export class MfaPolicyResolutionError extends Error {
  constructor(message = 'Unable to resolve an active MFA policy') {
    super(message);
    this.name = 'MfaPolicyResolutionError';
  }
}

export class MfaPolicyConfigurationError extends Error {
  constructor(message = 'MFA allowed methods must retain at least one primary factor') {
    super(message);
    this.name = 'MfaPolicyConfigurationError';
  }
}

function assertScopeAxes(input: ResolveEffectiveMfaPolicyInput): void {
  if (input.scope === 'system') {
    if (input.partnerId !== null || input.orgId !== null) {
      throw new MfaPolicyResolutionError('System MFA policy must not carry tenant axes');
    }
    return;
  }

  if (!input.partnerId || !input.roleId) {
    throw new MfaPolicyResolutionError('Tenant MFA policy requires partner and role axes');
  }
  if (input.scope === 'partner' && input.orgId !== null) {
    throw new MfaPolicyResolutionError('Partner MFA policy must not carry an organization axis');
  }
  if (input.scope === 'organization' && !input.orgId) {
    throw new MfaPolicyResolutionError('Organization MFA policy requires an organization axis');
  }
}

function requireMfaFromSettings(settings: unknown): boolean {
  try {
    return getExplicitMfaRequirement(settings) === true;
  } catch (error) {
    throw new MfaPolicyConfigurationError(
      error instanceof Error ? error.message : 'Stored MFA requirement is invalid',
    );
  }
}

function intersectPrimaryMethods(
  configured: Array<ReadonlySet<MfaPrimaryMethod> | undefined>,
): Set<MfaPrimaryMethod> {
  const explicit = configured.filter(
    (methods): methods is ReadonlySet<MfaPrimaryMethod> => methods !== undefined,
  );
  if (explicit.length === 0) return new Set(MFA_PRIMARY_METHODS);

  const result = new Set(explicit[0]);
  for (const methods of explicit.slice(1)) {
    for (const method of result) {
      if (!methods.has(method)) result.delete(method);
    }
  }
  if (result.size === 0) {
    throw new MfaPolicyConfigurationError(
      'MFA allowed methods have no primary factor in common',
    );
  }
  return result;
}

function readAllowedMethods(settings: unknown): ReadonlySet<MfaPrimaryMethod> | undefined {
  try {
    return getExplicitMfaAllowedMethods(settings);
  } catch (error) {
    throw new MfaPolicyConfigurationError(
      error instanceof Error ? error.message : 'Stored MFA allowed methods are invalid',
    );
  }
}

async function resolveWithTx(
  tx: AuthLifecycleTransaction,
  input: ResolveEffectiveMfaPolicyInput,
): Promise<EffectiveMfaPolicy> {
  let roleForceMfa = false;
  let partnerSettings: unknown;
  let organizationSettings: unknown;

  if (input.scope === 'system') {
    const [row] = input.roleId
      ? await tx
        .select({
          userId: users.id,
          userStatus: users.status,
          isPlatformAdmin: users.isPlatformAdmin,
          roleId: roles.id,
          rolePartnerId: roles.partnerId,
          roleOrgId: roles.orgId,
          roleScope: roles.scope,
          roleForceMfa: roles.forceMfa,
        })
        .from(users)
        .innerJoin(roles, eq(roles.id, input.roleId))
        .where(and(
          eq(users.id, input.userId),
          eq(users.status, 'active'),
        ))
        .limit(1)
      : await tx
        .select({
          userId: users.id,
          userStatus: users.status,
          isPlatformAdmin: users.isPlatformAdmin,
        })
        .from(users)
        .where(and(eq(users.id, input.userId), eq(users.status, 'active')))
        .limit(1);
    if (!row || row.userId !== input.userId || row.userStatus !== 'active') {
      throw new MfaPolicyResolutionError('User is missing or inactive');
    }
    if (row.isPlatformAdmin !== true) {
      throw new MfaPolicyResolutionError('System user is not a current platform administrator');
    }
    if (input.roleId) {
      const roleRow = row as typeof row & {
        roleId: string;
        rolePartnerId: string | null;
        roleOrgId: string | null;
        roleScope: string;
        roleForceMfa: boolean;
      };
      if (roleRow.roleId !== input.roleId
        || roleRow.roleScope !== 'system'
        || roleRow.rolePartnerId !== null
        || roleRow.roleOrgId !== null) {
        throw new MfaPolicyResolutionError('System role is missing or mismatched');
      }
      roleForceMfa = roleRow.roleForceMfa === true;
    }
  } else if (input.scope === 'partner') {
    const [row] = await tx
      .select({
        userId: users.id,
        userPartnerId: users.partnerId,
        userStatus: users.status,
        partnerId: partners.id,
        partnerStatus: partners.status,
        partnerDeletedAt: partners.deletedAt,
        partnerSettings: partners.settings,
        membershipUserId: partnerUsers.userId,
        membershipPartnerId: partnerUsers.partnerId,
        membershipRoleId: partnerUsers.roleId,
        roleId: roles.id,
        rolePartnerId: roles.partnerId,
        roleOrgId: roles.orgId,
        roleScope: roles.scope,
        roleIsSystem: roles.isSystem,
        roleForceMfa: roles.forceMfa,
      })
      .from(partnerUsers)
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .innerJoin(partners, eq(partners.id, partnerUsers.partnerId))
      .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
      .where(and(
        eq(partnerUsers.userId, input.userId),
        eq(partnerUsers.partnerId, input.partnerId!),
        eq(partnerUsers.roleId, input.roleId!),
        eq(users.status, 'active'),
        eq(partners.id, input.partnerId!),
        eq(partners.status, 'active'),
        isNull(partners.deletedAt),
      ))
      .limit(1);
    const customRole = row?.roleIsSystem !== true
      && row?.rolePartnerId === input.partnerId
      && row?.roleOrgId === null;
    const globalSeededRole = row?.roleIsSystem === true
      && row?.rolePartnerId === null
      && row?.roleOrgId === null;
    if (!row
      || row.userId !== input.userId
      || row.userPartnerId !== input.partnerId
      || row.userStatus !== 'active'
      || row.partnerId !== input.partnerId
      || row.partnerStatus !== 'active'
      || row.partnerDeletedAt !== null
      || row.membershipUserId !== input.userId
      || row.membershipPartnerId !== input.partnerId
      || row.membershipRoleId !== input.roleId
      || row.roleId !== input.roleId
      || row.roleScope !== 'partner'
      || (!customRole && !globalSeededRole)) {
      throw new MfaPolicyResolutionError('Partner policy axes are missing or mismatched');
    }
    roleForceMfa = row.roleForceMfa === true;
    partnerSettings = row.partnerSettings;
  } else {
    const [row] = await tx
      .select({
        userId: users.id,
        userPartnerId: users.partnerId,
        userStatus: users.status,
        partnerId: partners.id,
        partnerStatus: partners.status,
        partnerDeletedAt: partners.deletedAt,
        partnerSettings: partners.settings,
        organizationId: organizations.id,
        organizationPartnerId: organizations.partnerId,
        organizationStatus: organizations.status,
        organizationDeletedAt: organizations.deletedAt,
        organizationSettings: organizations.settings,
        membershipUserId: organizationUsers.userId,
        membershipOrgId: organizationUsers.orgId,
        membershipRoleId: organizationUsers.roleId,
        roleId: roles.id,
        rolePartnerId: roles.partnerId,
        roleOrgId: roles.orgId,
        roleScope: roles.scope,
        roleIsSystem: roles.isSystem,
        roleForceMfa: roles.forceMfa,
      })
      .from(organizationUsers)
      .innerJoin(users, eq(users.id, organizationUsers.userId))
      .innerJoin(organizations, eq(organizations.id, organizationUsers.orgId))
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .innerJoin(roles, eq(roles.id, organizationUsers.roleId))
      .where(and(
        eq(organizationUsers.userId, input.userId),
        eq(organizationUsers.orgId, input.orgId!),
        eq(organizationUsers.roleId, input.roleId!),
        eq(users.status, 'active'),
        eq(organizations.partnerId, input.partnerId!),
        isNull(organizations.deletedAt),
        eq(partners.status, 'active'),
        isNull(partners.deletedAt),
      ))
      .limit(1);
    const customRole = row?.roleIsSystem !== true
      && row?.roleOrgId === input.orgId
      && (row?.rolePartnerId === null || row?.rolePartnerId === input.partnerId);
    const globalSeededRole = row?.roleIsSystem === true
      && row?.rolePartnerId === null
      && row?.roleOrgId === null;
    if (!row
      || row.userId !== input.userId
      || row.userPartnerId !== input.partnerId
      || row.userStatus !== 'active'
      || row.partnerId !== input.partnerId
      || row.partnerStatus !== 'active'
      || row.partnerDeletedAt !== null
      || row.organizationId !== input.orgId
      || row.organizationPartnerId !== input.partnerId
      || !['active', 'trial'].includes(row.organizationStatus)
      || row.organizationDeletedAt !== null
      || row.membershipUserId !== input.userId
      || row.membershipOrgId !== input.orgId
      || row.membershipRoleId !== input.roleId
      || row.roleId !== input.roleId
      || row.roleScope !== 'organization'
      || (!customRole && !globalSeededRole)) {
      throw new MfaPolicyResolutionError('Organization policy axes are missing or mismatched');
    }
    roleForceMfa = row.roleForceMfa === true;
    partnerSettings = row.partnerSettings;
    organizationSettings = row.organizationSettings;
  }

  try {
    const sources: EffectiveMfaPolicy['sources'] = [];
    if (roleForceMfa) sources.push('role');
    if (requireMfaFromSettings(partnerSettings)) sources.push('partner');
    if (requireMfaFromSettings(organizationSettings)) sources.push('organization');

    const primaryMethods = intersectPrimaryMethods([
      readAllowedMethods(partnerSettings),
      readAllowedMethods(organizationSettings),
    ]);
    const allowedMethods = new Set<MfaMethod>(primaryMethods);
    // Recovery codes are account-recovery credentials. Primary-factor policy
    // never silently disables a valid stored recovery code.
    allowedMethods.add('recovery_code');
    return { required: sources.length > 0, allowedMethods, sources };
  } catch (error) {
    if (error instanceof MfaPolicyResolutionError) throw error;
    throw new MfaPolicyResolutionError(
      error instanceof Error ? error.message : 'MFA policy is invalid',
    );
  }
}

export async function resolveEffectiveMfaPolicy(
  input: ResolveEffectiveMfaPolicyInput,
): Promise<EffectiveMfaPolicy> {
  assertScopeAxes(input);
  if (input.tx) return resolveWithTx(input.tx, input);

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      resolveWithTx(db as unknown as AuthLifecycleTransaction, input)
    )
  );
}

function assertCompatible(
  first: ReadonlySet<MfaPrimaryMethod> | undefined,
  second: ReadonlySet<MfaPrimaryMethod> | undefined,
): void {
  intersectPrimaryMethods([first, second]);
}

export function withMfaPolicySystemTransaction<T>(
  fn: (tx: AuthLifecycleTransaction) => Promise<T>,
): Promise<T> {
  return runOutsideDbContext(() =>
    withSystemDbAccessTransaction(fn)
  );
}

export async function lockMfaPolicyPartner(
  tx: AuthLifecycleTransaction,
  partnerId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('mfa-policy'), hashtext(${partnerId}))`,
  );
}

export async function authorizePartnerMfaPolicyWrite(
  tx: AuthLifecycleTransaction,
  input: { userId: string; partnerId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({
      membershipUserId: partnerUsers.userId,
      membershipPartnerId: partnerUsers.partnerId,
      userId: users.id,
      userPartnerId: users.partnerId,
      userStatus: users.status,
      partnerId: partners.id,
      partnerStatus: partners.status,
      partnerDeletedAt: partners.deletedAt,
    })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .innerJoin(partners, eq(partners.id, partnerUsers.partnerId))
    .where(and(
      eq(partnerUsers.userId, input.userId),
      eq(partnerUsers.partnerId, input.partnerId),
      eq(users.partnerId, input.partnerId),
      eq(users.status, 'active'),
      eq(partners.status, 'active'),
      isNull(partners.deletedAt),
    ))
    .limit(1);
  return row?.membershipUserId === input.userId
    && row.membershipPartnerId === input.partnerId
    && row.userId === input.userId
    && row.userPartnerId === input.partnerId
    && row.userStatus === 'active'
    && row.partnerId === input.partnerId
    && row.partnerStatus === 'active'
    && row.partnerDeletedAt === null;
}

export async function validateOrganizationMfaPolicySettingsWrite(input: {
  tx: AuthLifecycleTransaction;
  orgId?: string;
  partnerId: string;
  settings: unknown;
}): Promise<void> {
  if (!hasMfaPolicyInput(input.settings)) return;
  await lockMfaPolicyPartner(input.tx, input.partnerId);
  if (!hasMfaAllowedMethodsInput(input.settings)) return;
  const incoming = readAllowedMethods(input.settings);
  const [partner] = await input.tx
    .select({ id: partners.id, settings: partners.settings })
    .from(partners)
    .where(and(eq(partners.id, input.partnerId), isNull(partners.deletedAt)))
    .limit(1);
  if (!partner || partner.id !== input.partnerId) {
    throw new MfaPolicyConfigurationError('Partner not found for MFA policy write');
  }
  assertCompatible(incoming, readAllowedMethods(partner.settings));
}

export async function validatePartnerMfaPolicySettingsWrite(input: {
  tx: AuthLifecycleTransaction;
  partnerId: string;
  settings: unknown;
}): Promise<void> {
  if (!hasMfaPolicyInput(input.settings)) return;
  await lockMfaPolicyPartner(input.tx, input.partnerId);
  if (!hasMfaAllowedMethodsInput(input.settings)) return;
  const incoming = readAllowedMethods(input.settings);
  const orgRows = await input.tx
    .select({ id: organizations.id, settings: organizations.settings })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, input.partnerId),
      isNull(organizations.deletedAt),
    ));
  for (const organization of orgRows) {
    assertCompatible(incoming, readAllowedMethods(organization.settings));
  }
}
