/**
 * Real-DB tenant-cascade coverage for the SSO FK children (#2195).
 *
 * `user_sso_identities` and `sso_sessions` carry NO org_id/partner_id column —
 * they hang off sso_providers and users. Until #2195 neither cascade cleared
 * them, so any org (GDPR erasure) or canary partner (synthetic purge) that had
 * ever exercised SSO failed its cascade with an FK violation on the
 * sso_providers/users DELETEs. These cases run the REAL cascades against real
 * Postgres with seeded SSO rows and assert they complete and sweep everything.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/tenantCascadeSso.integration.test.ts
 */
import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { organizations, partners, ssoProviders, ssoSessions, userSsoIdentities, users } from '../../db/schema';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';
import { createPartner, createOrganization } from './db-utils';

async function seedSsoRows(opts: { orgId?: string | null; partnerId?: string | null; userPartnerId: string; userOrgId?: string | null }) {
  const db = getTestDb();
  const [provider] = await db
    .insert(ssoProviders)
    .values({
      orgId: opts.orgId ?? null,
      partnerId: opts.partnerId ?? null,
      name: 'Cascade Test IdP',
      type: 'oidc',
      status: 'active',
      issuer: 'https://idp.cascade.test',
      clientId: 'cascade-client',
      autoProvision: false,
    })
    .returning();
  if (!provider) throw new Error('provider seed failed');

  const [user] = await db
    .insert(users)
    .values({
      partnerId: opts.userPartnerId,
      orgId: opts.userOrgId ?? null,
      email: `cascade-sso-${randomUUID()}@example.com`,
      name: 'Cascade SSO User',
      passwordHash: null,
      status: 'active',
    })
    .returning();
  if (!user) throw new Error('user seed failed');

  await db.insert(userSsoIdentities).values({
    userId: user.id,
    providerId: provider.id,
    externalId: `cascade-sub-${randomUUID()}`,
    email: user.email,
  });
  await db.insert(ssoSessions).values({
    providerId: provider.id,
    state: randomUUID().replace(/-/g, ''),
    nonce: 'cascade-nonce',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  return { provider, user };
}

describe('tenant cascades sweep SSO FK children (#2195)', () => {
  it('cascadeDeleteOrg completes for an org with an SSO provider, identity link, and pending session', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { provider } = await seedSsoRows({ orgId: org.id, userPartnerId: partner.id, userOrgId: org.id });

    const stats = await cascadeDeleteOrg(org.id, randomUUID());

    expect(stats.tablesDeleted['user_sso_identities']).toBe(1);
    expect(stats.tablesDeleted['sso_sessions']).toBe(1);
    const [orgRow] = await db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
    expect(orgRow).toBeUndefined();
    const providerRows = await db.select().from(ssoProviders).where(eq(ssoProviders.id, provider.id));
    expect(providerRows).toHaveLength(0);
    const sessionRows = await db.select().from(ssoSessions).where(eq(ssoSessions.providerId, provider.id));
    expect(sessionRows).toHaveLength(0);
  });

  it('cascadeDeletePartner completes for a partner whose staff exercised partner-axis SSO', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const { provider } = await seedSsoRows({ partnerId: partner.id, userPartnerId: partner.id, userOrgId: null });

    const stats = await cascadeDeletePartner(partner.id, randomUUID());

    expect(stats.tablesDeleted['user_sso_identities']).toBe(1);
    expect(stats.tablesDeleted['sso_sessions']).toBe(1);
    expect(stats.tablesDeleted['partners']).toBe(1);
    const [partnerRow] = await db.select().from(partners).where(eq(partners.id, partner.id)).limit(1);
    expect(partnerRow).toBeUndefined();
    const providerRows = await db.select().from(ssoProviders).where(eq(ssoProviders.id, provider.id));
    expect(providerRows).toHaveLength(0);
  });
});
