/**
 * #6960 W05 — Control D / NextDNS through the security-agents pipeline on real
 * Postgres as breeze_app: tenant-variable readiness, one generated rule per
 * (vendor, OS) built-in package, the `service_running` presence bridge, and
 * coverage rows that survive the reconciler.
 *
 * W05 shipped code-only (#6958 lab gates L1–L5 not yet recorded), so the DNS
 * vendors are `enableable: false` in the registry. This file flips that ONE
 * field for Control D and NextDNS, to run the wiring exactly as the follow-up
 * flip will arm it. Nothing else is mocked.
 *
 * Fixture: partner P with its `nextdns_windows` built-in row (provisioned by
 * the test the way the Built-in packages panel does; W05 code only ever reads
 * it), a partner-wide config policy assigned at partner level, and
 *   org A — nextdns_profile_id set (org value)        → ready, installs
 *   org B — no nextdns_profile_id                     → not_applicable / var_missing
 *   org C — nextdns_profile_id set but marked secret  → not_applicable / var_secret
 * plus partner Q with org Z, which must never be touched.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityAgentsDnsVendors.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  securityAgentDeviceStatus,
  serviceProcessCheckResults,
  softwareCatalog,
  softwareComplianceStatus,
  softwareDeployments,
  softwarePolicies,
  tenantVariables,
} from '../../db/schema';
import { catalogIdForBuiltinKey, ensurePinnedBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { encryptTenantVariableValue } from '../../services/tenantVariables';
import { addFeatureLink } from '../../services/configurationPolicy';
import { processCheckPolicy } from '../../jobs/softwareComplianceWorker';
import { processRemediateDeviceInstall } from '../../jobs/softwareRemediationWorker';
import { reconcileOrgCoverage } from '../../services/securityAgents/coverageReconcileRun';
import { loadOrgInstallerReadiness } from '../../services/securityAgents/installerReadiness';
import {
  repairManagedSoftwarePolicies,
  syncManagedSoftwarePolicy,
} from '../../services/securityAgents/managedPolicyGenerator';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

vi.mock('../../services/securityAgents/securityAgentVendors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/securityAgents/securityAgentVendors')>();
  const flip = <T extends { key: string; enableable: boolean }>(vendor: T): T =>
    (vendor.key === 'controld' || vendor.key === 'nextdns' ? { ...vendor, enableable: true } : vendor);
  const list = actual.listVendors().map(flip);
  return {
    ...actual,
    listVendors: () => list,
    getVendor: (key: string) => {
      const found = list.find((vendor) => vendor.key === key);
      if (!found) throw new Error(`Unknown security agent vendor: ${key}`);
      return found;
    },
  };
});

const PROFILE = '<profile-id>';
const NEXTDNS_ENABLED = { version: 1, agents: [{ vendor: 'nextdns', enabled: true }] };

function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}

async function setVar(owner: { orgId: string } | { partnerId: string }, key: string, value: string, isSecret = false) {
  const id = randomUUID();
  await withSystemDbAccessContext(() =>
    db.insert(tenantVariables).values({
      id,
      orgId: 'orgId' in owner ? owner.orgId : null,
      partnerId: 'partnerId' in owner ? owner.partnerId : null,
      key,
      value: encryptTenantVariableValue(id, value),
      isSecret,
    }),
  );
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
    dev[key] = (await createDevice({ orgId: orgs[key].id, siteId: site.id, hostname: `dns-${key}-${orgs[key].id.slice(0, 8)}` })).id;
  }

  const { catalogId } = await ensurePinnedBuiltinPackage({ key: 'nextdns_windows', partnerId: p.id });
  await setVar({ orgId: orgs.a.id }, 'nextdns_profile_id', PROFILE);
  await setVar({ orgId: orgs.c.id }, 'nextdns_profile_id', PROFILE, true);

  return withSystemDbAccessContext(async () => {
    const [cp] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: p.id, name: 'Partner-wide DNS filtering', status: 'active' })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: cp!.id, level: 'partner', targetId: p.id });
    const link = await addFeatureLink(cp!.id, 'security_agents', null, NEXTDNS_ENABLED, undefined, undefined, {
      securityAgentsArmAuthorized: true,
    });
    const [policy] = await db
      .select({
        id: softwarePolicies.id,
        orgId: softwarePolicies.orgId,
        partnerId: softwarePolicies.partnerId,
        rules: softwarePolicies.rules,
        isActive: softwarePolicies.isActive,
        approvalGeneration: softwarePolicies.approvalGeneration,
      })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.managedByLinkId, link!.id));
    return { p, q, orgs, dev, catalogId, linkId: link!.id, configPolicyId: cp!.id, policy: policy! };
  });
}

type Fixture = Awaited<ReturnType<typeof seed>>;

const compliancePass = (f: Fixture) =>
  withSystemDbAccessContext(() => processCheckPolicy({ type: 'check-policy', policyId: f.policy.id }));

async function observe(orgId: string, deviceId: string, status: 'running' | 'stopped' | 'not_found') {
  await withSystemDbAccessContext(() =>
    db.insert(serviceProcessCheckResults).values({ orgId, deviceId, watchType: 'service', name: 'nextdns', status, timestamp: new Date() }),
  );
}

async function rowFor(deviceId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(securityAgentDeviceStatus)
      .where(and(eq(securityAgentDeviceStatus.deviceId, deviceId), eq(securityAgentDeviceStatus.vendor, 'nextdns'))),
  );
  return row;
}

async function complianceFor(f: Fixture, deviceId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(softwareComplianceStatus)
      .where(and(eq(softwareComplianceStatus.policyId, f.policy.id), eq(softwareComplianceStatus.deviceId, deviceId))),
  );
  return row;
}

async function forceMissing(f: Fixture, deviceId: string) {
  await withSystemDbAccessContext(() =>
    db.update(softwareComplianceStatus)
      .set({
        status: 'violation',
        violations: [{ type: 'missing', rule: { name: 'NextDNS CLI (Windows)', catalogId: f.catalogId }, severity: 'high', detectedAt: new Date().toISOString() }],
        installRemediationStatus: 'pending',
      })
      .where(and(eq(softwareComplianceStatus.policyId, f.policy.id), eq(softwareComplianceStatus.deviceId, deviceId))),
  );
}

function installJob(f: Fixture, deviceId: string) {
  return {
    type: 'install-remediate-device' as const,
    policyId: f.policy.id,
    deviceId,
    catalogIds: [f.catalogId],
    generation: f.policy.approvalGeneration,
    attempt: 1,
  };
}

const deploymentsIn = (orgId: string) => withSystemDbAccessContext(() =>
  db.select({ id: softwareDeployments.id }).from(softwareDeployments).where(eq(softwareDeployments.orgId, orgId)),
);

describe('security agents — DNS vendors on live Postgres (#6960 W05)', () => {
  it("a partner-wide NextDNS link generates a PARTNER-owned policy with one rule on the partner's nextdns_windows row", async () => {
    const f = await seed();
    expect(f.policy).toMatchObject({ orgId: null, partnerId: f.p.id, isActive: true });
    expect((f.policy.rules as { software: unknown[] }).software).toEqual([
      { name: 'NextDNS CLI (Windows)', catalogId: f.catalogId, reason: expect.stringContaining('NextDNS') },
    ]);
  });

  it("status rows land under each DEVICE's org: A pending, B var_missing, C var_secret; the other partner untouched", async () => {
    const f = await seed();
    await compliancePass(f);

    expect(await rowFor(f.dev.a)).toMatchObject({ orgId: f.orgs.a.id, state: 'pending', reasonCode: null, policyId: f.policy.id });
    expect(await rowFor(f.dev.b)).toMatchObject({ orgId: f.orgs.b.id, state: 'not_applicable', reasonCode: 'var_missing' });
    expect(await rowFor(f.dev.c)).toMatchObject({ orgId: f.orgs.c.id, state: 'not_applicable', reasonCode: 'var_secret' });
    expect(await rowFor(f.dev.z)).toBeUndefined();

    // No telemetry yet: A is service_unverified (a gap never installs); B and
    // C carry no violation of any kind for the not-applicable rule.
    expect((await complianceFor(f, f.dev.a))?.violations).toEqual([
      expect.objectContaining({ type: 'service_unverified', rule: expect.objectContaining({ catalogId: f.catalogId }) }),
    ]);
    for (const key of ['b', 'c'] as const) {
      expect(await complianceFor(f, f.dev[key]), key).toMatchObject({ status: 'compliant', violations: [] });
    }
  });

  it('A: a fresh not_found makes the rule missing and the install job dispatches ONE deployment whose script gets the profile id as a parameter; B and C get none', async () => {
    const f = await seed();
    await observe(f.orgs.a.id, f.dev.a, 'not_found');
    await compliancePass(f);
    expect((await complianceFor(f, f.dev.a))?.violations).toEqual([expect.objectContaining({ type: 'missing' })]);
    expect((await complianceFor(f, f.dev.a))?.serviceWatches).toEqual([{ name: 'nextdns' }]);

    const ready = await processRemediateDeviceInstall(installJob(f, f.dev.a));
    expect(ready).toMatchObject({ deploymentsCreated: 1, errors: 0 });
    expect(await deploymentsIn(f.orgs.a.id)).toHaveLength(1);
    const commands = await withSystemDbAccessContext(() =>
      db.select({ payload: deviceCommands.payload }).from(deviceCommands).where(eq(deviceCommands.deviceId, f.dev.a)),
    );
    expect(commands).toHaveLength(1);
    const payload = JSON.stringify(commands[0]!.payload);
    // The token is rewritten to an executor placeholder and the value travels
    // as a parameter, never spliced into the script text (#6958 D3).
    expect(payload).toContain('{{var_nextdns_profile_id}}');
    expect(payload).not.toContain('{{var.nextdns_profile_id}}');
    expect(payload).toContain(PROFILE);

    for (const key of ['b', 'c'] as const) {
      await forceMissing(f, f.dev[key]);
      const notReady = await processRemediateDeviceInstall(installJob(f, f.dev[key]));
      expect(notReady, key).toMatchObject({ deploymentsCreated: 0 });
      expect(await deploymentsIn(f.orgs[key].id), key).toEqual([]);
    }
    expect(await deploymentsIn(f.orgs.z.id)).toEqual([]);
  });

  it('a stopped client is not_running (never reinstalled); a running one is compliant', async () => {
    const f = await seed();
    await observe(f.orgs.a.id, f.dev.a, 'stopped');
    await compliancePass(f);
    expect((await complianceFor(f, f.dev.a))?.violations).toEqual([
      expect.objectContaining({ type: 'not_running', service: expect.objectContaining({ name: 'nextdns', observedStatus: 'stopped' }) }),
    ]);
    await observe(f.orgs.a.id, f.dev.a, 'running');
    await compliancePass(f);
    expect(await complianceFor(f, f.dev.a)).toMatchObject({ status: 'compliant', violations: [] });
  });

  it('the coverage reconciler keeps DNS rows (no endpoint source until #3408): nothing pruned, state unchanged', async () => {
    const f = await seed();
    await compliancePass(f);
    for (const key of ['a', 'b'] as const) {
      const result = await reconcileOrgCoverage(f.orgs[key].id);
      expect(result, key).toMatchObject({ pruned: 0, changed: 0 });
    }
    expect(await rowFor(f.dev.a)).toMatchObject({ state: 'pending' });
    expect(await rowFor(f.dev.b)).toMatchObject({ state: 'not_applicable', reasonCode: 'var_missing' });
  });

  it('recovery: once org B sets the variable, the next pass moves dB to pending', async () => {
    const f = await seed();
    await compliancePass(f);
    await setVar({ orgId: f.orgs.b.id }, 'nextdns_profile_id', PROFILE);
    await compliancePass(f);
    expect(await rowFor(f.dev.b)).toMatchObject({ state: 'pending', reasonCode: null });
  });

  it('sweep, fail closed both ways: archiving the built-in row drops the rule and deactivates; re-adding it from the panel restores it', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() =>
      db.update(softwareCatalog).set({ deletedAt: new Date() }).where(eq(softwareCatalog.id, f.catalogId)),
    );
    // As the compliance scan calls it: inside its system context.
    expect(await withSystemDbAccessContext(() => repairManagedSoftwarePolicies())).toMatchObject({ failed: 0 });
    const policyRow = () => withSystemDbAccessContext(async () => {
      const [row] = await db.select({ isActive: softwarePolicies.isActive, rules: softwarePolicies.rules })
        .from(softwarePolicies).where(eq(softwarePolicies.id, f.policy.id));
      return row!;
    });
    expect(await policyRow()).toMatchObject({ isActive: false, rules: { software: [] } });

    await ensurePinnedBuiltinPackage({ key: 'nextdns_windows', partnerId: f.p.id });
    expect(await withSystemDbAccessContext(() => repairManagedSoftwarePolicies())).toMatchObject({ failed: 0 });
    expect(await policyRow()).toMatchObject({ isActive: true, rules: { software: [{ catalogId: f.catalogId }] } });
  });
});

describe('DNS vendor catalog lookup by caller context (#6960 W05)', () => {
  it("partner scope resolves its own row and not another partner's", async () => {
    const f = await seed();
    const own = await withDbAccessContext(partnerContext(f.p.id, [f.orgs.a.id, f.orgs.b.id, f.orgs.c.id]), () =>
      catalogIdForBuiltinKey(f.p.id, 'nextdns_windows'));
    expect(own).toBe(f.catalogId);
    const other = await withDbAccessContext(partnerContext(f.q.id, [f.orgs.z.id]), () =>
      catalogIdForBuiltinKey(f.p.id, 'nextdns_windows'));
    expect(other).toBeNull();
  });

  it("an org-scope writer sees its own partner's row (software_catalog_partner_wide_select) and generates an ORG-owned policy on it", async () => {
    const f = await seed();
    const visible = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      catalogIdForBuiltinKey(f.p.id, 'nextdns_windows'));
    expect(visible).toBe(f.catalogId);

    // An org-owned config policy with a NextDNS link, synced in the org
    // writer's own request context (the link-write path).
    const link = await withSystemDbAccessContext(async () => {
      const [cp] = await db.insert(configurationPolicies)
        .values({ orgId: f.orgs.a.id, partnerId: null, name: 'Org DNS filtering', status: 'active' })
        .returning({ id: configurationPolicies.id });
      const [row] = await db.insert(configPolicyFeatureLinks)
        .values({ configPolicyId: cp!.id, featureType: 'security_agents', featurePolicyId: null, inlineSettings: NEXTDNS_ENABLED })
        .returning({ id: configPolicyFeatureLinks.id, configPolicyId: configPolicyFeatureLinks.configPolicyId, inlineSettings: configPolicyFeatureLinks.inlineSettings });
      return row!;
    });
    const result = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      db.transaction((tx) => syncManagedSoftwarePolicy(tx, link, { onMissingCatalog: 'refuse' })));
    expect(result).toMatchObject({ action: 'create', vendors: ['nextdns'] });
    const [generated] = await withSystemDbAccessContext(() =>
      db.select({ orgId: softwarePolicies.orgId, partnerId: softwarePolicies.partnerId, rules: softwarePolicies.rules })
        .from(softwarePolicies).where(eq(softwarePolicies.managedByLinkId, link.id)));
    expect(generated).toMatchObject({ orgId: f.orgs.a.id, partnerId: null, rules: { software: [{ catalogId: f.catalogId }] } });
  });

  it("an org of ANOTHER partner never sees this partner's row", async () => {
    const f = await seed();
    const seen = await withDbAccessContext(orgContext(f.orgs.z.id, f.q.id), () =>
      catalogIdForBuiltinKey(f.p.id, 'nextdns_windows'));
    expect(seen).toBeNull();
  });
});

describe('tenant-variable readiness against the real resolver (#6960 W05)', () => {
  it("a partner default makes its own orgs ready; an org of another partner never sees it; an org override wins", async () => {
    const p = await createPartner();
    const q = await createPartner();
    const inherits = await createOrganization({ partnerId: p.id });
    const overrides = await createOrganization({ partnerId: p.id });
    const foreign = await createOrganization({ partnerId: q.id });
    await setVar({ partnerId: p.id }, 'controld_provisioning_code', '<provisioning-code>');
    await setVar({ orgId: overrides.id }, 'controld_provisioning_code', '<provisioning-code>', true);

    const readiness = await loadOrgInstallerReadiness('controld', [inherits.id, overrides.id, foreign.id]);
    expect(readiness.get(inherits.id)).toEqual({ ok: true });
    // The org's own (secret) value shadows the partner default.
    expect(readiness.get(overrides.id)).toEqual({ ok: false, reason: 'var_secret' });
    expect(readiness.get(foreign.id)).toEqual({ ok: false, reason: 'var_missing' });
  });

  it('runs from inside an org-scoped request context and still sees the partner default (its own system context)', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    await setVar({ partnerId: p.id }, 'nextdns_profile_id', PROFILE);
    const readiness = await withDbAccessContext(
      { ...orgContext(org.id, p.id), currentPartnerId: null },
      () => loadOrgInstallerReadiness('nextdns', [org.id]),
    );
    expect(readiness.get(org.id)).toEqual({ ok: true });
  });
});
