import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema/users';
import {
  createTokenPair,
  type AuthenticationMethod,
  type TokenPair,
} from './jwt';
import {
  bindRefreshJtiToFamily,
  mintRefreshTokenFamily,
  RefreshTokenCurrentnessError,
  rotateRefreshTokenFamilyCurrentJti,
} from './refreshTokenFamily';
import {
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import {
  assertAuthIssuanceCapability,
  bindAuthIssuanceSession,
  type AuthIssuanceCapability,
} from './authBrowserTransition';

export type UserSessionIdentity = {
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  mfa: boolean;
  amr: readonly AuthenticationMethod[];
  mobileDeviceId?: string;
};

export class UserSessionFamilyInactiveError extends Error {
  constructor() {
    super('Cannot issue session for inactive refresh token family');
    this.name = 'UserSessionFamilyInactiveError';
  }
}

type UserSecurityEpochs = { authEpoch: number; mfaEpoch: number };

async function lockUserSecurityEpochs(
  userId: string,
  tx: AuthLifecycleTransaction,
): Promise<UserSecurityEpochs> {
  const [epochs] = await tx
    .select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
    .limit(1);
  if (!epochs) throw new Error('Cannot issue session for missing user');
  return epochs;
}

type GuardedIssueOptions = {
  tx: AuthLifecycleTransaction;
  capability: AuthIssuanceCapability;
  familyId?: string;
  refreshRotation?: Readonly<{
    presentedJti: string;
    authEpoch: number;
    mfaEpoch: number;
  }>;
};

type LegacyIssueOptions = { tx?: AuthLifecycleTransaction };

async function issueInTransaction(
  identity: UserSessionIdentity,
  options: {
    tx: AuthLifecycleTransaction;
    capability?: AuthIssuanceCapability;
    familyId?: string;
    refreshRotation?: GuardedIssueOptions['refreshRotation'];
  },
): Promise<TokenPair & { familyId: string }> {
  if (options.capability) {
    await assertAuthIssuanceCapability(options.tx, options.capability);
  }

  // Global order: transition (above), user, then family.
  const epochs = await lockUserSecurityEpochs(identity.userId, options.tx);
  if (
    options.refreshRotation
    && (epochs.authEpoch !== options.refreshRotation.authEpoch
      || epochs.mfaEpoch !== options.refreshRotation.mfaEpoch)
  ) {
    throw new RefreshTokenCurrentnessError();
  }

  const refreshJti = randomUUID();
  let familyId: string;
  if (options.familyId) {
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
    amr: [...identity.amr],
    mdid: identity.mobileDeviceId,
    ae: epochs.authEpoch,
    me: epochs.mfaEpoch,
    sid: familyId,
  }, { refreshFam: familyId, refreshJti });

  if (options.capability) {
    await bindAuthIssuanceSession(
      options.tx,
      options.capability,
      identity.userId,
      familyId,
    );
  }
  return { ...tokens, familyId };
}

/** Guarded issuer used by migrated browser-auth flows. */
export async function issueUserSession(
  identity: UserSessionIdentity,
  options: GuardedIssueOptions,
): Promise<TokenPair & { familyId: string }> {
  if (!options?.tx || !options.capability) {
    throw new Error('Guarded user-session issuance requires a transaction and capability');
  }
  return issueInTransaction(identity, options);
}

/**
 * Temporary Tasks 4-9 migration seam. Its exact callers are frozen by the
 * source contract; refresh is forbidden from using it and Task 11 removes it.
 */
export async function issueUserSessionLegacyDuringTransition(
  identity: UserSessionIdentity,
  existingOptions: LegacyIssueOptions = {},
): Promise<TokenPair & { familyId: string }> {
  if (existingOptions.tx) {
    return issueInTransaction(identity, { tx: existingOptions.tx });
  }
  const issued = await withAuthLifecycleSystemTransaction((tx) =>
    issueInTransaction(identity, { tx }));
  await bindIssuedUserSession(issued);
  return issued;
}

/** Populate the Redis JTI accelerator only after the authoritative commit. */
export async function bindIssuedUserSession(
  session: Pick<TokenPair, 'refreshJti'> & { familyId: string },
): Promise<void> {
  await bindRefreshJtiToFamily(session.refreshJti, session.familyId);
}
