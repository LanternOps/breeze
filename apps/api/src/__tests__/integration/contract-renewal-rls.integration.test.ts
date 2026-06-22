import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext, withDbAccessContext } from '../../db';
import { partners, organizations, contracts, contractRenewalNotices } from '../../db/schema';
import { eq } from 'drizzle-orm';

function orgContext(orgId: string) {
  return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seed() {
  const sfx = Math.random().toString(36).slice(2, 8);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `RN Partner ${sfx}`, slug: `rn-${sfx}`, type: 'msp', plan: 'pro', status: 'active'
    }).returning({ id: partners.id });
    const [orgA, orgB] = await db.insert(organizations).values([
      { partnerId: p!.id, name: 'RN Org A', slug: `rn-a-${sfx}` },
      { partnerId: p!.id, name: 'RN Org B', slug: `rn-b-${sfx}` }
    ]).returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: orgA!.id, name: 'rn', status: 'active',
      intervalMonths: 1, startDate: '2026-07-01', endDate: '2027-07-01',
      autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30
    }).returning({ id: contracts.id });
    return { partnerId: p!.id, orgAId: orgA!.id, orgBId: orgB!.id, contractId: c!.id };
  });
}

describe('contract_renewal_notices RLS forge (shape 1, org-axis)', () => {
  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK', async () => {
    const { orgAId, orgBId, contractId } = await seed();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(contractRenewalNotices).values({
          contractId, orgId: orgAId, endDate: '2027-07-01', kind: 'advance'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const c = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = c?.cause?.message ?? c?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "contract_renewal_notices"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's renewal notice", async () => {
    const { orgAId, orgBId, contractId } = await seed();
    let id = '';
    await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(contractRenewalNotices).values({
        contractId, orgId: orgAId, endDate: '2027-07-01', kind: 'renewed'
      }).returning({ id: contractRenewalNotices.id });
      id = row!.id;
    });
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: contractRenewalNotices.id }).from(contractRenewalNotices).where(eq(contractRenewalNotices.id, id))
    );
    expect(visible).toHaveLength(0);
  });
});
