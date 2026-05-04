import { eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { apiKeys, organizationUsers, organizations, partnerUsers } from '../db/schema';
import { revokeAllOrgOauthArtifacts, revokeAllPartnerOauthArtifacts } from '../oauth/grantRevocation';
import { clearPermissionCache } from './permissions';
import { revokeAllUserTokens } from './tokenRevocation';

export interface TenantRevocationResult {
  apiKeysRevoked: number;
  userSessionsRevoked: number;
  oauthGrantsRevoked: number;
  oauthRefreshTokensRevoked: number;
}

async function revokeApiKeysForOrgIds(orgIds: string[]): Promise<number> {
  if (orgIds.length === 0) return 0;
  const rows = await db
    .update(apiKeys)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(inArray(apiKeys.orgId, orgIds))
    .returning({ id: apiKeys.id });
  return rows.length;
}

async function revokeUsers(userIds: string[]): Promise<number> {
  const uniqueUserIds = [...new Set(userIds)];
  for (const userId of uniqueUserIds) {
    await revokeAllUserTokens(userId);
    await clearPermissionCache(userId);
  }
  return uniqueUserIds.length;
}

export async function revokeOrganizationTenantAccess(orgId: string): Promise<TenantRevocationResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgUsers = await db
        .select({ userId: organizationUsers.userId })
        .from(organizationUsers)
        .where(eq(organizationUsers.orgId, orgId));

      const [apiKeysRevoked, userSessionsRevoked, oauth] = await Promise.all([
        revokeApiKeysForOrgIds([orgId]),
        revokeUsers(orgUsers.map((row) => row.userId)),
        revokeAllOrgOauthArtifacts(orgId),
      ]);

      return {
        apiKeysRevoked,
        userSessionsRevoked,
        oauthGrantsRevoked: oauth.grantsRevoked,
        oauthRefreshTokensRevoked: oauth.refreshTokensRevoked,
      };
    })
  );
}

export async function revokePartnerTenantAccess(partnerId: string): Promise<TenantRevocationResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgRows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, partnerId));
      const orgIds = orgRows.map((row) => row.id);

      const partnerMemberships = await db
        .select({ userId: partnerUsers.userId })
        .from(partnerUsers)
        .where(eq(partnerUsers.partnerId, partnerId));

      const orgMemberships = orgIds.length === 0
        ? []
        : await db
          .select({ userId: organizationUsers.userId })
          .from(organizationUsers)
          .where(inArray(organizationUsers.orgId, orgIds));

      const [apiKeysRevoked, userSessionsRevoked, oauth] = await Promise.all([
        revokeApiKeysForOrgIds(orgIds),
        revokeUsers([
          ...partnerMemberships.map((row) => row.userId),
          ...orgMemberships.map((row) => row.userId),
        ]),
        revokeAllPartnerOauthArtifacts(partnerId),
      ]);

      return {
        apiKeysRevoked,
        userSessionsRevoked,
        oauthGrantsRevoked: oauth.grantsRevoked,
        oauthRefreshTokensRevoked: oauth.refreshTokensRevoked,
      };
    })
  );
}
