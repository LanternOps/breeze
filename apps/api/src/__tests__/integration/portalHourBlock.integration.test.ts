import './setup';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { timeEntries } from '../../db/schema';
import { portalHourBlockForOrg } from '../../services/portal/hourBlock';
import { createPartner, createUser } from './db-utils';
import { seedBlockOrg } from './hourBlockFixtures';

const AS_OF = new Date('2026-12-20T12:00:00Z');

const orgContext = (orgId: string): DbAccessContext => ({
  scope: 'organization',
  orgId,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [],
  userId: null,
  currentPartnerId: null,
});

async function seedPartnerAndTech() {
  const partner = await createPartner();
  const technician = await createUser({ partnerId: partner.id, orgId: null });
  return { partnerId: partner.id, technicianId: technician.id };
}

describe('portal hour-block read (block hours W04)', () => {
  it('reads real figures from an org-scoped request context that cannot see time_entries', async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const a = await seedBlockOrg({
      partnerId, technicianId,
      entries: [
        { minutes: 240 },                      // 4.0 h approved
        { minutes: 90, approved: false },      // 1.5 h unapproved — still draws (Decision 4 A)
        { minutes: 60, billable: false },      // non-billable — never draws
      ],
    });

    await withDbAccessContext(orgContext(a.orgId), async () => {
      // The trap this task exists to avoid: partner-axis time_entries is
      // invisible to an org-scoped context.
      await expect(db.select({ id: timeEntries.id }).from(timeEntries)).resolves.toEqual([]);

      // ...yet the portal read still sees the real balance because it escapes
      // to a system context pinned to the org.
      const { hourBlock: dto } = await portalHourBlockForOrg({ orgId: a.orgId, asOf: AS_OF });
      expect(dto).toEqual({
        periodStart: '2026-12-01',
        periodEnd: '2027-01-01',
        includedHours: 10,
        carriedInHours: 0,
        usedHours: 5.5,
        remainingHours: 4.5,
        overageHours: 0,
        overageRate: '150.00',
        currencyCode: 'USD',
        billingTiming: 'advance',
      });
    });
  });

  it("org B never sees org A's block, and an org with no block gets null", async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const a = await seedBlockOrg({ partnerId, technicianId, entries: [{ minutes: 600 }] });
    const b = await seedBlockOrg({
      partnerId, technicianId, includedHours: '4.00', overageRate: '90.00',
      entries: [{ minutes: 60 }],
    });

    const { hourBlock: forB } = await portalHourBlockForOrg({ orgId: b.orgId, asOf: AS_OF });
    expect(forB).toMatchObject({ includedHours: 4, usedHours: 1, overageRate: '90.00' });
    // Org A's 10.0 used hours and 150.00 rate are nowhere in B's answer.
    expect(JSON.stringify(forB)).not.toContain('150.00');

    const { hourBlock: forA } = await portalHourBlockForOrg({ orgId: a.orgId, asOf: AS_OF });
    expect(forA).toMatchObject({ includedHours: 10, usedHours: 10, remainingHours: 0, overageHours: 0 });

    const stranger = await createPartner();
    const noBlock = await seedBlockOrg({
      partnerId: stranger.id,
      technicianId: (await createUser({ partnerId: stranger.id, orgId: null })).id,
      retired: true,
    });
    await expect(portalHourBlockForOrg({ orgId: noBlock.orgId, asOf: AS_OF })).resolves.toEqual({ hourBlock: null, startsOn: null });
  });

  it('a block whose first period has not started yet reports startsOn, not a 0-of-10 card', async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const a = await seedBlockOrg({ partnerId, technicianId });

    // The fixture's first period starts 2026-12-01; before it, nothing is running.
    const res = await portalHourBlockForOrg({ orgId: a.orgId, asOf: new Date('2026-11-20T12:00:00Z') });

    expect(res).toEqual({ hourBlock: null, startsOn: '2026-12-01' });
  });

  it('reports overage hours once the block is exhausted', async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const a = await seedBlockOrg({ partnerId, technicianId, entries: [{ minutes: 720 }] }); // 12 h

    const { hourBlock: dto } = await portalHourBlockForOrg({ orgId: a.orgId, asOf: AS_OF });
    expect(dto).toMatchObject({ usedHours: 12, remainingHours: 0, overageHours: 2 });
  });

  it('answers null for a paused or draft contract and for a retired line', async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const paused = await seedBlockOrg({ partnerId, technicianId, contractStatus: 'paused' });
    const draft = await seedBlockOrg({ partnerId, technicianId, contractStatus: 'draft' });
    const retired = await seedBlockOrg({ partnerId, technicianId, retired: true });

    for (const org of [paused, draft, retired]) {
      await expect(portalHourBlockForOrg({ orgId: org.orgId, asOf: AS_OF })).resolves.toEqual({ hourBlock: null, startsOn: null });
    }
  });
});
