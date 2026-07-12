/**
 * Central grant-family revocation service — real-DB + real-Redis integration.
 *
 * Proves the security-critical behaviors that mocked unit tests cannot:
 *   - a CODE-ONLY grant (no refresh row) is revoked under partner scope
 *     (MCP-OAUTH-07);
 *   - partner-scope revoke leaves another partner's grants + join row on the
 *     same shared DCR client untouched (cross-tenant isolation);
 *   - global (registration-management) deletion revokes every family, writes
 *     the grant marker that bearer auth checks, and disables the client LAST
 *     (MCP-OAUTH-10);
 *   - repeat calls are safe no-ops.
 *
 * The grant Redis marker asserted here via `isGrantRevoked` is the exact check
 * bearer middleware performs (bearerTokenAuth: `isGrantRevoked(payload.grant_id)`),
 * so an already-minted access JWT with that grant_id is rejected immediately.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthClientPartnerGrants,
  oauthGrants,
  oauthInteractions,
  oauthRefreshTokens,
  oauthSessions,
} from '../../db/schema';
import { revokeClientFamilies } from '../../oauth/revocationService';
import { isGrantRevoked } from '../../oauth/revocationCache';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const future = () => new Date(Date.now() + 60 * 60 * 1000);

async function seedGrant(opts: {
  id: string;
  clientId: string;
  accountId: string;
  partnerId: string;
  orgId: string;
}) {
  await getTestDb().insert(oauthGrants).values({
    id: opts.id,
    accountId: opts.accountId,
    clientId: opts.clientId,
    partnerId: opts.partnerId,
    orgId: opts.orgId,
    payload: { accountId: opts.accountId, grantId: opts.id },
    expiresAt: future(),
  });
}

async function grantRow(id: string) {
  const [row] = await getTestDb()
    .select({ id: oauthGrants.id, revokedAt: oauthGrants.revokedAt })
    .from(oauthGrants)
    .where(eq(oauthGrants.id, id));
  return row;
}

describe('revokeClientFamilies (integration)', () => {
  beforeEach(async () => {
    await getTestDb().delete(oauthRefreshTokens);
    await getTestDb().delete(oauthAuthorizationCodes);
    await getTestDb().delete(oauthGrants);
    await getTestDb().delete(oauthClientPartnerGrants);
    await getTestDb().delete(oauthSessions);
    await getTestDb().delete(oauthInteractions);
    await getTestDb().delete(oauthClients);
  });

  it('revokes a code-only grant (no refresh row) under partner scope and removes only the join row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `rv-codeonly-${Date.now()}@example.test` });

    const clientId = `client-codeonly-${Date.now()}`;
    await getTestDb().insert(oauthClients).values({ id: clientId, partnerId: null, metadata: { client_name: 'Shared DCR' } });
    await getTestDb().insert(oauthClientPartnerGrants).values({ clientId, partnerId: partner.id });
    // Grant with NO refresh token — the auth-code access-token path.
    await seedGrant({ id: 'grant-code-only', clientId, accountId: user.id, partnerId: partner.id, orgId: org.id });

    const result = await revokeClientFamilies(clientId, { kind: 'partner', partnerId: partner.id });

    expect(result).toEqual({ grants: 1, refreshTokens: 0 });
    expect((await grantRow('grant-code-only'))?.revokedAt).not.toBeNull();
    // Grant marker is live — bearer auth would reject an already-minted JWT.
    expect(await isGrantRevoked('grant-code-only')).toBe(true);
    // This partner's join row is gone; the shared client row stays.
    const join = await getTestDb().select().from(oauthClientPartnerGrants).where(eq(oauthClientPartnerGrants.clientId, clientId));
    expect(join).toHaveLength(0);
    const [client] = await getTestDb().select({ disabledAt: oauthClients.disabledAt }).from(oauthClients).where(eq(oauthClients.id, clientId));
    expect(client?.disabledAt).toBeNull();
  });

  it('partner-scope revoke leaves another partner on the same shared client untouched', async () => {
    const p1 = await createPartner();
    const p2 = await createPartner();
    const o1 = await createOrganization({ partnerId: p1.id });
    const o2 = await createOrganization({ partnerId: p2.id });
    const u1 = await createUser({ partnerId: p1.id, orgId: o1.id, email: `rv-p1-${Date.now()}@example.test` });
    const u2 = await createUser({ partnerId: p2.id, orgId: o2.id, email: `rv-p2-${Date.now()}@example.test` });

    const clientId = `client-shared-${Date.now()}`;
    await getTestDb().insert(oauthClients).values({ id: clientId, partnerId: null, metadata: { client_name: 'Shared DCR' } });
    await getTestDb().insert(oauthClientPartnerGrants).values([
      { clientId, partnerId: p1.id },
      { clientId, partnerId: p2.id },
    ]);
    await seedGrant({ id: 'grant-p1', clientId, accountId: u1.id, partnerId: p1.id, orgId: o1.id });
    await seedGrant({ id: 'grant-p2', clientId, accountId: u2.id, partnerId: p2.id, orgId: o2.id });

    await revokeClientFamilies(clientId, { kind: 'partner', partnerId: p1.id });

    // P1 revoked; P2 fully intact.
    expect((await grantRow('grant-p1'))?.revokedAt).not.toBeNull();
    expect((await grantRow('grant-p2'))?.revokedAt).toBeNull();
    expect(await isGrantRevoked('grant-p1')).toBe(true);
    expect(await isGrantRevoked('grant-p2')).toBe(false);
    const joins = await getTestDb().select({ partnerId: oauthClientPartnerGrants.partnerId }).from(oauthClientPartnerGrants).where(eq(oauthClientPartnerGrants.clientId, clientId));
    expect(joins.map((j) => j.partnerId)).toEqual([p2.id]);
  });

  it('global scope revokes every family, writes bearer markers, and disables the client LAST', async () => {
    const p1 = await createPartner();
    const p2 = await createPartner();
    const o1 = await createOrganization({ partnerId: p1.id });
    const o2 = await createOrganization({ partnerId: p2.id });
    const u1 = await createUser({ partnerId: p1.id, orgId: o1.id, email: `rv-g1-${Date.now()}@example.test` });
    const u2 = await createUser({ partnerId: p2.id, orgId: o2.id, email: `rv-g2-${Date.now()}@example.test` });

    const clientId = `client-global-${Date.now()}`;
    await getTestDb().insert(oauthClients).values({ id: clientId, partnerId: null, metadata: { client_name: 'Shared DCR' } });
    await getTestDb().insert(oauthClientPartnerGrants).values([
      { clientId, partnerId: p1.id },
      { clientId, partnerId: p2.id },
    ]);
    await seedGrant({ id: 'grant-g1', clientId, accountId: u1.id, partnerId: p1.id, orgId: o1.id });
    await seedGrant({ id: 'grant-g2', clientId, accountId: u2.id, partnerId: p2.id, orgId: o2.id });
    // One grant also has a refresh row — proves refresh rows are revoked too.
    await getTestDb().insert(oauthRefreshTokens).values({
      id: 'rt-global', userId: u1.id, clientId, partnerId: p1.id, orgId: o1.id,
      payload: { sub: u1.id, grantId: 'grant-g1' }, expiresAt: future(),
    });

    const result = await revokeClientFamilies(clientId, { kind: 'global' });

    expect(result).toEqual({ grants: 2, refreshTokens: 1 });
    expect((await grantRow('grant-g1'))?.revokedAt).not.toBeNull();
    expect((await grantRow('grant-g2'))?.revokedAt).not.toBeNull();
    // Bearer-path proof: both grant markers reject already-minted access JWTs.
    expect(await isGrantRevoked('grant-g1')).toBe(true);
    expect(await isGrantRevoked('grant-g2')).toBe(true);
    const [rt] = await getTestDb().select({ revokedAt: oauthRefreshTokens.revokedAt }).from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, 'rt-global'));
    expect(rt?.revokedAt).not.toBeNull();
    // Client disabled only after every family is revoked.
    const [client] = await getTestDb().select({ disabledAt: oauthClients.disabledAt }).from(oauthClients).where(eq(oauthClients.id, clientId));
    expect(client?.disabledAt).not.toBeNull();
  });

  it('is a safe no-op on repeat (idempotent)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `rv-idem-${Date.now()}@example.test` });

    const clientId = `client-idem-${Date.now()}`;
    await getTestDb().insert(oauthClients).values({ id: clientId, partnerId: null, metadata: { client_name: 'Shared DCR' } });
    await seedGrant({ id: 'grant-idem', clientId, accountId: user.id, partnerId: partner.id, orgId: org.id });

    const first = await revokeClientFamilies(clientId, { kind: 'global' });
    expect(first).toEqual({ grants: 1, refreshTokens: 0 });
    const [afterFirst] = await getTestDb().select({ disabledAt: oauthClients.disabledAt }).from(oauthClients).where(eq(oauthClients.id, clientId));
    expect(afterFirst?.disabledAt).not.toBeNull();

    const second = await revokeClientFamilies(clientId, { kind: 'global' });
    // Nothing left active to revoke.
    expect(second).toEqual({ grants: 0, refreshTokens: 0 });
    // disabledAt is unchanged by the guarded repeat.
    const [afterSecond] = await getTestDb().select({ disabledAt: oauthClients.disabledAt }).from(oauthClients).where(eq(oauthClients.id, clientId));
    expect(afterSecond?.disabledAt?.getTime()).toBe(afterFirst?.disabledAt?.getTime());
  });
});
