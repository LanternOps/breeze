/**
 * Customer-domain CRUD against the real DB (portal registration W5 #11382,
 * plan Task 7, RF2 / D9): re-pointing a verified row through the CRUD service
 * (the path behind both `/ticket-config/inbound-domains/:id` and
 * `/organizations/:id/customer-domains/:domainId`) clears its verification via
 * the DB trigger, and no CRUD return carries the token or evidence.
 *
 * Run:
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalDomainVerificationRoutes.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { customerEmailDomains } from '../../db/schema';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { createCustomerEmailDomain, listCustomerEmailDomains, updateCustomerEmailDomain } from '../../services/ticketConfigService';

const admin = () => getTestDb();

async function setup() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test` });
  const ctx: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id, orgB.id],
    accessiblePartnerIds: [partner.id],
    userId: user.id,
  };
  return { partner, orgA, orgB, user, ctx };
}

async function seedVerified(partnerId: string, orgId: string) {
  const at = new Date(Date.now() - 60 * 60_000);
  const [row] = await admin().insert(customerEmailDomains).values({
    partnerId,
    orgId,
    domain: `d-${randomUUID().slice(0, 8)}.example.com`,
    verificationToken: `tok-${randomUUID()}`,
    verifiedAt: at,
    verifiedMethod: 'dns_txt',
    verifiedEvidence: { via: 'dns_txt', recordName: '_breeze-verify.example.com' },
    lastCheckedAt: at,
    lastPassedAt: at,
    lastCheckStatus: 'pass',
  }).returning();
  return row!;
}

async function rowOf(id: string) {
  const [row] = await admin().select().from(customerEmailDomains).where(eq(customerEmailDomains.id, id));
  return row!;
}

describe('customer domain CRUD and verification', () => {
  it('PATCH orgId on a verified row clears verification (via the trigger)', async () => {
    const { partner, orgA, orgB, ctx } = await setup();
    const seeded = await seedVerified(partner.id, orgA.id);

    const view = await withDbAccessContext(ctx, () => updateCustomerEmailDomain(partner.id, seeded.id, { orgId: orgB.id }));

    expect(view).toMatchObject({ id: seeded.id, orgId: orgB.id, state: 'declared', verifiedAt: null, usableForSignIn: false });
    const after = await rowOf(seeded.id);
    expect(after.orgId).toBe(orgB.id);
    expect(after.verifiedAt).toBeNull();
    expect(after.verifiedMethod).toBeNull();
    expect(after.verifiedEvidence).toBeNull();
    expect(after.clearedReason).toBe('repointed');
    expect(after.clearedAt).not.toBeNull();
  });

  it('PATCH orgId through /ticket-config clears verification', async () => {
    // /ticket-config/inbound-domains/:id is a thin wrapper over the same
    // service call with the partner id, so exercise it exactly as that route does.
    const { partner, orgA, orgB, ctx } = await setup();
    const seeded = await seedVerified(partner.id, orgA.id);

    await withDbAccessContext(ctx, () => updateCustomerEmailDomain(partner.id, seeded.id, { orgId: orgB.id, isActive: true }));

    const after = await rowOf(seeded.id);
    expect(after).toMatchObject({ orgId: orgB.id, verifiedAt: null, clearedReason: 'repointed' });
  });

  it('a non-repointing PATCH keeps the verification', async () => {
    const { partner, orgA, ctx } = await setup();
    const seeded = await seedVerified(partner.id, orgA.id);

    await withDbAccessContext(ctx, () => updateCustomerEmailDomain(partner.id, seeded.id, { autoCreateContact: false }));

    const after = await rowOf(seeded.id);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.autoCreateContact).toBe(false);
  });

  it('CRUD returns never carry verification_token or verified_evidence', async () => {
    const { partner, orgA, ctx } = await setup();
    const seeded = await seedVerified(partner.id, orgA.id);

    const created = await withDbAccessContext(ctx, () =>
      createCustomerEmailDomain(partner.id, { orgId: orgA.id, domain: `n-${randomUUID().slice(0, 8)}.example.com`, autoCreateContact: true }, { userId: ctx.userId! }));
    const updated = await withDbAccessContext(ctx, () => updateCustomerEmailDomain(partner.id, seeded.id, { autoCreateContact: false }));
    const listed = await withDbAccessContext(ctx, () => listCustomerEmailDomains(partner.id));

    for (const out of [created, updated, listed]) {
      expect(JSON.stringify(out)).not.toMatch(/verification_?token|verified_?evidence/i);
      // The published DNS record (which embeds the token by design) is the only exposure.
      expect(JSON.stringify(out)).not.toContain('"via"');
    }
    expect(listed.find((r) => r.id === seeded.id)).toMatchObject({ state: 'verified', method: 'dns_txt', orgName: expect.any(String) });
  });
});
