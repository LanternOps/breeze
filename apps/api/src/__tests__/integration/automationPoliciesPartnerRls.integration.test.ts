/**
 * automation_policies RLS — dual-axis (org OR partner) enforcement (#2129, epic #2135).
 *
 * Migration under test: 2026-07-01-automation-policies-partner-ownership.sql.
 *
 * An automation policy (the config-policy "compliance" feature's rule-set
 * table) is owned by EITHER an org (org_id set, partner_id NULL — the original
 * shape) OR a partner (partner_id set, org_id NULL — partner-wide / "all
 * orgs"). Per-device results (automation_policy_compliance) have no ownership
 * columns and stay device-join — each result row belongs to the device's own
 * org. Same dual-axis contract-test blindspot as the sibling suites: this
 * functional test through the REAL postgres.js driver (breeze_app role) is the
 * guard that a partner cannot forge a partner_id for another partner.
 *
 * The second describe block proves the evaluation fan-out (#1724 trap): a
 * stored partner-wide policy must actually EVALUATE devices across every org
 * under the owning partner — resolveTargetDevices is mocked away in every
 * unit test, so this is the only place the real query shape is proven.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { automationPolicies, automationPolicyCompliance, devices, sites } from '../../db/schema';
import { evaluatePolicy } from '../../services/policyEvaluationService';
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
        .delete(automationPolicyCompliance)
        .where(inArray(automationPolicyCompliance.policyId, createdPolicies));
    }
    for (const id of createdPolicies) {
      await db.delete(automationPolicies).where(eq(automationPolicies.id, id));
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
  name: 'Partner-wide compliance baseline',
  targets: { targetType: 'all', targetIds: [] },
  rules: [{ type: 'prohibited_software', softwareName: 'BitTorrent' }],
  enforcement: 'monitor' as const,
};

async function seedPartnerPolicy(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(automationPolicies)
      .values({ ...BASE_POLICY, orgId: null, partnerId })
      .returning(),
  );
  const id = rows[0]!.id;
  createdPolicies.push(id);
  return id;
}

describe('automation_policies RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide policy (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(automationPolicies)
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
      db.select({ id: automationPolicies.id }).from(automationPolicies).where(eq(automationPolicies.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the cross-partner forge (Postgres 42501 on the cause).
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(automationPolicies)
          .values({ ...BASE_POLICY, name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide policy owned by its partner (evaluation still covers its devices via the worker)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerPolicy(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: automationPolicies.id }).from(automationPolicies).where(eq(automationPolicies.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('org scope can still INSERT and SELECT an org-scoped policy (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(automationPolicies)
        .values({ ...BASE_POLICY, name: 'Org policy', orgId: org.id, partnerId: null })
        .returning(),
    );
    if (inserted[0]) createdPolicies.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: automationPolicies.id })
        .from(automationPolicies)
        .where(eq(automationPolicies.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('the one-owner CHECK rejects a policy that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(automationPolicies)
          .values({ ...BASE_POLICY, name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(automationPolicies)
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
        .update(automationPolicies)
        .set({ name: 'Renamed baseline', enabled: false })
        .where(eq(automationPolicies.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.enabled).toBe(false);

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.delete(automationPolicies).where(eq(automationPolicies.id, id)).returning(),
    );
    expect(deleted).toHaveLength(1);
    createdPolicies.splice(createdPolicies.indexOf(id), 1);
  });
});

// ============================================================
// Evaluation fan-out (#2129): the load-bearing SQL that makes a stored
// partner-wide policy actually EVALUATE. resolveTargetDevices previously
// filtered every branch by eq(devices.orgId, policy.orgId), which silently
// matched ZERO devices for org_id NULL — the #1724 trap. Unit tests mock the
// resolution away, so this is the only proof against real Postgres.
// ============================================================

describe('evaluatePolicy — partner-wide evaluation fan-out (#2129)', () => {
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

  it('a partner-wide policy evaluates devices in EVERY member org; result rows land on the devices, not the policy owner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA1 = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
    const orgB1 = await createOrganization({ partnerId: partnerB.id });

    const deviceA1 = await seedDevice(orgA1.id, 'fanout-a1');
    const deviceA2 = await seedDevice(orgA2.id, 'fanout-a2');
    const deviceB1 = await seedDevice(orgB1.id, 'fanout-b1');

    const policyId = await seedPartnerPolicy(partnerA.id);
    const [policy] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(automationPolicies).where(eq(automationPolicies.id, policyId)),
    );

    // The worker evaluates under system context (RLS bypass) — mirror that.
    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      evaluatePolicy(policy!, { source: 'integration-test', requestRemediation: false }),
    );

    const evaluatedIds = result.results.map((r) => r.deviceId);
    expect(evaluatedIds).toContain(deviceA1); // fan-out reaches org A1
    expect(evaluatedIds).toContain(deviceA2); // ...and org A2
    expect(evaluatedIds).not.toContain(deviceB1); // another partner's device NEVER matches

    // Result child rows exist for both member-org devices. The child table has
    // no ownership columns — each row reaches its tenant via the DEVICE join,
    // so the device's own org admin sees their compliance results.
    const complianceRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ deviceId: automationPolicyCompliance.deviceId })
        .from(automationPolicyCompliance)
        .where(eq(automationPolicyCompliance.policyId, policyId)),
    );
    const complianceDeviceIds = complianceRows.map((r) => r.deviceId);
    expect(complianceDeviceIds).toContain(deviceA1);
    expect(complianceDeviceIds).toContain(deviceA2);
    expect(complianceDeviceIds).not.toContain(deviceB1);

    // The org-scope caller of a member org can read ITS device's result row
    // (device-join RLS) even though the policy template itself is invisible.
    const orgVisibleRows = await withDbAccessContext(orgContext(orgA1.id), () =>
      db
        .select({ deviceId: automationPolicyCompliance.deviceId })
        .from(automationPolicyCompliance)
        .where(eq(automationPolicyCompliance.policyId, policyId)),
    );
    expect(orgVisibleRows.map((r) => r.deviceId)).toEqual([deviceA1]);
  });

  it('an org-owned policy still evaluates only its own org (unchanged shape)', async () => {
    const partner = await createPartner();
    const org1 = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });

    const device1 = await seedDevice(org1.id, 'org-scope-1');
    const device2 = await seedDevice(org2.id, 'org-scope-2');

    const inserted = await withDbAccessContext(orgContext(org1.id), () =>
      db
        .insert(automationPolicies)
        .values({ ...BASE_POLICY, name: 'Org-owned baseline', orgId: org1.id, partnerId: null })
        .returning(),
    );
    createdPolicies.push(inserted[0]!.id);

    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      evaluatePolicy(inserted[0]!, { source: 'integration-test', requestRemediation: false }),
    );

    const evaluatedIds = result.results.map((r) => r.deviceId);
    expect(evaluatedIds).toContain(device1);
    expect(evaluatedIds).not.toContain(device2);
  });
});
