import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema/users';
import { createTokenPair, type TokenPair } from './jwt';
import {
  bindRefreshJtiToFamily,
  getActiveRefreshTokenFamily,
  mintRefreshTokenFamily,
} from './refreshTokenFamily';

export type UserSessionIdentity = {
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  mfa: boolean;
  mobileDeviceId?: string;
};

type UserSecurityEpochs = {
  authEpoch: number;
  mfaEpoch: number;
};

async function loadUserSecurityEpochs(userId: string): Promise<UserSecurityEpochs> {
  const rows = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () =>
      dbModule.db
        .select({
          authEpoch: users.authEpoch,
          mfaEpoch: users.mfaEpoch,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )
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
  options: { familyId?: string } = {},
): Promise<TokenPair & { familyId: string }> {
  const epochs = await loadUserSecurityEpochs(identity.userId);
  let familyId: string;

  if (options.familyId) {
    const family = await getActiveRefreshTokenFamily(options.familyId, identity.userId);
    if (!family) {
      throw new Error('Cannot issue session for inactive refresh token family');
    }
    familyId = family.familyId;
  } else {
    familyId = await mintRefreshTokenFamily(identity.userId);
  }

  const tokens = await createTokenPair({
    sub: identity.userId,
    email: identity.email,
    roleId: identity.roleId,
    orgId: identity.orgId,
    partnerId: identity.partnerId,
    scope: identity.scope,
    mfa: identity.mfa,
    mdid: identity.mobileDeviceId,
    ae: epochs.authEpoch,
    me: epochs.mfaEpoch,
    sid: familyId,
  }, { refreshFam: familyId });

  await bindRefreshJtiToFamily(tokens.refreshJti, familyId);
  return { ...tokens, familyId };
}
