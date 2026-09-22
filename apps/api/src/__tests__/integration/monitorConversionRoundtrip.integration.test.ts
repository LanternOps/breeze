import './setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { configurationPolicies, configPolicyAssignments, configPolicyFeatureLinks, devices } from '../../db/schema';
import { resolveDeviceIdsForPolicy } from '../../services/monitors/conversion/legacyBaseline';
import { previewPolicyConversion } from '../../services/monitors/conversion';
import { createSystemAuthContext } from '../../services/featureConfigResolver';
import { createOrganization, createPartner, createSite } from './db-utils';

// Task 18 supplies the shared conversionFixture; this scope-only fixture keeps
// the inherited-consumer regression executable before that task lands.
async function inheritedScopeFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const context: DbAccessContext = {
    scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id],
    accessiblePartnerIds: [], currentPartnerId: partner.id, userId: null,
  };
  return withDbAccessContext(context, async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org.id, partnerId: null, name: 'Legacy parent', status: 'active', createdBy: null,
    }).returning();
    await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'alert_rule' });
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `agent-${randomUUID()}`, hostname: 'scope-fixture',
      osType: 'windows', osVersion: '1.0', architecture: 'amd64', agentVersion: '1.0.0',
      status: 'online', deviceRole: 'server',
    }).returning();
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'organization', targetId: org.id,
      roleFilter: ['server'], osFilter: ['windows'],
    });
    return { context, partnerId: partner.id, orgId: org.id, policyId: policy!.id, deviceId: device!.id };
  });
}

it('checks a parent with no direct assignment through its assigned inheriting child', async () => {
  const f = await inheritedScopeFixture();
  await withDbAccessContext(f.context, async () => {
    const [child] = await db.insert(configurationPolicies).values({ orgId: f.orgId, partnerId: null,
      name: 'Inheriting child', parentPolicyId: f.policyId, status: 'active', createdBy: null }).returning();
    await db.update(configPolicyAssignments).set({ configPolicyId: child!.id })
      .where(eq(configPolicyAssignments.configPolicyId, f.policyId));
    expect(await resolveDeviceIdsForPolicy(f.policyId, db)).toContain(f.deviceId);
  });
});

/**
 * The conversion entry points are SELF-MANAGED routes (D30, #6416): the request
 * middleware opens no context for them, so everything they read before their
 * own isolated transaction runs with NO ambient context — and a contextless
 * read is DENIED by RLS, not bypassed. Without a caller-scoped context around
 * those pre-reads, `authorizePreview` finds nothing and every preview answers
 * `policy_not_found`, which is what shipped in #6416.
 */
it('previews from a caller that holds no ambient DB context (self-managed route)', async () => {
  const f = await inheritedScopeFixture();
  const auth = { ...createSystemAuthContext(), scope: 'organization' as const,
    orgId: f.orgId, accessibleOrgIds: [f.orgId], partnerId: f.partnerId,
    canAccessOrg: (id: string) => id === f.orgId };

  const preview = await previewPolicyConversion(f.policyId, auth, { mode: 'inline' });
  if ('status' in preview) throw new Error(`Unexpected preview status: ${preview.status}`);
  expect(preview.policyId ?? f.policyId).toBe(f.policyId);

  // Control, the other half of D30: holding a context is what the self-managed
  // listing exists to prevent, so the same call from inside one is refused
  // rather than quietly taking a second pooled connection.
  await expect(withDbAccessContext(f.context, () => previewPolicyConversion(f.policyId, auth, { mode: 'inline' })))
    .rejects.toThrow(/SELF_MANAGED_DB_CONTEXT_ROUTES/);
});
