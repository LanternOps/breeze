import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema/users';
import { organizations } from '../db/schema/orgs';
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
import type { MfaAssuranceSource } from './mfaAssuranceSource';

const AUTHORIZED_USER_SESSION: unique symbol = Symbol('AuthorizedUserSession');

export type UserSessionIdentity = Readonly<{
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  mfa: boolean;
  /** How `mfa: true` was earned. Omit when `mfa` is false. See services/mfaAssuranceSource.ts. */
  mfaSrc?: MfaAssuranceSource;
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

/**
 * An organization-scope identity whose partnerId is not the partner that owns
 * its org (or whose org does not exist). Thrown before any family is minted or
 * token signed.
 */
export class UserSessionTenantMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserSessionTenantMismatchError';
  }
}

/**
 * The partner that owns `orgId`, read on the issuance transaction. Every
 * organization-scope session carries it (#12246): partner-wide config rows
 * (org_id NULL) are readable by an org session only through the
 * `*_partner_wide_select` RLS branches, which key on the session's partner
 * (`breeze_current_partner_id()`). Read-only — an org session's
 * `accessiblePartnerIds` stays empty, so it gains no partner-axis write.
 * Returns null when the org does not exist.
 */
export async function resolveOrganizationSessionPartnerId(
  tx: AuthLifecycleTransaction,
  orgId: string,
): Promise<string | null> {
  const [org] = await tx
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.partnerId ?? null;
}

/**
 * Pin an organization-scope identity to its org's owning partner. A caller
 * that passed no partnerId gets the owner filled in (a session minted from an
 * older token that carried none heals here); a caller that passed a different
 * partner is a minter bug and is refused. Other scopes pass through.
 */
async function bindOrganizationSessionPartner(
  tx: AuthLifecycleTransaction,
  identity: UserSessionIdentity,
): Promise<UserSessionIdentity> {
  if (identity.scope !== 'organization') return identity;
  if (!identity.orgId) {
    throw new UserSessionTenantMismatchError('Organization session requires an orgId');
  }
  const ownerPartnerId = await resolveOrganizationSessionPartnerId(tx, identity.orgId);
  if (!ownerPartnerId) {
    throw new UserSessionTenantMismatchError('Organization session names an unknown organization');
  }
  if (identity.partnerId !== null && identity.partnerId !== ownerPartnerId) {
    throw new UserSessionTenantMismatchError('Organization session partner does not own its organization');
  }
  return identity.partnerId === ownerPartnerId ? identity : { ...identity, partnerId: ownerPartnerId };
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
  requestedIdentity: UserSessionIdentity,
  options: GuardedUserSessionIssueOptions,
): Promise<AuthorizedUserSession> {
  if (!options?.tx || !options.capability || !options.expectedEpochs) {
    throw new Error('Guarded user-session issuance requires a transaction, capability, and expected epochs');
  }

  await assertAuthIssuanceCapability(options.tx, options.capability);

  // Global lock order: transition (asserted above), user, then refresh family.
  const epochs = await lockLiveUserSecurityState(options.tx, requestedIdentity.userId);
  if (
    epochs.authEpoch !== options.expectedEpochs.authEpoch
    || epochs.mfaEpoch !== options.expectedEpochs.mfaEpoch
  ) {
    if (options.refreshRotation) throw new RefreshTokenCurrentnessError();
    throw new UserSessionEpochMismatchError();
  }

  // Unlocked read; it takes no row lock, so the lock order above is unchanged.
  const identity = await bindOrganizationSessionPartner(options.tx, requestedIdentity);

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
    mfa_src: identity.mfaSrc,
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
