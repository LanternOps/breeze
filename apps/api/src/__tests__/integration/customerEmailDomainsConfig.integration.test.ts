/**
 * Integration coverage for the Phase 5 customer-email-domain config service
 * (listCustomerEmailDomains / create / update / delete), run against the real
 * test DB through partner-scope request context (as the routes call them).
 *
 * Proves the IDOR boundary functionally: a partner cannot map a domain to — or
 * re-point one at — an org outside its partner, and cannot mutate another
 * partner's mapping (404, scoped out).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { customerEmailDomains } from '../../db/schema/emailInbound';
import { organizations, partners, users } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import {
  listCustomerEmailDomains,
  createCustomerEmailDomain,
  updateCustomerEmailDomain,
  deleteCustomerEmailDomain,
} from '../../services/ticketConfigService';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];
const seededUserIds: string[] = [];
const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function seedTwoPartners() {
  const a = await createPartner();
  const aOrg = await createOrganization({ partnerId: a.id });
  const aUser = await createUser({ partnerId: a.id });
  const b = await createPartner();
  const bOrg = await createOrganization({ partnerId: b.id });
  seededPartnerIds.push(a.id, b.id);
  seededOrgIds.push(aOrg.id, bOrg.id);
  seededUserIds.push(aUser.id);

  const ctxA: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [aOrg.id],
    accessiblePartnerIds: [a.id],
    userId: aUser.id,
  };
  return { a, aOrg, aUser, b, bOrg, ctxA };
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  await adminDb.delete(customerEmailDomains).where(sql`${customerEmailDomains.partnerId} IN (${partnerList})`);
  if (seededUserIds.length > 0) {
    const userList = sql.join(seededUserIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(users).where(sql`${users.id} IN (${userList})`);
  }
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('customer email domain config service', () => {
  it('creates a mapping and lists it joined with the org name', async () => {
    const { a, aOrg, aUser, ctxA } = await seedTwoPartners();
    const domain = `acme-${uniqueSuffix()}.test`;

    const created = await withDbAccessContext(ctxA, () =>
      createCustomerEmailDomain(a.id, { domain, orgId: aOrg.id, autoCreateContact: true }, { userId: aUser.id })
    );
    expect(created.domain).toBe(domain);

    const list = await withDbAccessContext(ctxA, () => listCustomerEmailDomains(a.id));
    const row = list.find((r) => r.domain === domain);
    expect(row).toBeDefined();
    expect(row!.orgId).toBe(aOrg.id);
    expect(row!.orgName).toBe(aOrg.name);
  });

  it('rejects mapping an org outside the partner (ORG_NOT_ACCESSIBLE, 400)', async () => {
    const { a, bOrg, aUser, ctxA } = await seedTwoPartners();
    await expect(
      withDbAccessContext(ctxA, () =>
        createCustomerEmailDomain(a.id, { domain: `evil-${uniqueSuffix()}.test`, orgId: bOrg.id, autoCreateContact: true }, { userId: aUser.id })
      )
    ).rejects.toMatchObject({ status: 400, code: 'ORG_NOT_ACCESSIBLE' });
  });

  it('rejects a duplicate domain for the same partner (409)', async () => {
    const { a, aOrg, aUser, ctxA } = await seedTwoPartners();
    const domain = `dup-${uniqueSuffix()}.test`;
    await withDbAccessContext(ctxA, () =>
      createCustomerEmailDomain(a.id, { domain, orgId: aOrg.id, autoCreateContact: true }, { userId: aUser.id })
    );
    await expect(
      withDbAccessContext(ctxA, () =>
        createCustomerEmailDomain(a.id, { domain, orgId: aOrg.id, autoCreateContact: true }, { userId: aUser.id })
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it('updates isActive and rejects re-pointing at another partner org (400)', async () => {
    const { a, aOrg, bOrg, aUser, ctxA } = await seedTwoPartners();
    const domain = `upd-${uniqueSuffix()}.test`;
    const created = await withDbAccessContext(ctxA, () =>
      createCustomerEmailDomain(a.id, { domain, orgId: aOrg.id, autoCreateContact: true }, { userId: aUser.id })
    );

    const updated = await withDbAccessContext(ctxA, () =>
      updateCustomerEmailDomain(a.id, created.id, { isActive: false })
    );
    expect(updated.isActive).toBe(false);

    await expect(
      withDbAccessContext(ctxA, () => updateCustomerEmailDomain(a.id, created.id, { orgId: bOrg.id }))
    ).rejects.toMatchObject({ status: 400, code: 'ORG_NOT_ACCESSIBLE' });
  });

  it('returns 404 deleting a non-existent / other-partner mapping', async () => {
    const { a, ctxA } = await seedTwoPartners();
    await expect(
      withDbAccessContext(ctxA, () => deleteCustomerEmailDomain(a.id, '11111111-1111-4111-8111-111111111111'))
    ).rejects.toMatchObject({ status: 404 });
  });
});
