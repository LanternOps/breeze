/**
 * peripheral_policies RLS — dual-axis (org OR partner) enforcement
 * (#2131, epic #2135).
 *
 * Migration under test: 2026-07-01-peripheral-policies-partner-ownership.sql.
 *
 * A peripheral policy is owned by EITHER an org (org_id set, partner_id NULL)
 * OR a partner (partner_id set, org_id NULL — partner-wide / "all orgs").
 * peripheral_events stay owned by the reporting DEVICE's org. Same dual-axis
 * contract-test blindspot as the sibling suites: this functional test through
 * the REAL postgres.js driver (breeze_app role) is the guard that a partner
 * cannot forge a partner_id for another partner.
 *
 * The second describe block proves the distribution fan-out (#1724 trap): the
 * org-keyed distribution worker's policy set previously filtered
 * eq(peripheralPolicies.orgId, data.orgId), so a stored partner-wide policy
 * would silently never reach any agent.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceCommands, devices, peripheralPolicies, sites } from '../../db/schema';
import { processPolicyDistribution } from '../../jobs/peripheralJobs';
import { createOrganization, createPartner } from './db-utils';

const createdPolicies: string[] = [];
const createdDevices: string[] = [];
const createdSites: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (createdPolicies.length === 0 && createdDevices.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdDevices.length > 0) {
      await db.delete(deviceCommands).where(inArray(deviceCommands.deviceId, createdDevices));
    }
    for (const id of createdPolicies) {
      await db.delete(peripheralPolicies).where(eq(peripheralPolicies.id, id));
    }
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdSites) {
      await db.delete(sites).where(eq(sites.id, id));
    }
  });
  createdPolicies.length = 0;
  createdDevices.length = 0;
  createdSites.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const BASE_POLICY = {
  name: 'Partner-wide USB block',
  deviceClass: 'storage' as const,
  action: 'block' as const,
  targetType: 'organization' as const,
  targetIds: {},
  exceptions: [],
  isActive: true,
};

async function seedPartnerPolicy(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(peripheralPolicies)
      .values({ ...BASE_POLICY, orgId: null, partnerId })
      .returning(),
  );
  const id = rows[0]!.id;
  createdPolicies.push(id);
  return id;
}

describe('peripheral_policies RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide policy (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(peripheralPolicies)
        .values({ ...BASE_POLICY, orgId: null, partnerId: partner.id })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) createdPolicies.push(rows[0].id);
  });

  it('a different partner can neither see nor forge a policy attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerPolicy(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: peripheralPolicies.id }).from(peripheralPolicies).where(eq(peripheralPolicies.id, id)),
    );
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(peripheralPolicies)
          .values({ ...BASE_POLICY, name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide policy owned by its partner (agents still receive it via distribution)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerPolicy(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: peripheralPolicies.id }).from(peripheralPolicies).where(eq(peripheralPolicies.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('org scope can still INSERT and SELECT an org-scoped policy (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(peripheralPolicies)
        .values({ ...BASE_POLICY, name: 'Org policy', orgId: org.id, partnerId: null })
        .returning(),
    );
    if (inserted[0]) createdPolicies.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: peripheralPolicies.id })
        .from(peripheralPolicies)
        .where(eq(peripheralPolicies.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('the one-owner CHECK rejects a policy that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(peripheralPolicies)
          .values({ ...BASE_POLICY, name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(peripheralPolicies)
          .values({ ...BASE_POLICY, name: 'No axis', orgId: null, partnerId: null })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner scope can UPDATE and DELETE its own partner-wide policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(peripheralPolicies)
        .set({ name: 'Renamed USB block', isActive: false })
        .where(eq(peripheralPolicies.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.isActive).toBe(false);

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.delete(peripheralPolicies).where(eq(peripheralPolicies.id, id)).returning(),
    );
    expect(deleted).toHaveLength(1);
    createdPolicies.splice(createdPolicies.indexOf(id), 1);
  });
});

// ============================================================
// Distribution fan-out (#2131): the load-bearing SQL that makes a stored
// partner-wide policy actually reach agents. The org-keyed distribution
// worker previously selected eq(peripheralPolicies.orgId, data.orgId), which
// silently excluded org_id NULL rows — the #1724 trap.
// ============================================================

describe('processPolicyDistribution — partner-wide policy fan-out (#2131)', () => {
  async function seedDevice(orgId: string, hostname: string): Promise<string> {
    const [site] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(sites).values({ orgId, name: 'HQ' }).returning(),
    );
    createdSites.push(site!.id);
    const [device] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(devices)
        .values({
          orgId,
          siteId: site!.id,
          agentId: `agent-${site!.id.slice(0, 18)}`,
          hostname,
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning(),
    );
    createdDevices.push(device!.id);
    return device!.id;
  }

  function payloadPolicyIds(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') return [];
    const policies = (payload as { policies?: Array<{ id?: string }> }).policies;
    if (!Array.isArray(policies)) return [];
    return policies.map((p) => p.id).filter((id): id is string => typeof id === 'string');
  }

  it("a member org's distribution payload includes its partner's partner-wide policy but NOT a foreign partner's", async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const deviceA = await seedDevice(orgA.id, 'usb-fanout-a');

    const partnerWideA = await seedPartnerPolicy(partnerA.id);
    const partnerWideB = await seedPartnerPolicy(partnerB.id);

    // An org-owned policy coexists on the same org.
    const [orgPolicy] = await withDbAccessContext(orgContext(orgA.id), () =>
      db
        .insert(peripheralPolicies)
        .values({ ...BASE_POLICY, name: 'Org-owned USB block', orgId: orgA.id, partnerId: null })
        .returning(),
    );
    createdPolicies.push(orgPolicy!.id);

    // The distribution worker runs under system context — mirror that.
    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      processPolicyDistribution({
        type: 'policy-distribution',
        orgId: orgA.id,
        changedPolicyIds: [partnerWideA],
        reason: 'integration-test',
        queuedAt: new Date().toISOString(),
      }),
    );
    expect(result.queued).toBe(1);

    const commands = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ payload: deviceCommands.payload })
        .from(deviceCommands)
        .where(eq(deviceCommands.deviceId, deviceA)),
    );
    expect(commands.length).toBeGreaterThan(0);

    const distributedIds = payloadPolicyIds(commands[commands.length - 1]!.payload);
    expect(distributedIds).toContain(partnerWideA); // partner-wide policy reaches the member org's devices
    expect(distributedIds).toContain(orgPolicy!.id); // org-owned policy still distributed
    expect(distributedIds).not.toContain(partnerWideB); // another partner's policy NEVER leaks in
  });
});
