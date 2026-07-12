import { and, eq, isNull } from 'drizzle-orm';
import {
  getExplicitMfaAllowedMethods,
  hasMfaAllowedMethodsInput,
  MFA_PRIMARY_METHODS,
  type MfaMethod,
  type MfaPrimaryMethod,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  organizationUsers,
  organizations,
  partners,
  partnerUsers,
  roles,
  users,
} from '../db/schema';
import type { AuthLifecycleTransaction } from './authLifecycle';

export type { MfaMethod } from '@breeze/shared';

export type MfaPolicyScope = 'system' | 'partner' | 'organization';

export interface EffectiveMfaPolicy {
  required: boolean;
  allowedMethods: ReadonlySet<MfaMethod>;
  sources: Array<'role' | 'partner' | 'organization'>;
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
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const security = (settings as Record<string, unknown>).security;
  if (security === null || typeof security !== 'object' || Array.isArray(security)) return false;
  const securityRecord = security as Record<string, unknown>;
  if (!Object.hasOwn(securityRecord, 'requireMfa')) return false;
  if (typeof securityRecord.requireMfa !== 'boolean') {
    throw new MfaPolicyConfigurationError('Stored MFA requirement is invalid');
  }
  return securityRecord.requireMfa;
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
  const [user] = await tx
    .select({
      id: users.id,
      partnerId: users.partnerId,
      orgId: users.orgId,
      status: users.status,
      isPlatformAdmin: users.isPlatformAdmin,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!user || user.id !== input.userId || user.status !== 'active') {
    throw new MfaPolicyResolutionError('User is missing or inactive');
  }

  let roleForceMfa = false;
  let partnerSettings: unknown;
  let organizationSettings: unknown;

  if (input.scope === 'system') {
    if (user.isPlatformAdmin !== true) {
      throw new MfaPolicyResolutionError('System user is not a current platform administrator');
    }
    if (input.roleId) {
      const [role] = await tx
        .select({
          id: roles.id,
          partnerId: roles.partnerId,
          orgId: roles.orgId,
          scope: roles.scope,
          forceMfa: roles.forceMfa,
        })
        .from(roles)
        .where(and(
          eq(roles.id, input.roleId),
          eq(roles.scope, 'system'),
          isNull(roles.partnerId),
          isNull(roles.orgId),
        ))
        .limit(1);
      if (!role
        || role.id !== input.roleId
        || role.scope !== 'system'
        || role.partnerId !== null
        || role.orgId !== null) {
        throw new MfaPolicyResolutionError('System role is missing or mismatched');
      }
      roleForceMfa = role.forceMfa === true;
    }
  } else {
    if (user.partnerId !== input.partnerId) {
      throw new MfaPolicyResolutionError('User partner axis does not match');
    }

    const [partner] = await tx
      .select({
        id: partners.id,
        status: partners.status,
        deletedAt: partners.deletedAt,
        settings: partners.settings,
      })
      .from(partners)
      .where(and(
        eq(partners.id, input.partnerId!),
        eq(partners.status, 'active'),
        isNull(partners.deletedAt),
      ))
      .limit(1);
    if (!partner
      || partner.id !== input.partnerId
      || partner.status !== 'active'
      || partner.deletedAt !== null) {
      throw new MfaPolicyResolutionError('Partner is missing or inactive');
    }
    partnerSettings = partner.settings;

    if (input.scope === 'partner') {
      const [membership] = await tx
        .select({
          userId: partnerUsers.userId,
          partnerId: partnerUsers.partnerId,
          roleId: partnerUsers.roleId,
        })
        .from(partnerUsers)
        .where(and(
          eq(partnerUsers.userId, input.userId),
          eq(partnerUsers.partnerId, input.partnerId!),
          eq(partnerUsers.roleId, input.roleId!),
        ))
        .limit(1);
      if (!membership
        || membership.userId !== input.userId
        || membership.partnerId !== input.partnerId
        || membership.roleId !== input.roleId) {
        throw new MfaPolicyResolutionError('Partner membership is missing or mismatched');
      }

      const [role] = await tx
        .select({
          id: roles.id,
          partnerId: roles.partnerId,
          orgId: roles.orgId,
          scope: roles.scope,
          forceMfa: roles.forceMfa,
        })
        .from(roles)
        .where(and(
          eq(roles.id, input.roleId!),
          eq(roles.scope, 'partner'),
          eq(roles.partnerId, input.partnerId!),
          isNull(roles.orgId),
        ))
        .limit(1);
      if (!role
        || role.id !== input.roleId
        || role.scope !== 'partner'
        || role.partnerId !== input.partnerId
        || role.orgId !== null) {
        throw new MfaPolicyResolutionError('Partner role is missing or mismatched');
      }
      roleForceMfa = role.forceMfa === true;
    } else {
      const [organization] = await tx
        .select({
          id: organizations.id,
          partnerId: organizations.partnerId,
          status: organizations.status,
          deletedAt: organizations.deletedAt,
          settings: organizations.settings,
        })
        .from(organizations)
        .where(and(
          eq(organizations.id, input.orgId!),
          eq(organizations.partnerId, input.partnerId!),
          isNull(organizations.deletedAt),
        ))
        .limit(1);
      if (!organization
        || organization.id !== input.orgId
        || organization.partnerId !== input.partnerId
        || !['active', 'trial'].includes(organization.status)
        || organization.deletedAt !== null) {
        throw new MfaPolicyResolutionError('Organization is missing or inactive');
      }
      organizationSettings = organization.settings;

      const [membership] = await tx
        .select({
          userId: organizationUsers.userId,
          orgId: organizationUsers.orgId,
          roleId: organizationUsers.roleId,
        })
        .from(organizationUsers)
        .where(and(
          eq(organizationUsers.userId, input.userId),
          eq(organizationUsers.orgId, input.orgId!),
          eq(organizationUsers.roleId, input.roleId!),
        ))
        .limit(1);
      if (!membership
        || membership.userId !== input.userId
        || membership.orgId !== input.orgId
        || membership.roleId !== input.roleId) {
        throw new MfaPolicyResolutionError('Organization membership is missing or mismatched');
      }

      const [role] = await tx
        .select({
          id: roles.id,
          partnerId: roles.partnerId,
          orgId: roles.orgId,
          scope: roles.scope,
          forceMfa: roles.forceMfa,
        })
        .from(roles)
        .where(and(
          eq(roles.id, input.roleId!),
          eq(roles.scope, 'organization'),
          eq(roles.orgId, input.orgId!),
        ))
        .limit(1);
      if (!role
        || role.id !== input.roleId
        || role.scope !== 'organization'
        || role.orgId !== input.orgId
        || (role.partnerId !== null && role.partnerId !== input.partnerId)) {
        throw new MfaPolicyResolutionError('Organization role is missing or mismatched');
      }
      roleForceMfa = role.forceMfa === true;
    }
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

export async function validateOrganizationMfaPolicySettingsWrite(input: {
  tx: AuthLifecycleTransaction;
  orgId?: string;
  partnerId?: string;
  settings: unknown;
}): Promise<void> {
  if (!hasMfaAllowedMethodsInput(input.settings)) return;
  const incoming = readAllowedMethods(input.settings);
  let partnerId = input.partnerId;
  if (!partnerId) {
    if (!input.orgId) {
      throw new MfaPolicyConfigurationError('Organization or partner axis is required');
    }
    const [organization] = await input.tx
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .limit(1);
    if (!organization || organization.id !== input.orgId) {
      throw new MfaPolicyConfigurationError('Organization not found for MFA policy write');
    }
    partnerId = organization.partnerId;
  }
  const [partner] = await input.tx
    .select({ id: partners.id, settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  if (!partner || partner.id !== partnerId) {
    throw new MfaPolicyConfigurationError('Partner not found for MFA policy write');
  }
  assertCompatible(incoming, readAllowedMethods(partner.settings));
}

export async function validatePartnerMfaPolicySettingsWrite(input: {
  tx: AuthLifecycleTransaction;
  partnerId: string;
  settings: unknown;
}): Promise<void> {
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
