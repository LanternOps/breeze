/**
 * Automation worker SUBSET resolution — partner re-clamp (#2286, sibling of
 * the patch-scheduler fix in PR #2285 / #2280 review).
 *
 * `resolveDeviceIdsForAssignment` (apps/api/src/jobs/automationWorker.ts)
 * resolves which devices a config-policy automation assignment targets. For a
 * partner-owned policy (policyOrgId null) carrying an org/site/group/device
 * SUBSET assignment, the target org was only verified to belong to the
 * policy's partner at ASSIGN time (validateAssignmentTarget). If that org is
 * later reparented to a different partner, the stale assignment row would
 * otherwise keep resolving those devices — a TOCTOU hole. The fix threads the
 * policy's partnerId into resolution and re-verifies it on every run via an
 * inner join on organizations, the same re-verification the partner-wide
 * 'partner' level branch already does for assignmentTargetId.
 *
 * The unit suite (automationWorker.resolveAssignment.test.ts) proves the query
 * SHAPE (join + where args) against a mocked db. This proves the join actually
 * ENFORCES the clamp against real Postgres — per the CLAUDE.md config-policy
 * partner-wide playbook item 5, a worker's partner-wide fan-out must be
 * proven against real Postgres, not just asserted at the mock layer.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  devices,
  organizations,
} from '../../db/schema';
import { __testOnly } from '../../jobs/automationWorker';
import { createPartner, createOrganization, createSite } from './db-utils';

const { resolveDeviceIdsForAssignment } = __testOnly;

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdPolicies: string[] = [];

afterEach(async () => {
  if (createdPolicies.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
  createdPolicies.length = 0;
});

async function seedDevice(orgId: string, siteId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning();
    return d!;
  });
}

/** Partner-owned (org_id NULL) policy with an 'automation' feature link — the #2280 library shape. */
async function seedPartnerAutomationPolicy(partnerId: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId, name: 'Partner-wide automation library policy', status: 'active' })
      .returning();
    createdPolicies.push(policy!.id);
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'automation',
      inlineSettings: {},
    });
    return policy!.id;
  });
}

async function assignOrg(policyId: string, orgId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policyId,
      level: 'organization',
      targetId: orgId,
      priority: 0,
    });
  });
}

describe('automation worker SUBSET resolution — partner re-clamp (#2286)', () => {
  it('resolves an org-level SUBSET assignment on a partner-owned policy to ONLY the assigned org, not a sibling org (fan-out contract)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA!.id });
    const siteB = await createSite({ orgId: orgB!.id });
    const deviceA = await seedDevice(orgA!.id, siteA!.id);
    await seedDevice(orgB!.id, siteB!.id); // sibling org under the SAME partner — must NOT resolve

    const policyId = await seedPartnerAutomationPolicy(partner.id);
    // Subset assignment: organization level, org A only — deliberately no
    // assignment for org B, so org B has nothing pointing at this policy.
    await assignOrg(policyId, orgA!.id);

    const ids = await withSystemDbAccessContext(() =>
      resolveDeviceIdsForAssignment('organization', orgA!.id, null, partner.id)
    );

    expect(ids).toEqual([deviceA.id]);
  });

  it('stops resolving a SUBSET assignment once its org is reparented to a different partner (TOCTOU re-clamp)', async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);

    const policyId = await seedPartnerAutomationPolicy(partner.id);
    await assignOrg(policyId, org!.id);

    // Sanity check: resolves normally while the org still belongs to the
    // policy's partner.
    const before = await withSystemDbAccessContext(() =>
      resolveDeviceIdsForAssignment('organization', org!.id, null, partner.id)
    );
    expect(before).toEqual([device.id]);

    // Reparenting the org while the partner policy's SUBSET assignment still
    // targets it is rejected at the DB layer (assignment-target integrity
    // triggers, 2026-07-28/29 migrations): the stale-assignment state the
    // original TOCTOU exploited is unrepresentable.
    let reparentError: unknown;
    try {
      await withDbAccessContext(SYSTEM_CTX, async () => {
        await db
          .update(organizations)
          .set({ partnerId: otherPartner.id })
          .where(eq(organizations.id, org!.id));
      });
    } catch (err) {
      reparentError = err;
    }
    const rootMessage = String(
      (reparentError as { cause?: { message?: string } } | undefined)?.cause?.message
        ?? (reparentError as Error | undefined)?.message,
    );
    expect(rootMessage).toMatch(/incompatible with the policy owner/);

    // Clear the assignment and reparent for real. Separate transactions: the
    // assignment delete takes org-level partner-export locks while the
    // reparent takes partner-level locks, and the lock hierarchy forbids
    // partner-after-org within one transaction.
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db
        .delete(configPolicyAssignments)
        .where(eq(configPolicyAssignments.targetId, org!.id));
    });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db
        .update(organizations)
        .set({ partnerId: otherPartner.id })
        .where(eq(organizations.id, org!.id));
    });

    const after = await withSystemDbAccessContext(() =>
      resolveDeviceIdsForAssignment('organization', org!.id, null, partner.id)
    );

    // The resolution join must still re-clamp by partner: no devices resolve
    // for the policy's now-stale partner.
    expect(after).toEqual([]);
  });
});
