/**
 * #6960 W02 — a PARTNER-WIDE security_agents link (Huntress) fanned out across
 * a partner's orgs, on real Postgres as breeze_app.
 *
 * Fixture: partner P with an active Huntress integration (account key set) and
 *   org A — mapped, org key present   → device dA gets the install
 *   org B — mapped, NO org key        → dB not applicable (org_key_missing)
 *   org C — not mapped                → dC not applicable (org_not_mapped)
 * and partner Q with org Z / device dZ, which must never be touched.
 * One partner-wide config policy, assigned at partner level, enables Huntress;
 * its software policy is generated through addFeatureLink (the generator).
 *
 * Proves: the managed device set (and the batched resolver matches the
 * per-device one); a compliance pass queues ONLY dA and records no violation
 * and no attempt for dB/dC; dispatch creates exactly one deployment, for dA,
 * with the per-org keys substituted; a stale job for a now-unready org creates
 * none; a closer opt-out link cancels a queued install; and the partner-owned
 * generated row is SELECT-only to an org-scoped session of its own partner and
 * invisible to another partner.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityAgentsPartnerRls.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  huntressIntegrations,
  huntressOrgMappings,
  softwareCatalog,
  softwareComplianceStatus,
  softwareDeployments,
  softwarePolicies,
} from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { addFeatureLink, updateFeatureLink } from '../../services/configurationPolicy';
import { repairManagedSoftwarePolicies } from '../../services/securityAgents/managedPolicyGenerator';
import {
  resolveDeviceIdsForSoftwarePolicy,
  resolveSecurityAgentsLinkForDevice,
  resolveSecurityAgentsLinksForDevices,
} from '../../services/featureConfigResolver';
import { processCheckPolicy } from '../../jobs/softwareComplianceWorker';
import { processRemediateDeviceInstall } from '../../jobs/softwareRemediationWorker';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const ACCT_KEY = 'ACCTKEY-TEST-0001';
const ORG_KEY_A = 'ORGKEY-A-TEST-0001';
const ENABLED = { version: 1, agents: [{ vendor: 'huntress', enabled: true }] };

function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function seed() {
  const p = await createPartner();
  const q = await createPartner();
  const orgs = {
    a: await createOrganization({ partnerId: p.id }),
    b: await createOrganization({ partnerId: p.id }),
    c: await createOrganization({ partnerId: p.id }),
    z: await createOrganization({ partnerId: q.id }),
  };
  const dev: Record<'a' | 'b' | 'c' | 'z', string> = { a: '', b: '', c: '', z: '' };
  for (const key of ['a', 'b', 'c', 'z'] as const) {
    const site = await createSite({ orgId: orgs[key].id });
    dev[key] = (await createDevice({ orgId: orgs[key].id, siteId: site.id })).id;
  }

  return withSystemDbAccessContext(async () => {
    const [integration] = await db.insert(huntressIntegrations).values({
      partnerId: p.id,
      name: 'Huntress (test)',
      apiKeyEncrypted: encryptSecret('dummy-api-key', { aad: 'huntress_integrations.api_key_encrypted' })!,
      accountKeyEncrypted: encryptSecret(ACCT_KEY, { aad: 'huntress_integrations.account_key_encrypted' })!,
      isActive: true,
    }).returning({ id: huntressIntegrations.id });
    await db.insert(huntressOrgMappings).values([
      { integrationId: integration!.id, partnerId: p.id, huntressOrgId: 'h-a', huntressOrgKey: ORG_KEY_A, orgId: orgs.a.id },
      { integrationId: integration!.id, partnerId: p.id, huntressOrgId: 'h-b', huntressOrgKey: null, orgId: orgs.b.id },
    ]);
    const { catalogId } = await ensureBuiltinPackage({ provider: 'huntress', partnerId: p.id });

    const [cp] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: p.id, name: 'Partner-wide security agents', status: 'active' })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: cp!.id, level: 'partner', targetId: p.id });
    const link = await addFeatureLink(cp!.id, 'security_agents', null, ENABLED, undefined, undefined, {
      securityAgentsArmAuthorized: true,
    });
    const [policy] = await db
      .select({ id: softwarePolicies.id, approvalGeneration: softwarePolicies.approvalGeneration })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.managedByLinkId, link!.id));
    return { p, q, orgs, dev, catalogId, linkId: link!.id, policyId: policy!.id, generation: policy!.approvalGeneration };
  });
}

function installJob(f: Awaited<ReturnType<typeof seed>>, deviceId: string) {
  return {
    type: 'install-remediate-device' as const,
    policyId: f.policyId,
    deviceId,
    catalogIds: [f.catalogId],
    generation: f.generation,
    attempt: 1,
  };
}

async function deploymentsForOrg(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select({ id: softwareDeployments.id }).from(softwareDeployments).where(eq(softwareDeployments.orgId, orgId)),
  );
}

describe('partner-wide Huntress fan-out — live Postgres (#6960 W02)', () => {
  it('generates a partner-owned policy whose device set is every device of the partner, and nothing of another partner', async () => {
    const f = await seed();
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(softwarePolicies).where(eq(softwarePolicies.id, f.policyId)),
    );
    expect(row).toMatchObject({ orgId: null, partnerId: f.p.id, isActive: true, managedByLinkId: f.linkId });

    const ids = await withSystemDbAccessContext(() => resolveDeviceIdsForSoftwarePolicy(f.policyId));
    expect([...ids].sort()).toEqual([f.dev.a, f.dev.b, f.dev.c].sort());

    // The batched resolver agrees with the per-device walk for every device.
    const all = Object.values(f.dev);
    const batched = await withSystemDbAccessContext(() => resolveSecurityAgentsLinksForDevices(all));
    for (const deviceId of all) {
      const single = await withSystemDbAccessContext(() => resolveSecurityAgentsLinkForDevice(deviceId));
      expect(batched.get(deviceId), deviceId).toBe(single?.linkId ?? null);
    }
  });

  it('a compliance pass queues only the ready org; the others are not applicable with zero violations and zero attempts', async () => {
    const f = await seed();
    const result = await withSystemDbAccessContext(() => processCheckPolicy({ type: 'check-policy', policyId: f.policyId }));
    expect(result).toMatchObject({
      devicesEvaluated: 3,
      violations: 1,
      installRemediationQueued: 1,
      notApplicable: 2,
      notApplicableByReason: { org_key_missing: 1, org_not_mapped: 1 },
    });

    const rows = await withSystemDbAccessContext(() =>
      db
        .select({
          deviceId: softwareComplianceStatus.deviceId,
          status: softwareComplianceStatus.status,
          violations: softwareComplianceStatus.violations,
          installRemediationStatus: softwareComplianceStatus.installRemediationStatus,
          installRemediationAttempts: softwareComplianceStatus.installRemediationAttempts,
        })
        .from(softwareComplianceStatus)
        .where(eq(softwareComplianceStatus.policyId, f.policyId)),
    );
    const byDevice = new Map(rows.map((r) => [r.deviceId, r]));
    expect(byDevice.get(f.dev.a)).toMatchObject({ status: 'violation', installRemediationStatus: 'pending', installRemediationAttempts: 1 });
    for (const deviceId of [f.dev.b, f.dev.c]) {
      expect(byDevice.get(deviceId)).toMatchObject({ status: 'compliant', violations: [], installRemediationAttempts: 0 });
    }
    expect(byDevice.has(f.dev.z)).toBe(false);
  });

  it('dispatch: a closer opt-out cancels; then exactly one deployment, for the ready org, with its keys; none for the others', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => processCheckPolicy({ type: 'check-policy', policyId: f.policyId }));

    // A closer security_agents link with no agents now wins for dA → the queued install is cancelled.
    const optOut = await withSystemDbAccessContext(async () => {
      const [cp] = await db
        .insert(configurationPolicies)
        .values({ orgId: f.orgs.a.id, name: 'Opt out dA', status: 'active' })
        .returning({ id: configurationPolicies.id });
      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: cp!.id, featureType: 'security_agents', inlineSettings: { version: 1, agents: [] },
      });
      await db.insert(configPolicyAssignments).values({ configPolicyId: cp!.id, level: 'device', targetId: f.dev.a });
      return cp!.id;
    });
    const cancelled = await processRemediateDeviceInstall(installJob(f, f.dev.a));
    expect(cancelled.deploymentsCreated).toBe(0);
    expect(await deploymentsForOrg(f.orgs.a.id)).toEqual([]);

    await withSystemDbAccessContext(() => db.delete(configurationPolicies).where(eq(configurationPolicies.id, optOut)));

    const dispatched = await processRemediateDeviceInstall(installJob(f, f.dev.a));
    expect(dispatched).toMatchObject({ deploymentsCreated: 1, errors: 0 });
    expect(await deploymentsForOrg(f.orgs.a.id)).toHaveLength(1);
    const commands = await withSystemDbAccessContext(() =>
      db.select({ payload: deviceCommands.payload }).from(deviceCommands).where(eq(deviceCommands.deviceId, f.dev.a)),
    );
    const payloadText = JSON.stringify(commands.map((c) => c.payload));
    expect(payloadText).toContain(ACCT_KEY);
    expect(payloadText).toContain(ORG_KEY_A);

    // Second line: a job for an unready org (as if readiness changed after
    // enqueue, with a cached missing violation) creates no deployment.
    await withSystemDbAccessContext(() =>
      db
        .update(softwareComplianceStatus)
        .set({
          status: 'violation',
          violations: [{
            type: 'missing',
            rule: { name: 'Huntress Agent*', catalogId: f.catalogId },
            severity: 'high',
            detectedAt: new Date().toISOString(),
          }],
          installRemediationStatus: 'pending',
        })
        .where(and(eq(softwareComplianceStatus.policyId, f.policyId), eq(softwareComplianceStatus.deviceId, f.dev.b))),
    );
    const notReady = await processRemediateDeviceInstall(installJob(f, f.dev.b));
    expect(notReady).toMatchObject({ deploymentsCreated: 0, skipped: 1 });
    expect(await deploymentsForOrg(f.orgs.b.id)).toEqual([]);
    expect(await deploymentsForOrg(f.orgs.c.id)).toEqual([]);
    expect(await deploymentsForOrg(f.orgs.z.id)).toEqual([]);
  });

  it('the repair sweep is a no-op on a freshly generated row (jsonb round-trip) and repairs drift', async () => {
    const f = await seed();
    const readRow = () => withSystemDbAccessContext(async () => {
      const [r] = await db
        .select({
          approvalGeneration: softwarePolicies.approvalGeneration,
          remediationOptions: softwarePolicies.remediationOptions,
          isActive: softwarePolicies.isActive,
        })
        .from(softwarePolicies)
        .where(eq(softwarePolicies.id, f.policyId));
      return r!;
    });

    const first = await withSystemDbAccessContext(() => repairManagedSoftwarePolicies());
    expect(first).toMatchObject({ changed: 0, failed: 0 });
    expect((await readRow()).approvalGeneration).toBe(f.generation);

    // Drift: someone armed uninstall directly in the database.
    await withSystemDbAccessContext(() =>
      db.update(softwarePolicies)
        .set({ remediationOptions: { autoInstall: true, autoUninstall: true } })
        .where(eq(softwarePolicies.id, f.policyId)),
    );
    const repaired = await withSystemDbAccessContext(() => repairManagedSoftwarePolicies());
    expect(repaired).toMatchObject({ changed: 1, failed: 0 });
    const after = await readRow();
    expect(after.remediationOptions).toEqual({ autoInstall: true, autoUninstall: false });
    expect(after.approvalGeneration).toBe(f.generation + 1);

    // And it settles: the next sweep changes nothing.
    expect(await withSystemDbAccessContext(() => repairManagedSoftwarePolicies())).toMatchObject({ changed: 0 });
  });

  it('disabling the vendor drops its cached violations (real jsonb SQL) and settles those devices to compliant', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => processCheckPolicy({ type: 'check-policy', policyId: f.policyId }));
    // A row whose violations are not an array must be left alone, not error.
    await withSystemDbAccessContext(() =>
      db.update(softwareComplianceStatus)
        .set({ violations: null })
        .where(and(eq(softwareComplianceStatus.policyId, f.policyId), eq(softwareComplianceStatus.deviceId, f.dev.b))),
    );

    await withSystemDbAccessContext(() =>
      updateFeatureLink(f.linkId, { inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: false }] } }),
    );

    const rows = await withSystemDbAccessContext(() =>
      db.select({ deviceId: softwareComplianceStatus.deviceId, status: softwareComplianceStatus.status, violations: softwareComplianceStatus.violations })
        .from(softwareComplianceStatus)
        .where(eq(softwareComplianceStatus.policyId, f.policyId)),
    );
    const byDevice = new Map(rows.map((r) => [r.deviceId, r]));
    expect(byDevice.get(f.dev.a)).toMatchObject({ status: 'compliant', violations: [] });
    expect(byDevice.get(f.dev.b)).toMatchObject({ violations: null });
    const [policy] = await withSystemDbAccessContext(() =>
      db.select({ isActive: softwarePolicies.isActive, approvalGeneration: softwarePolicies.approvalGeneration })
        .from(softwarePolicies).where(eq(softwarePolicies.id, f.policyId)),
    );
    expect(policy).toEqual({ isActive: false, approvalGeneration: f.generation + 1 });
  });

  it('the sweep deactivates (fail closed) when the catalog package is archived or the link blob is unreadable', async () => {
    const f = await seed();
    const policyRow = async () => withSystemDbAccessContext(async () => {
      const [r] = await db.select({ isActive: softwarePolicies.isActive, approvalGeneration: softwarePolicies.approvalGeneration })
        .from(softwarePolicies).where(eq(softwarePolicies.id, f.policyId));
      return r!;
    });

    await withSystemDbAccessContext(() =>
      db.update(softwareCatalog).set({ deletedAt: new Date() }).where(eq(softwareCatalog.id, f.catalogId)),
    );
    expect(await withSystemDbAccessContext(() => repairManagedSoftwarePolicies())).toMatchObject({ changed: 1, failed: 0 });
    expect(await policyRow()).toEqual({ isActive: false, approvalGeneration: f.generation + 1 });

    // Restore the package: the next sweep re-arms the same row.
    await withSystemDbAccessContext(() =>
      db.update(softwareCatalog).set({ deletedAt: null }).where(eq(softwareCatalog.id, f.catalogId)),
    );
    await withSystemDbAccessContext(() => repairManagedSoftwarePolicies());
    expect(await policyRow()).toEqual({ isActive: true, approvalGeneration: f.generation + 2 });

    // A stored blob the write path would have refused installs nothing.
    await withSystemDbAccessContext(() =>
      db.update(configPolicyFeatureLinks).set({ inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true, apiKey: 'x' }] } })
        .where(eq(configPolicyFeatureLinks.id, f.linkId)),
    );
    await withSystemDbAccessContext(() => repairManagedSoftwarePolicies());
    expect((await policyRow()).isActive).toBe(false);
  });

  it("an org session of the policy's own partner can SELECT the generated row but never change it; another partner cannot see it", async () => {
    const f = await seed();

    const visible = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(eq(softwarePolicies.id, f.policyId)),
    );
    expect(visible).toEqual([{ id: f.policyId }]);

    const updated = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      db.update(softwarePolicies).set({ isActive: false }).where(eq(softwarePolicies.id, f.policyId)).returning({ id: softwarePolicies.id }),
    );
    expect(updated).toEqual([]);
    const deleted = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      db.delete(softwarePolicies).where(eq(softwarePolicies.id, f.policyId)).returning({ id: softwarePolicies.id }),
    );
    expect(deleted).toEqual([]);

    const otherPartner = await withDbAccessContext(orgContext(f.orgs.z.id, f.q.id), () =>
      db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(eq(softwarePolicies.id, f.policyId)),
    );
    expect(otherPartner).toEqual([]);

    const [still] = await withSystemDbAccessContext(() =>
      db.select({ isActive: softwarePolicies.isActive }).from(softwarePolicies).where(inArray(softwarePolicies.id, [f.policyId])),
    );
    expect(still).toEqual({ isActive: true });
  });
});
