import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema/users';
import {
  createTokenPair,
  type AuthenticationMethod,
  type TokenPair,
} from './jwt';
import {
  bindRefreshJtiToFamily,
  getActiveRefreshTokenFamily,
  mintRefreshTokenFamily,
} from './refreshTokenFamily';
import type { AuthLifecycleTransaction } from './authLifecycle';

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

type UserSecurityEpochs = {
  authEpoch: number;
  mfaEpoch: number;
};

async function loadUserSecurityEpochs(
  userId: string,
  tx?: AuthLifecycleTransaction,
): Promise<UserSecurityEpochs> {
  const query = (database: Pick<AuthLifecycleTransaction, 'select'>) =>
    database
        .select({
          authEpoch: users.authEpoch,
          mfaEpoch: users.mfaEpoch,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
  const rows = tx
    ? await query(tx)
    : await dbModule.runOutsideDbContext(() =>
      dbModule.withSystemDbAccessContext(() => query(dbModule.db))
    );
  const epochs = rows[0];
  if (!epochs) {
    throw new Error('Cannot issue session for missing user');
  }
  return epochs;
}

/**
 * The sole high-level issuer for first-party user access/refresh token pairs.
 * Epochs always come from the live user row, and rotation can only continue in
 * the caller's own durable, unrevoked, unexpired family.
 */
export async function issueUserSession(
  identity: UserSessionIdentity,
  options: { familyId?: string; tx?: AuthLifecycleTransaction } = {},
): Promise<TokenPair & { familyId: string }> {
  const epochs = await loadUserSecurityEpochs(identity.userId, options.tx);
  let familyId: string;

  if (options.familyId) {
    const family = await getActiveRefreshTokenFamily(options.familyId, identity.userId, {
      tx: options.tx,
    });
    if (!family) {
      throw new UserSessionFamilyInactiveError();
    }
    familyId = family.familyId;
  } else {
    familyId = await mintRefreshTokenFamily(identity.userId, { tx: options.tx });
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
  }, { refreshFam: familyId });

  const issued = { ...tokens, familyId };
  if (!options.tx) {
    await bindIssuedUserSession(issued);
  }
  return issued;
}

/**
 * Populate the Redis jti accelerator only after the transaction that created
 * the durable family commits. The signed `fam` claim and PostgreSQL family row
 * remain authoritative if this best-effort cache bind fails.
 */
export async function bindIssuedUserSession(
  session: Pick<TokenPair, 'refreshJti'> & { familyId: string },
): Promise<void> {
  await bindRefreshJtiToFamily(session.refreshJti, session.familyId);
}
