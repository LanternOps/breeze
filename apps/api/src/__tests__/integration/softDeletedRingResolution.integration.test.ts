/**
 * Soft-deleted update ring resolution (#8678).
 *
 * `DELETE /update-rings/:id` is a soft delete (patch_policies.enabled=false).
 * Config-policy patch links that still point at the ring must treat it as an
 * invalid reference instead of silently keeping its approval/app rules live:
 *
 *  1. resolvePatchPolicyReference -> 'disabled_ring' / valid=false / no rules,
 *     and loadPolicyLocalPatchConfig surfaces ring.valid=false (the ring is
 *     soft-deleted through the REAL route, so the DELETE -> resolver seam is
 *     covered, with a pre-delete 'valid_ring' control).
 *  2. validateFeaturePolicyExists('patch', ...) refuses a disabled ring.
 *  3. Repair seam: a link with legacy inline `apps` rules on a disabled ring
 *     can only be repointed onto a ring that enforces exactly those rules
 *     (RING_LACKS_POLICY_APP_RULES otherwise).
 *
 * Fixtures are seeded through the superuser getTestDb(); setup.ts truncates
 * between tests, so every case seeds its own.
 *
 * Run:
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/softDeletedRingResolution.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { withSystemDbAccessContext } from '../../db';
import { configPolicyFeatureLinks, configurationPolicies, patchPolicies } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { authMiddleware } from '../../middleware/auth';
import { updateRingRoutes } from '../../routes/updateRings';
import { loadPolicyLocalPatchConfig, resolvePatchPolicyReference } from '../../services/configPolicyPatching';
import { updateFeatureLink, validateFeaturePolicyExists } from '../../services/configurationPolicy';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const firefoxBlock = { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' } as const;

async function seed(opts: { ringRules?: unknown[] } = {}) {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const tdb = getTestDb();
  const partnerId = env.partner.id;
  const orgId = env.organization.id;
  const [policy] = await tdb
    .insert(configurationPolicies)
    .values({ orgId, name: `soft-delete-policy-${Date.now()}` })
    .returning({ id: configurationPolicies.id });
  const ringId = await seedRing(partnerId, 'Ring to delete', opts.ringRules ?? [firefoxBlock]);
  return { env, partnerId, orgId, configPolicyId: policy!.id, ringId };
}

async function seedRing(partnerId: string, name: string, appRules: unknown[], enabled = true) {
  const [row] = await getTestDb()
    .insert(patchPolicies)
    .values({ partnerId, kind: 'ring', name, appRules, enabled } as typeof patchPolicies.$inferInsert)
    .returning({ id: patchPolicies.id });
  return row!.id;
}

async function seedLink(configPolicyId: string, ringId: string | null, inline: Record<string, unknown> = { sources: ['os'] }) {
  const [row] = await getTestDb()
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId, featureType: 'patch', featurePolicyId: ringId, inlineSettings: inline })
    .returning({ id: configPolicyFeatureLinks.id });
  return row!.id;
}

async function linkTarget(linkId: string) {
  const [row] = await getTestDb()
    .select({ ref: configPolicyFeatureLinks.featurePolicyId })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, linkId));
  return row!.ref;
}

async function deleteRingViaRoute(env: Awaited<ReturnType<typeof setupTestEnvironment>>, ringId: string) {
  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/update-rings', updateRingRoutes);
  const res = await app.request(`/update-rings/${ringId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
}

describe('soft-deleted update ring resolution (#8678)', () => {
  runDb('DELETE /update-rings/:id turns the ring into an invalid reference for resolver and policy-local config', async () => {
    const { env, partnerId, configPolicyId, ringId } = await seed();
    await seedLink(configPolicyId, ringId);

    // Control: before the delete the same call resolves the ring.
    const before = await withSystemDbAccessContext(() => resolvePatchPolicyReference(partnerId, ringId));
    expect(before.classification).toBe('valid_ring');
    expect(before.valid).toBe(true);
    expect(before.appRules).toHaveLength(1);

    await deleteRingViaRoute(env, ringId);
    const [row] = await getTestDb().select({ enabled: patchPolicies.enabled }).from(patchPolicies).where(eq(patchPolicies.id, ringId));
    expect(row!.enabled).toBe(false);

    const after = await withSystemDbAccessContext(() => resolvePatchPolicyReference(partnerId, ringId));
    expect(after.classification).toBe('disabled_ring');
    expect(after.valid).toBe(false);
    expect(after.ringId).toBeNull();
    expect(after.appRules).toEqual([]);

    const local = await withSystemDbAccessContext(() => loadPolicyLocalPatchConfig(configPolicyId));
    expect(local).not.toBeNull();
    expect(local!.ring.valid).toBe(false);
  });

  runDb('validateFeaturePolicyExists refuses a disabled ring and accepts an enabled one', async () => {
    const { partnerId, orgId, ringId } = await seed();
    const disabledId = await seedRing(partnerId, 'Disabled ring', [], false);
    const owner = { orgId, partnerId: null };

    const ok = await withSystemDbAccessContext(() => validateFeaturePolicyExists('patch', ringId, owner));
    expect(ok.valid).toBe(true);

    const refused = await withSystemDbAccessContext(() => validateFeaturePolicyExists('patch', disabledId, owner));
    expect(refused.valid).toBe(false);
    expect(refused.error).toMatch(/deleted or disabled/);
  });

  runDb('repointing a legacy-rules link off a disabled ring requires a ring enforcing exactly those rules', async () => {
    const { partnerId, configPolicyId } = await seed();
    const disabledId = await seedRing(partnerId, 'Disabled ring', [], false);
    const emptyRing = await seedRing(partnerId, 'Enabled, no rules', []);
    const matchingRing = await seedRing(partnerId, 'Enabled, same rules', [firefoxBlock]);
    const linkId = await seedLink(configPolicyId, disabledId, { sources: ['os', 'third_party'], apps: [firefoxBlock] });

    await expect(
      withSystemDbAccessContext(() => updateFeatureLink(linkId, { featurePolicyId: emptyRing }, configPolicyId)),
    ).rejects.toMatchObject({ code: 'RING_LACKS_POLICY_APP_RULES' });
    expect(await linkTarget(linkId)).toBe(disabledId);

    // Control: a ring that enforces the legacy rules is an accepted repair.
    await withSystemDbAccessContext(() => updateFeatureLink(linkId, { featurePolicyId: matchingRing }, configPolicyId));
    expect(await linkTarget(linkId)).toBe(matchingRing);
  });
});
