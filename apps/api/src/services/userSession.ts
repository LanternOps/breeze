import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema/users';
import type { Tx as AuthLifecycleTransaction } from './authLifecycle';
import {
  assertAuthIssuanceCapability,
  AuthIssuanceCapabilityError,
  bindAuthIssuanceSession,
  type AuthIssuanceCapability,
} from './authBrowserTransition';
import { createTokenPair } from './jwt';
import {
  bindRefreshJtiToFamily,
  mintRefreshTokenFamily,
  RefreshTokenCurrentnessError,
  rotateRefreshTokenFamilyCurrentJti,
} from './refreshTokenFamily';

const AUTHORIZED_USER_SESSION: unique symbol = Symbol('AuthorizedUserSession');

export type UserSessionIdentity = Readonly<{
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  mfa: boolean;
  mobileDeviceId?: string;
}>;

type TokenPair = Awaited<ReturnType<typeof createTokenPair>>;

export type AuthorizedUserSession = Readonly<TokenPair & {
  familyId: string;
  transitionId: string;
  generation: number;
  readonly [AUTHORIZED_USER_SESSION]: true;
}>;

export type UserSessionEpochSnapshot = Readonly<{
  authEpoch: number;
  mfaEpoch: number;
}>;

export type GuardedUserSessionIssueOptions = Readonly<{
  tx: AuthLifecycleTransaction;
  capability: AuthIssuanceCapability;
  expectedEpochs: UserSessionEpochSnapshot;
  familyId?: string;
  refreshRotation?: Readonly<{
    presentedJti: string;
  }>;
}>;

export class UserSessionEpochMismatchError extends AuthIssuanceCapabilityError {
  constructor() {
    super();
    this.name = 'UserSessionEpochMismatchError';
    this.message = 'Verified authentication state changed before session issuance';
  }
}

async function lockLiveUserSecurityState(
  tx: AuthLifecycleTransaction,
  userId: string,
): Promise<{ authEpoch: number; mfaEpoch: number }> {
  const [user] = await tx
    .select({
      status: users.status,
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
    .limit(1);
  if (!user || user.status !== 'active') {
    throw new Error('Cannot issue session for inactive or missing user');
  }
  return { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch };
}

/** Sole authority issuer for transition-guarded user sessions. */
export async function issueUserSession(
  identity: UserSessionIdentity,
  options: GuardedUserSessionIssueOptions,
): Promise<AuthorizedUserSession> {
  if (!options?.tx || !options.capability || !options.expectedEpochs) {
    throw new Error('Guarded user-session issuance requires a transaction, capability, and expected epochs');
  }

  await assertAuthIssuanceCapability(options.tx, options.capability);

  // Global lock order: transition (asserted above), user, then refresh family.
  const epochs = await lockLiveUserSecurityState(options.tx, identity.userId);
  if (
    epochs.authEpoch !== options.expectedEpochs.authEpoch
    || epochs.mfaEpoch !== options.expectedEpochs.mfaEpoch
  ) {
    if (options.refreshRotation) throw new RefreshTokenCurrentnessError();
    throw new UserSessionEpochMismatchError();
  }

  const refreshJti = randomUUID();
  let familyId: string;
  if (options.familyId !== undefined) {
    if (!options.refreshRotation) throw new RefreshTokenCurrentnessError();
    await rotateRefreshTokenFamilyCurrentJti(options.tx, {
      familyId: options.familyId,
      userId: identity.userId,
      presentedJti: options.refreshRotation.presentedJti,
      successorJti: refreshJti,
    });
    familyId = options.familyId;
  } else {
    familyId = await mintRefreshTokenFamily(identity.userId, refreshJti, {
      tx: options.tx,
      mobileDeviceId: identity.mobileDeviceId,
    });
  }

  const tokens = await createTokenPair({
    sub: identity.userId,
    email: identity.email,
    roleId: identity.roleId,
    orgId: identity.orgId,
    partnerId: identity.partnerId,
    scope: identity.scope,
    mfa: identity.mfa,
    aep: epochs.authEpoch,
    mep: epochs.mfaEpoch,
    mdid: identity.mobileDeviceId,
  }, { refreshFam: familyId, refreshJti });

  await bindAuthIssuanceSession(
    options.tx,
    options.capability,
    identity.userId,
    familyId,
  );

  return Object.freeze({
    ...tokens,
    familyId,
    transitionId: options.capability.transitionId,
    generation: options.capability.generation,
    [AUTHORIZED_USER_SESSION]: true as const,
  });
}

/** Populate the Redis JTI accelerator only after the authoritative commit. */
export async function bindIssuedUserSession(
  session: Pick<AuthorizedUserSession, 'refreshJti' | 'familyId'>,
): Promise<void> {
  await bindRefreshJtiToFamily(session.refreshJti, session.familyId);
}
