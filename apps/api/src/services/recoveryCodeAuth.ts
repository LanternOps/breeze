import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { users } from '../db/schema';
import {
  invalidateUserMfaAssurance,
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import {
  consumePendingMfa,
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  selectEffectiveMfaMethod,
  type PendingMfaSessionV2,
} from './mfaAssurance';
import { lockMfaAssuranceState } from './mfaAssuranceLocks';
import { resolveEffectiveMfaPolicy } from './mfaPolicy';
import { bindIssuedUserSession, issueUserSession } from './userSession';

const MFA_METHOD_ORDER = ['totp', 'sms', 'passkey', 'recovery_code'] as const;
const MFA_POLICY_SOURCE_ORDER = ['role', 'partner', 'organization'] as const;

export class RecoveryCodeInvalidError extends Error {
  constructor() {
    super('Invalid MFA code');
    this.name = 'RecoveryCodeInvalidError';
  }
}

export class RecoveryCodeUnavailableError extends Error {
  constructor() {
    super('MFA verification unavailable');
    this.name = 'RecoveryCodeUnavailableError';
  }
}

export function normalizeRecoveryCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
    throw new RecoveryCodeInvalidError();
  }
  return normalized;
}

export function getRecoveryCodePepper(): string {
  const pepper = process.env.MFA_RECOVERY_CODE_PEPPER?.trim();
  if (pepper) return pepper;
  if (process.env.NODE_ENV === 'test') return 'test-mfa-recovery-code-pepper';
  throw new Error('No MFA recovery code pepper configured. Set MFA_RECOVERY_CODE_PEPPER.');
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  return createHash('sha256')
    .update(`${getRecoveryCodePepper()}:${normalized}`)
    .digest('hex');
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map(hashRecoveryCode);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

/**
 * Consume one recovery hash under the mandatory assurance lock order. The
 * caller owns the system-scoped transaction, making hash removal, epoch
 * advancement, and family revocation one rollback boundary.
 */
export async function consumeRecoveryCode(
  userId: string,
  code: string,
  tx: AuthLifecycleTransaction,
) {
  const normalized = normalizeRecoveryCode(code);
  const [axis] = await tx
    .select({ partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!axis) throw new RecoveryCodeInvalidError();

  const locked = await lockMfaAssuranceState(tx, { userId, partnerId: axis.partnerId });
  const user = locked.user;
  const storedCodes = stringArray(user?.mfaRecoveryCodes);
  if (!user || user.id !== userId || user.partnerId !== axis.partnerId
    || user.status !== 'active' || !storedCodes) {
    throw new RecoveryCodeInvalidError();
  }
  const matchingHash = hashRecoveryCode(normalized);
  const matchIndex = storedCodes.findIndex((stored) => stored === matchingHash);
  if (matchIndex < 0) throw new RecoveryCodeInvalidError();

  const remainingCodes = storedCodes.slice();
  remainingCodes.splice(matchIndex, 1);
  const updated = await tx
    .update(users)
    .set({ mfaRecoveryCodes: remainingCodes, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (updated.length !== 1) throw new Error('Failed to consume recovery code');

  const invalidation = await invalidateUserMfaAssurance(
    tx,
    userId,
    'mfa-recovery-code-used',
  );
  return {
    remainingCount: remainingCodes.length,
    authEpoch: invalidation.securityState.authEpoch,
    mfaEpoch: invalidation.securityState.mfaEpoch,
    revokedFamilyCount: invalidation.revokedFamilyCount,
  };
}

function canonical<T extends string>(values: Iterable<T>, order: readonly T[]): T[] {
  const valueSet = new Set(values);
  return order.filter((value) => valueSet.has(value));
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function currentEnrolledMethods(user: NonNullable<Awaited<ReturnType<typeof lockMfaAssuranceState>>['user']>, activePasskeys: number) {
  const methods = new Set<'totp' | 'sms' | 'passkey' | 'recovery_code'>();
  if (typeof user.mfaSecret === 'string' && user.mfaSecret.length > 0) methods.add('totp');
  if (user.mfaMethod === 'sms' && user.phoneVerified && user.phoneNumber) methods.add('sms');
  if (activePasskeys > 0) methods.add('passkey');
  const recoveryCodes = stringArray(user.mfaRecoveryCodes);
  if (recoveryCodes && recoveryCodes.length > 0) methods.add('recovery_code');
  return methods;
}

async function validatePendingRecoveryAuthority(
  tx: AuthLifecycleTransaction,
  pending: PendingMfaSessionV2,
) {
  const locked = await lockMfaAssuranceState(tx, {
    userId: pending.userId,
    partnerId: pending.partnerId,
  });
  const user = locked.user;
  if (!user || user.id !== pending.userId || user.status !== pending.expectedStatus
    || user.authEpoch !== pending.authEpoch || user.mfaEpoch !== pending.mfaEpoch
    || pending.primaryAuthenticationMethod !== 'password') {
    throw new RecoveryCodeInvalidError();
  }
  const policy = await resolveEffectiveMfaPolicy({
    userId: pending.userId,
    roleId: pending.roleId,
    orgId: pending.orgId,
    partnerId: pending.partnerId,
    scope: pending.scope,
    tx,
  });
  const enrolled = currentEnrolledMethods(user, locked.activePasskeyCount);
  const configured = user.mfaMethod === 'totp' || user.mfaMethod === 'sms' || user.mfaMethod === 'passkey'
    ? user.mfaMethod
    : null;
  const primary = selectEffectiveMfaMethod({
    configuredMfaMethod: configured,
    enrolledMethods: enrolled,
    allowedMethods: policy.allowedMethods,
  });
  if (!pending.allowedMethods.includes('recovery_code')
    || !pending.enrolledMethods.includes('recovery_code')
    || !policy.allowedMethods.has('recovery_code')
    || !enrolled.has('recovery_code')
    || policy.required !== pending.policyRequired
    || !arraysEqual(canonical(policy.sources, MFA_POLICY_SOURCE_ORDER), pending.policySources)
    || !arraysEqual(canonical(policy.allowedMethods, MFA_METHOD_ORDER), pending.allowedMethods)
    || !arraysEqual(canonical(enrolled, MFA_METHOD_ORDER), pending.enrolledMethods)
    || configured !== pending.configuredMfaMethod
    || primary !== pending.primaryMfaMethod) {
    throw new RecoveryCodeInvalidError();
  }
  return user;
}

export async function completeRecoveryCodeLogin(input: {
  tempToken: string;
  code: string;
  mobileDeviceId?: string;
}) {
  let pending: PendingMfaSessionV2 | null;
  try {
    pending = await consumePendingMfa(input.tempToken);
  } catch (error) {
    if (error instanceof PendingMfaUnavailableError) throw new RecoveryCodeUnavailableError();
    throw error;
  }
  if (!pending) throw new RecoveryCodeInvalidError();

  let consumed;
  try {
    consumed = await withAuthLifecycleSystemTransaction(async (tx) => {
      await validatePendingRecoveryAuthority(tx, pending!);
      return consumeRecoveryCode(pending!.userId, input.code, tx);
    });
  } catch (error) {
    if (error instanceof RecoveryCodeInvalidError) throw error;
    if (error instanceof PendingMfaInvalidError) throw new RecoveryCodeInvalidError();
    throw new RecoveryCodeUnavailableError();
  }

  let issued;
  try {
    issued = await withAuthLifecycleSystemTransaction(async (tx) => {
      const locked = await lockMfaAssuranceState(tx, {
        userId: pending!.userId,
        partnerId: pending!.partnerId,
      });
      const user = locked.user;
      if (!user || user.status !== 'active'
        || user.authEpoch !== consumed.authEpoch || user.mfaEpoch !== consumed.mfaEpoch) {
        throw new RecoveryCodeInvalidError();
      }
      const policy = await resolveEffectiveMfaPolicy({
        userId: pending!.userId,
        roleId: pending!.roleId,
        orgId: pending!.orgId,
        partnerId: pending!.partnerId,
        scope: pending!.scope,
        tx,
      });
      if (!policy.allowedMethods.has('recovery_code')) throw new RecoveryCodeInvalidError();
      const tokens = await issueUserSession({
        userId: user.id,
        email: user.email,
        roleId: pending!.roleId,
        orgId: pending!.orgId,
        partnerId: pending!.partnerId,
        scope: pending!.scope,
        mfa: true,
        amr: ['password', 'recovery_code'],
        mobileDeviceId: input.mobileDeviceId,
      }, { tx });
      return {
        user,
        tokens,
        authority: {
          roleId: pending!.roleId,
          orgId: pending!.orgId,
          partnerId: pending!.partnerId,
          scope: pending!.scope,
        },
      };
    });
  } catch (error) {
    if (error instanceof RecoveryCodeInvalidError) throw error;
    throw new RecoveryCodeUnavailableError();
  }
  await bindIssuedUserSession(issued.tokens);
  return { ...issued, ...consumed };
}
