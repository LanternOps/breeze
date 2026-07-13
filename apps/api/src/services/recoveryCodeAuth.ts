import { eq } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'crypto';
import { users } from '../db/schema';
import {
  invalidateUserMfaAssurance,
  revokeUserSessionFamily,
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import {
  consumePendingMfa,
  readPendingMfa,
  beginPendingMfaIssuance,
  pendingMfaRecordsEqual,
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  selectEffectiveMfaMethod,
  type PendingMfaSessionV2,
} from './mfaAssurance';
import { lockMfaAssuranceState } from './mfaAssuranceLocks';
import { resolveEffectiveMfaPolicy } from './mfaPolicy';
import { bindIssuedUserSession, issueUserSession } from './userSession';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  cancelAuthIssuance,
  finishAuthIssuance,
  type AuthBindingSource,
} from './authBrowserTransition';

const MFA_METHOD_ORDER = ['totp', 'sms', 'passkey', 'recovery_code'] as const;
const MFA_POLICY_SOURCE_ORDER = ['role', 'partner', 'organization'] as const;

export class RecoveryCodeInvalidError extends Error {
  constructor(readonly userId?: string) {
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

function isAuthBrowserTransitionError(error: unknown): boolean {
  return error instanceof AuthBindingRotationRequiredError
    || error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError;
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
  const matchingHash = Buffer.from(hashRecoveryCode(normalized), 'hex');
  let matchIndex = -1;
  for (let index = 0; index < storedCodes.length; index += 1) {
    const stored = storedCodes[index] ?? '';
    const validHash = /^[a-f0-9]{64}$/i.test(stored);
    const storedHash = validHash ? Buffer.from(stored, 'hex') : Buffer.alloc(matchingHash.length);
    const matches = storedHash.length === matchingHash.length
      && timingSafeEqual(storedHash, matchingHash);
    if (matches && matchIndex === -1) matchIndex = index;
  }
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
  authBinding: AuthBindingSource;
  mobileDeviceId?: string;
}) {
  let pending: PendingMfaSessionV2 | null;
  try {
    pending = await readPendingMfa(input.tempToken);
  } catch (error) {
    if (error instanceof PendingMfaUnavailableError) throw new RecoveryCodeUnavailableError();
    throw error;
  }
  if (!pending) throw new RecoveryCodeInvalidError();

  let capability;
  try {
    capability = await beginPendingMfaIssuance(pending, input.authBinding);
  } catch (error) {
    if (error instanceof PendingMfaInvalidError) {
      throw new RecoveryCodeInvalidError(pending.userId);
    }
    if (isAuthBrowserTransitionError(error)) throw error;
    throw new RecoveryCodeUnavailableError();
  }

  let consumedPending: PendingMfaSessionV2 | null;
  try {
    consumedPending = await consumePendingMfa(input.tempToken);
  } catch (error) {
    await cancelAuthIssuance(capability).catch(() => false);
    if (error instanceof PendingMfaUnavailableError) throw new RecoveryCodeUnavailableError();
    throw error;
  }
  if (!consumedPending || !pendingMfaRecordsEqual(consumedPending, pending)) {
    await cancelAuthIssuance(capability).catch(() => false);
    throw new RecoveryCodeInvalidError(pending.userId);
  }

  let result;
  try {
    result = await finishAuthIssuance(capability, async (tx) => {
      await validatePendingRecoveryAuthority(tx, pending!);
      const consumed = await consumeRecoveryCode(pending!.userId, input.code, tx);
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
      }, { tx, capability });
      await tx
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));
      return {
        user,
        tokens,
        ...consumed,
        authority: {
          roleId: pending!.roleId,
          orgId: pending!.orgId,
          partnerId: pending!.partnerId,
          scope: pending!.scope,
        },
      };
    });
  } catch (error) {
    await cancelAuthIssuance(capability).catch(() => false);
    if (error instanceof RecoveryCodeInvalidError || error instanceof PendingMfaInvalidError) {
      throw new RecoveryCodeInvalidError(pending.userId);
    }
    if (isAuthBrowserTransitionError(error)) throw error;
    throw new RecoveryCodeUnavailableError();
  }
  try {
    await bindIssuedUserSession(result.tokens);
  } catch {
    try {
      await withAuthLifecycleSystemTransaction((tx) => revokeUserSessionFamily(
        tx,
        pending.userId,
        result.tokens.familyId,
        'mfa-recovery-bind-failed',
      ));
    } catch {
      // Preserve the fail-closed response even if compensating family
      // revocation itself is unavailable. The family remains user-owned and
      // absolute-expiry bounded; no token was returned to the caller.
      console.error(
        '[recovery-code-auth] compensation failed',
        { event: 'recovery_bind_compensation_failed' },
      );
    }
    throw new RecoveryCodeUnavailableError();
  }
  return result;
}

/** Burn pending state for a recovery payload rejected by schema validation. */
export async function rejectMalformedRecoveryCodeLogin(tempToken: string | undefined) {
  if (!tempToken) return { userId: undefined };
  try {
    const pending = await consumePendingMfa(tempToken);
    return { userId: pending?.userId };
  } catch (error) {
    if (error instanceof PendingMfaUnavailableError) throw new RecoveryCodeUnavailableError();
    throw error;
  }
}
