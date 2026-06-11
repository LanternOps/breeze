import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

async function seedTwoUserOauthRows() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const userA = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `oauth-rls-a-${Date.now()}@example.test`,
  });
  const userB = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `oauth-rls-b-${Date.now()}@example.test`,
  });

  await getTestDb().insert(oauthClients).values({
    id: `rls-client-${Date.now()}`,
    partnerId: partner.id,
    metadata: { client_name: 'RLS OAuth test client' },
  });
  const client = await getTestDb().query.oauthClients.findFirst({
    where: eq(oauthClients.partnerId, partner.id),
  });
  if (!client) throw new Error('failed to seed OAuth client');

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await getTestDb().insert(oauthAuthorizationCodes).values([
    {
      id: 'rls-code-user-a',
      userId: userA.id,
      clientId: client.id,
      partnerId: partner.id,
      orgId: org.id,
      payload: { sub: userA.id },
      expiresAt,
    },
    {
      id: 'rls-code-user-b',
      userId: userB.id,
      clientId: client.id,
      partnerId: partner.id,
      orgId: org.id,
      payload: { sub: userB.id },
      expiresAt,
    },
  ]);
  await getTestDb().insert(oauthGrants).values([
    {
      id: 'rls-grant-user-a',
      accountId: userA.id,
      clientId: client.id,
      partnerId: partner.id,
      orgId: org.id,
      payload: { accountId: userA.id },
      expiresAt,
    },
    {
      id: 'rls-grant-user-b',
      accountId: userB.id,
      clientId: client.id,
      partnerId: partner.id,
      orgId: org.id,
      payload: { accountId: userB.id },
      expiresAt,
    },
  ]);
  await getTestDb().insert(oauthRefreshTokens).values([
    {
      id: 'rls-refresh-user-a',
      userId: userA.id,
      clientId: client.id,
      partnerId: partner.id,
      orgId: org.id,
      payload: { sub: userA.id, jti: 'jti-a', grantId: 'rls-grant-user-a' },
      expiresAt,
    },
    {
      id: 'rls-refresh-user-b',
      userId: userB.id,
      clientId: client.id,
      partnerId: partner.id,
      orgId: org.id,
      payload: { sub: userB.id, jti: 'jti-b', grantId: 'rls-grant-user-b' },
      expiresAt,
    },
  ]);

  return { partner, org, userA, userB };
}

describe('OAuth token-row RLS', () => {
  it('does not expose another same-org user OAuth rows through org context', async () => {
    const { org, userA } = await seedTwoUserOauthRows();
    const context = {
      scope: 'organization' as const,
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [org.partnerId],
      userId: userA.id,
    };

    const [codes, grants, refreshTokens] = await withDbAccessContext(context, async () =>
      Promise.all([
        db
          .select({ id: oauthAuthorizationCodes.id })
          .from(oauthAuthorizationCodes)
          .where(inArray(oauthAuthorizationCodes.id, ['rls-code-user-a', 'rls-code-user-b'])),
        db
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(inArray(oauthGrants.id, ['rls-grant-user-a', 'rls-grant-user-b'])),
        db
          .select({ id: oauthRefreshTokens.id })
          .from(oauthRefreshTokens)
          .where(inArray(oauthRefreshTokens.id, ['rls-refresh-user-a', 'rls-refresh-user-b'])),
      ])
    );

    expect(codes.map((row) => row.id)).toEqual(['rls-code-user-a']);
    expect(grants.map((row) => row.id)).toEqual(['rls-grant-user-a']);
    expect(refreshTokens.map((row) => row.id)).toEqual(['rls-refresh-user-a']);
  });

  it('preserves tenant-wide revocation semantics through explicit system context', async () => {
    const { org } = await seedTwoUserOauthRows();

    const revoked = await withSystemDbAccessContext(() =>
      db
        .update(oauthRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthRefreshTokens.orgId, org.id))
        .returning({ id: oauthRefreshTokens.id })
    );

    expect(revoked.map((row) => row.id).sort()).toEqual([
      'rls-refresh-user-a',
      'rls-refresh-user-b',
    ]);
  });
});
