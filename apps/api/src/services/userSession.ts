import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { envFlag } from '../config/env';
import { users } from '../db/schema/users';
import type { Tx as AuthLifecycleTransaction } from './authLifecycle';
import {
  assertAuthIssuanceCapability,
  bindAuthIssuanceSession,
  type AuthIssuanceCapability,
} from './authBrowserTransition';
import { getUserEpochs } from './authEpochs';
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
  /** Temporary rollout-only family carry-forward used by legacy /refresh. */
  legacyFamilyId?: string;
}>;

type TokenPair = Awaited<ReturnType<typeof createTokenPair>>;

export type AuthorizedUserSession = Readonly<TokenPair & {
  familyId: string;
  transitionId: string;
  generation: number;
  readonly [AUTHORIZED_USER_SESSION]: true;
}>;

export type GuardedUserSessionIssueOptions = Readonly<{
  tx: AuthLifecycleTransaction;
  capability: AuthIssuanceCapability;
  familyId?: string;
  refreshRotation?: Readonly<{
    presentedJti: string;
    authEpoch: number;
    mfaEpoch: number;
  }>;
}>;

export function authBrowserTransitionsEnforced(): boolean {
  return envFlag('AUTH_BROWSER_TRANSITIONS_ENFORCED', false);
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
  if (!options?.tx || !options.capability) {
    throw new Error('Guarded user-session issuance requires a transaction and capability');
  }

  await assertAuthIssuanceCapability(options.tx, options.capability);

  // Global lock order: transition (asserted above), user, then refresh family.
  const epochs = await lockLiveUserSecurityState(options.tx, identity.userId);
  if (
    options.refreshRotation
    && (
      epochs.authEpoch !== options.refreshRotation.authEpoch
      || epochs.mfaEpoch !== options.refreshRotation.mfaEpoch
    )
  ) {
    throw new RefreshTokenCurrentnessError();
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
    familyId = await mintRefreshTokenFamily(identity.userId, refreshJti, { tx: options.tx });
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

/**
 * Temporary pre-W07 behavior for the source-contract-frozen rollout callers.
 * W07-F removes this export after telemetry proves supported clients are drained.
 */
export async function issueUserSessionLegacyDuringTransition(
  identity: UserSessionIdentity,
): Promise<TokenPair & { familyId: string }> {
  if (authBrowserTransitionsEnforced()) {
    throw new Error('Legacy user-session issuance is disabled');
  }

  const familyId = identity.legacyFamilyId ?? await mintRefreshTokenFamily(identity.userId);
  const epochs = await getUserEpochs(identity.userId);
  if (!epochs) throw new Error('Cannot issue session for missing user');
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
  }, { refreshFam: familyId });
  await bindRefreshJtiToFamily(tokens.refreshJti, familyId);
  return { ...tokens, familyId };
}

/** Populate the Redis JTI accelerator only after the authoritative commit. */
export async function bindIssuedUserSession(
  session: Pick<AuthorizedUserSession, 'refreshJti' | 'familyId'>,
): Promise<void> {
  await bindRefreshJtiToFamily(session.refreshJti, session.familyId);
}
