/**
 * Effective-config resolution honours partner-wide policies for an
 * ORG-SCOPED caller (#3493).
 *
 * `resolveEffectiveConfig` has carried the correct dual-axis APP-layer
 * ownership predicate since #1724 (`org_id = device.org_id OR (org_id IS NULL
 * AND partner_id = org.partner_id)`). What it did not have was the second half
 * of the contract: RLS is STRICTER than the app layer. A partner-owned row is
 * gated by `breeze_has_partner_access(partner_id)`, and EVERY org-scoped
 * caller — which is exactly who opens a device's Effective Configuration tab —
 * carries `accessiblePartnerIds: []`. Under that context Postgres silently
 * drops every partner-owned policy row: no error, just zero rows. The
 * predicate reads as correct while the join resolves nothing, and a
 * partner-wide Monitoring policy appears never to reach the device.
 *
 * The fix is `withDevicePartnerPolicyVisibility` (services/configPolicyOwnership.ts)
 * around ONLY the policy join. It is the SAME-CONNECTION variant of
 * `withPartnerWideVisibility` on purpose: the preview/diff path passes an open
 * transaction holding uncommitted proposed assignments, and a system-context
 * escape would run on a second connection that cannot see them — so `current`
 * and `proposed` would disagree about whether a partner-wide policy exists.
 *
 * Why this file has to exist alongside the two suites that look like they
 * already cover it:
 *   - `configurationPolicyPartnerResolution.integration.test.ts` resolves under
 *     a SYSTEM-scope AuthContext AND inside `withSystemDbAccessContext`, so
 *     `breeze_has_partner_access` short-circuits true and the RLS half is never
 *     exercised at all.
 *   - `agentPolicyResolversPartnerWide.integration.test.ts` covers the four
 *     AGENT-side resolvers in routes/agents/helpers.ts, not this one, and only
 *     ever assigns at level `partner` — never the org-level assignment the
 *     reporter of #3493 actually used.
 * Every mocked unit suite is blind to this by construction: no RLS runs.
 *
 * Scope note: every case here goes through `resolveEffectiveConfig` /
 * `previewEffectiveConfig` rather than calling the visibility helper directly,
 * so each one regresses if the WIRING in resolveEffectiveConfigWithExecutor is
 * removed. The helper's own contract — that it widens by exactly one partner id
 * and never `*` — is pinned by configPolicyOwnership.test.ts; a test here that
 * called it directly would pass even with the wiring deleted.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  devices,
} from '../../db/schema';
import { resolveEffectiveConfig, previewEffectiveConfig } from '../../services/configurationPolicy';
import type { AuthContext } from '../../middleware/auth';
import { createPartner, createOrganization, createSite, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/**
 * The shape that reproduces the bug: an organization-scoped DB context.
 * `accessiblePartnerIds: []` is not incidental — it is what every org token,
 * portal session, and agent context carries, and it is what makes
 * `breeze_has_partner_access` false.
 */
function orgDbContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

/**
 * The matching app-layer AuthContext for an org-scoped user. `userId` must be a
 * REAL users row: previewEffectiveConfig stamps it into
 * `config_policy_assignments.assigned_by`, which carries an FK.
 */
function orgAuth(orgId: string, partnerId: string, userId: string): AuthContext {
  return {
    user: { id: userId, email: 'org@example.com', name: 'Org User', isPlatformAdmin: false },
    token: {} as never,
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: unknown) => eq(col as never, orgId),
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdDevices.length > 0) {
      await db.delete(devices).where(inArray(devices.id, createdDevices));
    }
    if (createdPolicies.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, createdPolicies));
    }
  });
  createdDevices.length = 0;
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
    createdDevices.push(d!.id);
    return d!;
  });
}

/**
 * A Monitoring policy with one enabled service watch — the reporter's exact
 * configuration. `checkIntervalSeconds` is carried through so an assertion can
 * prove WHICH policy resolved rather than merely that something did.
 */
async function seedMonitoringPolicy(
  owner: { orgId: string | null; partnerId: string | null },
  checkIntervalSeconds: number,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: `monitoring policy ${randomUUID()}`,
        status: 'active',
      })
      .returning();
    createdPolicies.push(policy!.id);
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'monitoring' })
      .returning();
    const [settings] = await db
      .insert(configPolicyMonitoringSettings)
      .values({ featureLinkId: link!.id, checkIntervalSeconds })
      .returning();
    await db.insert(configPolicyMonitoringWatches).values({
      settingsId: settings!.id,
      watchType: 'service',
      name: 'TestService',
      enabled: true,
    });
    return policy!.id;
  });
}

async function assign(
  configPolicyId: string,
  level: 'partner' | 'organization',
  targetId: string,
): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId, level, targetId, priority: 0 })
      .returning();
    return row!.id;
  });
}

describe('effective-config resolution under an ORG-SCOPED RLS context (#3493)', () => {
  it('resolves a partner-wide Monitoring policy assigned at the ORGANIZATION level', async () => {
    // The reporter's exact flow: create a partner-wide policy with one
    // Service & Monitoring item, then assign it to a single organization.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);

    const policyId = await seedMonitoringPolicy({ orgId: null, partnerId: partner.id }, 777);
    await assign(policyId, 'organization', org!.id);

    const result = await withDbAccessContext(orgDbContext(org!.id), () =>
      resolveEffectiveConfig(device.id, orgAuth(org!.id, partner.id, randomUUID())),
    );

    expect(result).not.toBeNull();
    // Before the fix this was `undefined`: the app-layer predicate matched,
    // RLS dropped the row, and the feature simply vanished from the result.
    expect(result!.features.monitoring).toBeDefined();
    expect(result!.features.monitoring!.sourcePolicyId).toBe(policyId);
    expect(result!.features.monitoring!.sourceLevel).toBe('organization');
    expect(result!.inheritanceChain.some((e) => e.policyId === policyId)).toBe(true);
  });

  it('fans out to every org of the partner from a single PARTNER-level assignment', async () => {
    // The partner-wide promise: one assignment, all orgs. Each org resolves
    // under its OWN org-scoped context, so this also proves the widening is
    // re-derived per device rather than leaking from a previous resolve.
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA!.id });
    const siteB = await createSite({ orgId: orgB!.id });
    const deviceA = await seedDevice(orgA!.id, siteA!.id);
    const deviceB = await seedDevice(orgB!.id, siteB!.id);

    const policyId = await seedMonitoringPolicy({ orgId: null, partnerId: partner.id }, 888);
    await assign(policyId, 'partner', partner.id);

    const resultA = await withDbAccessContext(orgDbContext(orgA!.id), () =>
      resolveEffectiveConfig(deviceA.id, orgAuth(orgA!.id, partner.id, randomUUID())),
    );
    const resultB = await withDbAccessContext(orgDbContext(orgB!.id), () =>
      resolveEffectiveConfig(deviceB.id, orgAuth(orgB!.id, partner.id, randomUUID())),
    );

    expect(resultA!.features.monitoring?.sourcePolicyId).toBe(policyId);
    expect(resultB!.features.monitoring?.sourcePolicyId).toBe(policyId);
  });

  it('restores the caller\'s partner visibility after the policy join', async () => {
    // The widening is a SET LOCAL on the caller's own transaction, so a leaked
    // value would silently outlive the resolve and widen every later read in
    // the same request. Assert the GUC is back to the org-scoped caller's
    // empty allowlist once resolution returns.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);

    const policyId = await seedMonitoringPolicy({ orgId: null, partnerId: partner.id }, 555);
    await assign(policyId, 'organization', org!.id);

    const after = await withDbAccessContext(orgDbContext(org!.id), async () => {
      const resolved = await resolveEffectiveConfig(device.id, orgAuth(org!.id, partner.id, randomUUID()));
      expect(resolved!.features.monitoring?.sourcePolicyId).toBe(policyId);
      const rows = await db.execute(
        sql`select current_setting('breeze.accessible_partner_ids', true) as ids`,
      );
      return (rows as unknown as Array<{ ids: string | null }>)[0]?.ids ?? null;
    });

    expect(after ?? '').toBe('');
  });

  it('keeps preview current/proposed consistent about a partner-wide policy', async () => {
    // previewEffectiveConfig resolves `proposed` through an OPEN TRANSACTION
    // holding uncommitted proposed assignments. That is why the fix uses the
    // same-connection widening: a `withPartnerWideVisibility`-style escape runs
    // on a SECOND pooled connection, which (a) cannot see this transaction's
    // uncommitted rows and (b) would not even retarget a query bound to `tx`.
    // Either way `current` would report the partner-wide policy present and
    // `proposed` would report it gone — a worse bug than the one being fixed.
    //
    // The proposed change here is an ORG-owned policy on purpose: an org-scoped
    // caller cannot INSERT an assignment for a partner-OWNED policy (RLS on
    // config_policy_assignments, 42501), so previewing a partner-wide ADD is a
    // partner-scoped operation and out of scope for this test.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);

    const user = await createUser({ partnerId: partner.id, orgId: org!.id });

    const partnerPolicyId = await seedMonitoringPolicy({ orgId: null, partnerId: partner.id }, 444);
    await assign(partnerPolicyId, 'organization', org!.id);
    const orgPolicyId = await seedMonitoringPolicy({ orgId: org!.id, partnerId: null }, 111);

    const preview = await withDbAccessContext(orgDbContext(org!.id), () =>
      previewEffectiveConfig(
        device.id,
        { add: [{ configPolicyId: orgPolicyId, level: 'device', targetId: device.id }] },
        orgAuth(org!.id, partner.id, user.id),
      ),
    );

    expect(preview).not.toBeNull();
    // current: the partner-wide policy is the only monitoring source (the fix).
    expect(preview!.current!.features.monitoring?.sourcePolicyId).toBe(partnerPolicyId);
    // proposed: the device-level org policy now wins...
    expect(preview!.proposed!.features.monitoring?.sourcePolicyId).toBe(orgPolicyId);
    // ...but the partner-wide policy must still be VISIBLE inside the
    // transaction. If the widening did not apply to `tx`, RLS would have
    // dropped it and this chain entry would be missing.
    expect(preview!.proposed!.inheritanceChain.some((e) => e.policyId === partnerPolicyId)).toBe(true);

    // Forced rollback really happened — the proposed assignment never persisted.
    const persisted = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, orgPolicyId)),
    );
    expect(persisted).toHaveLength(0);
  });
});
