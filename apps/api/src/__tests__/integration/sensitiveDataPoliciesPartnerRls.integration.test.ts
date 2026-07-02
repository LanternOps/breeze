/**
 * sensitive_data_policies RLS — dual-axis (org OR partner) enforcement
 * (#2131, epic #2135).
 *
 * Migration under test: 2026-07-01-sensitive-data-policies-partner-ownership.sql.
 *
 * A sensitive-data policy is owned by EITHER an org (org_id set, partner_id
 * NULL) OR a partner (partner_id set, org_id NULL — partner-wide / "all
 * orgs"). Scans and findings stay owned by the scanned DEVICE's org. Same
 * dual-axis contract-test blindspot as the sibling suites: this functional
 * test through the REAL postgres.js driver (breeze_app role) is the guard
 * that a partner cannot forge a partner_id for another partner.
 *
 * The second describe block proves the scheduler fan-out (#1724 trap): a
 * stored partner-wide policy must actually queue scans for devices across
 * every org under the owning partner, with each scan row carrying the
 * DEVICE's org.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, sensitiveDataPolicies, sensitiveDataScans, sites } from '../../db/schema';
import { schedulePolicyScans, shutdownSensitiveDataWorkers } from '../../jobs/sensitiveDataJobs';
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
    if (createdPolicies.length > 0) {
      await db
        .delete(sensitiveDataScans)
        .where(inArray(sensitiveDataScans.policyId, createdPolicies));
    }
    for (const id of createdPolicies) {
      await db.delete(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id));
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
  // The scheduler touches the BullMQ queue; close any lazily-created
  // connection so the vitest process can exit cleanly.
  await shutdownSensitiveDataWorkers();
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
  name: 'Partner-wide PII sweep',
  scope: {},
  detectionClasses: ['pii', 'credential'],
  isActive: true,
};

async function seedPartnerPolicy(partnerId: string, schedule: Record<string, unknown> | null = null): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(sensitiveDataPolicies)
      .values({ ...BASE_POLICY, schedule, orgId: null, partnerId })
      .returning(),
  );
  const id = rows[0]!.id;
  createdPolicies.push(id);
  return id;
}

describe('sensitive_data_policies RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide policy (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(sensitiveDataPolicies)
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
      db.select({ id: sensitiveDataPolicies.id }).from(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id)),
    );
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(sensitiveDataPolicies)
          .values({ ...BASE_POLICY, name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide policy owned by its partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerPolicy(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: sensitiveDataPolicies.id }).from(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('org scope can still INSERT and SELECT an org-scoped policy (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(sensitiveDataPolicies)
        .values({ ...BASE_POLICY, name: 'Org policy', orgId: org.id, partnerId: null })
        .returning(),
    );
    if (inserted[0]) createdPolicies.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: sensitiveDataPolicies.id })
        .from(sensitiveDataPolicies)
        .where(eq(sensitiveDataPolicies.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('the one-owner CHECK rejects a policy that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(sensitiveDataPolicies)
          .values({ ...BASE_POLICY, name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(sensitiveDataPolicies)
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
        .update(sensitiveDataPolicies)
        .set({ name: 'Renamed sweep', isActive: false })
        .where(eq(sensitiveDataPolicies.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.isActive).toBe(false);

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.delete(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id)).returning(),
    );
    expect(deleted).toHaveLength(1);
    createdPolicies.splice(createdPolicies.indexOf(id), 1);
  });
});

// ============================================================
// Scheduler fan-out (#2131): the load-bearing SQL that makes a stored
// partner-wide policy actually queue scans. The producer previously targeted
// devices via eq(devices.orgId, policy.orgId), which silently matched ZERO
// devices for org_id NULL — the #1724 trap.
// ============================================================

describe('schedulePolicyScans — partner-wide scan fan-out (#2131)', () => {
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

  it('a partner-wide policy queues scans for devices in EVERY member org, each scan carrying the DEVICE org', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA1 = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
    const orgB1 = await createOrganization({ partnerId: partnerB.id });

    const deviceA1 = await seedDevice(orgA1.id, 'sd-fanout-a1');
    const deviceA2 = await seedDevice(orgA2.id, 'sd-fanout-a2');
    const deviceB1 = await seedDevice(orgB1.id, 'sd-fanout-b1');

    const policyId = await seedPartnerPolicy(partnerA.id, { enabled: true, type: 'interval', intervalMinutes: 60 });
    const [policy] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, policyId)),
    );

    // The scheduler runs under system context (RLS bypass) — mirror that.
    const queued = await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(policy!, new Date()));
    expect(queued).toBe(2);

    const scanRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ deviceId: sensitiveDataScans.deviceId, orgId: sensitiveDataScans.orgId })
        .from(sensitiveDataScans)
        .where(eq(sensitiveDataScans.policyId, policyId)),
    );

    const byDevice = new Map(scanRows.map((row) => [row.deviceId, row.orgId]));
    expect(byDevice.get(deviceA1)).toBe(orgA1.id); // scan row takes the DEVICE's org
    expect(byDevice.get(deviceA2)).toBe(orgA2.id);
    expect(byDevice.has(deviceB1)).toBe(false); // another partner's device NEVER matches
  });

  it('an org-owned policy still queues scans only for its own org (unchanged shape)', async () => {
    const partner = await createPartner();
    const org1 = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });

    const device1 = await seedDevice(org1.id, 'sd-org-1');
    await seedDevice(org2.id, 'sd-org-2');

    const inserted = await withDbAccessContext(orgContext(org1.id), () =>
      db
        .insert(sensitiveDataPolicies)
        .values({
          ...BASE_POLICY,
          name: 'Org-owned sweep',
          schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
          orgId: org1.id,
          partnerId: null,
        })
        .returning(),
    );
    createdPolicies.push(inserted[0]!.id);

    const queued = await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(inserted[0]!, new Date()));
    expect(queued).toBe(1);

    const scanRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ deviceId: sensitiveDataScans.deviceId })
        .from(sensitiveDataScans)
        .where(eq(sensitiveDataScans.policyId, inserted[0]!.id)),
    );
    expect(scanRows.map((r) => r.deviceId)).toEqual([device1]);
  });
});
