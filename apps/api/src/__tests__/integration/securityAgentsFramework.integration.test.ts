/**
 * #8170 W06.2 — an EDR framework vendor through the security-agents pipeline on
 * real Postgres as breeze_app: a partner-wide link fanning out across orgs, each
 * judged on its own tenant mapping, with the shared installer selection deciding
 * both readiness and dispatch.
 *
 * Bitdefender ships dormant, so this file flips the two gates W06.3 will flip
 * (`enableable` on the vendor, `released` on the package). Nothing else is
 * mocked. No vendor call happens: the material is sealed directly, and the link
 * is synthetic.
 *
 * Fixture: partner P with a partner-wide config policy assigned at partner level, and
 *   org A — one tenant with material (Windows + macOS device) → installs on Windows only
 *   org B — one tenant, no material                           → installer_link_missing
 *   org C — two tenants                                       → tenant_ambiguous
 *   org D — no tenant                                         → org_not_mapped
 * plus partner Q with org Z, mapped and with material, which must never be touched.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityAgentsFramework.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceCommands,
  devices,
  edrConnections,
  edrEndpoints,
  edrTenants,
  securityAgentDeviceStatus,
  softwareComplianceStatus,
  softwareDeployments,
  softwarePolicies,
} from '../../db/schema';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { resolveEdrInstaller } from '../../services/edrInstallerResolver';
import { addFeatureLink } from '../../services/configurationPolicy';
import { persistInstallerOutcomes } from '../../services/edrProviders/installerMaterial';
import { processCheckPolicy } from '../../jobs/softwareComplianceWorker';
import { processRemediateDeviceInstall } from '../../jobs/softwareRemediationWorker';
import { reconcileOrgCoverage } from '../../services/securityAgents/coverageReconcileRun';
import { loadOrgInstallerReadiness } from '../../services/securityAgents/installerReadiness';
import { loadManagedRuleApplicability } from '../../services/securityAgents/managedRuleApplicability';
import { VENDOR_VIEW_STALE_MS, getVendorEndpointSource } from '../../services/securityAgents/vendorEndpointSources';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

vi.mock('../../services/securityAgents/securityAgentVendors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/securityAgents/securityAgentVendors')>();
  const flip = <T extends { key: string; enableable: boolean }>(vendor: T): T =>
    (vendor.key === 'bitdefender' ? { ...vendor, enableable: true } : vendor);
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
vi.mock('../../services/builtinDeploymentPackages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/builtinDeploymentPackages')>();
  actual.BUILTIN_PACKAGES.bitdefender.released = true;
  return actual;
});

const FILE_NAME = 'setupdownloader_synthetic.exe';
const LINK_URL = `https://cloud.gravityzone.bitdefender.com/Packages/BSTWIN/0/${FILE_NAME}`;
const MATERIAL = { v: 1, packageName: 'Synthetic', windowsUrl: LINK_URL };
const ENABLED = { version: 1, agents: [{ vendor: 'bitdefender', enabled: true }] };
const RULE_NAME = 'Bitdefender Endpoint Security Tools*';

function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}

async function addConnection(partnerId: string, provider = 'bitdefender') {
  const [row] = await db.insert(edrConnections).values({
    partnerId,
    provider,
    name: `Connection ${randomUUID().slice(0, 8)}`,
    credentialsEncrypted: 'enc:test',
    vendorRootId: 'root-1',
    vendorRootType: 'partner',
    isActive: true,
    status: 'connected',
  }).returning({ id: edrConnections.id });
  return row!.id;
}

async function addTenant(connectionId: string, partnerId: string, orgId: string, opts: { material?: boolean; vendorMissingSince?: Date } = {}) {
  const [row] = await db.insert(edrTenants).values({
    connectionId,
    partnerId,
    orgId,
    vendorTenantId: `company-${randomUUID().slice(0, 8)}`,
    vendorTenantName: 'Example',
    vendorTenantType: 'company',
    mappingSource: 'manual',
    lastInventorySyncAt: new Date(),
    vendorMissingSince: opts.vendorMissingSince ?? null,
  }).returning({ id: edrTenants.id });
  if (opts.material) {
    await persistInstallerOutcomes(db, 'bitdefender', [{ tenantId: row!.id, ok: true, data: MATERIAL, expiresAt: null }], new Date());
  }
  return row!.id;
}

async function addEndpoint(
  connectionId: string,
  partnerId: string,
  orgId: string,
  tenantId: string,
  opts: { hostname: string; deviceId?: string | null; online?: boolean | null; provider?: string },
) {
  const [row] = await db.insert(edrEndpoints).values({
    connectionId,
    partnerId,
    orgId,
    tenantId,
    provider: opts.provider ?? 'bitdefender',
    vendorEndpointId: `endpoint-${randomUUID().slice(0, 8)}`,
    hostname: opts.hostname,
    breezeDeviceId: opts.deviceId ?? null,
    online: opts.online ?? true,
  }).returning({ id: edrEndpoints.id });
  return row!.id;
}

async function seed() {
  const p = await createPartner();
  const q = await createPartner();
  const orgs = {
    a: await createOrganization({ partnerId: p.id }),
    b: await createOrganization({ partnerId: p.id }),
    c: await createOrganization({ partnerId: p.id }),
    d: await createOrganization({ partnerId: p.id }),
    z: await createOrganization({ partnerId: q.id }),
  };
  const dev: Record<'a' | 'aMac' | 'b' | 'c' | 'd' | 'z', string> = { a: '', aMac: '', b: '', c: '', d: '', z: '' };
  for (const key of ['a', 'b', 'c', 'd', 'z'] as const) {
    const site = await createSite({ orgId: orgs[key].id });
    dev[key] = (await createDevice({ orgId: orgs[key].id, siteId: site.id, hostname: `edr-${key}-${orgs[key].id.slice(0, 8)}` })).id;
    if (key === 'a') {
      dev.aMac = (await createDevice({ orgId: orgs.a.id, siteId: site.id, hostname: `edr-amac-${orgs.a.id.slice(0, 8)}` })).id;
    }
  }

  const provisioned = await ensureBuiltinPackage({ provider: 'bitdefender', partnerId: p.id });
  if (!provisioned.catalogId) throw new Error('the bitdefender package was not provisioned');
  const catalogId = provisioned.catalogId;

  // Two transactions: writing the partner's tenants takes its export lock shared,
  // and the partner-wide policy below needs it exclusive.
  const { connection, tenantA, otherConnection, tenantZ } = await withSystemDbAccessContext(async () => {
    await db.update(devices).set({ osType: 'macos' }).where(eq(devices.id, dev.aMac));

    const conn = await addConnection(p.id);
    const a = await addTenant(conn, p.id, orgs.a.id, { material: true });
    await addTenant(conn, p.id, orgs.b.id);
    await addTenant(conn, p.id, orgs.c.id, { material: true });
    await addTenant(conn, p.id, orgs.c.id, { material: true });
    const other = await addConnection(q.id);
    const z = await addTenant(other, q.id, orgs.z.id, { material: true });
    return { connection: conn, tenantA: a, otherConnection: other, tenantZ: z };
  });

  return withSystemDbAccessContext(async () => {
    const [cp] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: p.id, name: 'Partner-wide endpoint protection', status: 'active' })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: cp!.id, level: 'partner', targetId: p.id });
    const link = await addFeatureLink(cp!.id, 'security_agents', null, ENABLED, undefined, undefined, {
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
        managedByLinkId: softwarePolicies.managedByLinkId,
      })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.managedByLinkId, link!.id));
    return { p, q, orgs, dev, catalogId, connection, tenantA, otherConnection, tenantZ, policy: policy! };
  });
}

type Fixture = Awaited<ReturnType<typeof seed>>;

const compliancePass = (f: Fixture) =>
  withSystemDbAccessContext(() => processCheckPolicy({ type: 'check-policy', policyId: f.policy.id }));

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
        violations: [{ type: 'missing', rule: { name: RULE_NAME, catalogId: f.catalogId }, severity: 'high', detectedAt: new Date().toISOString() }],
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

const coverageRows = (orgIds: string[]) => withSystemDbAccessContext(() =>
  db.select().from(securityAgentDeviceStatus).where(inArray(securityAgentDeviceStatus.orgId, orgIds)),
);

const deploymentsIn = (orgId: string) => withSystemDbAccessContext(() =>
  db.select({ id: softwareDeployments.id }).from(softwareDeployments).where(eq(softwareDeployments.orgId, orgId)),
);

const commandsOn = (deviceId: string) => withSystemDbAccessContext(() =>
  db.select({ payload: deviceCommands.payload }).from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId)),
);

describe('security agents — EDR framework vendor on live Postgres (#8170)', () => {
  it("a partner-wide link generates a PARTNER-owned policy with one rule on the partner's package", async () => {
    const f = await seed();
    expect(f.policy).toMatchObject({ orgId: null, partnerId: f.p.id, isActive: true });
    expect((f.policy.rules as { software: unknown[] }).software).toEqual([
      { name: RULE_NAME, catalogId: f.catalogId, reason: expect.stringContaining('Bitdefender GravityZone') },
    ]);
  });

  it("readiness judges each device on its own org: A's Windows ready, A's macOS needs MDM, B no link, C ambiguous, D unmapped", async () => {
    const f = await seed();
    const reached = [
      { deviceId: f.dev.a, orgId: f.orgs.a.id, osType: 'windows' },
      { deviceId: f.dev.aMac, orgId: f.orgs.a.id, osType: 'macos' },
      { deviceId: f.dev.b, orgId: f.orgs.b.id, osType: 'windows' },
      { deviceId: f.dev.c, orgId: f.orgs.c.id, osType: 'windows' },
      { deviceId: f.dev.d, orgId: f.orgs.d.id, osType: 'windows' },
    ];
    const applicability = await withSystemDbAccessContext(() =>
      loadManagedRuleApplicability(
        { id: f.policy.id, managedByLinkId: f.policy.managedByLinkId!, rules: f.policy.rules as never },
        reached,
      ),
    );
    const verdict = (deviceId: string) => applicability.evaluateDevice(deviceId)[0]?.result;
    expect(verdict(f.dev.a)).toEqual({ ok: true });
    expect(verdict(f.dev.aMac)).toEqual({ ok: false, reason: 'requires_mdm_approval' });
    expect(verdict(f.dev.b)).toEqual({ ok: false, reason: 'installer_link_missing' });
    expect(verdict(f.dev.c)).toEqual({ ok: false, reason: 'tenant_ambiguous' });
    expect(verdict(f.dev.d)).toEqual({ ok: false, reason: 'org_not_mapped' });
  });

  it('the compliance pass keeps the install violation only where it can succeed, and leaves the other partner alone', async () => {
    const f = await seed();
    await compliancePass(f);

    expect((await complianceFor(f, f.dev.a))?.violations).toEqual([
      expect.objectContaining({ type: 'missing', rule: expect.objectContaining({ catalogId: f.catalogId }) }),
    ]);
    for (const key of ['aMac', 'b', 'c', 'd'] as const) {
      expect(await complianceFor(f, f.dev[key]), key).toMatchObject({ status: 'compliant', violations: [] });
    }
    expect(await complianceFor(f, f.dev.z)).toBeUndefined();
  });

  it("A's Windows device gets ONE deployment with the sealed link, its file name and the silent args, and no checksum; nobody else gets one", async () => {
    const f = await seed();
    await compliancePass(f);

    const ready = await processRemediateDeviceInstall(installJob(f, f.dev.a));
    expect(ready).toMatchObject({ deploymentsCreated: 1, errors: 0 });
    expect(await deploymentsIn(f.orgs.a.id)).toHaveLength(1);
    const commands = await commandsOn(f.dev.a);
    expect(commands).toHaveLength(1);
    const payload = commands[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ downloadUrl: LINK_URL, fileName: FILE_NAME, silentInstallArgs: '/bdparams /silent' });
    expect(payload.checksum ?? null).toBeNull();

    for (const key of ['aMac', 'b', 'c', 'd'] as const) {
      await forceMissing(f, f.dev[key]);
      const refused = await processRemediateDeviceInstall(installJob(f, f.dev[key]));
      expect(refused, key).toMatchObject({ deploymentsCreated: 0 });
      expect(await commandsOn(f.dev[key]), key).toEqual([]);
    }
    // A's one is still the Windows device's: the macOS job added none.
    expect(await deploymentsIn(f.orgs.a.id)).toHaveLength(1);
    for (const key of ['b', 'c', 'd', 'z'] as const) {
      expect(await deploymentsIn(f.orgs[key].id), key).toEqual([]);
    }
    expect(await commandsOn(f.dev.z)).toEqual([]);
  });

  it('dispatch refuses on its own every org readiness refuses, and resolves the one it allows', async () => {
    const f = await seed();
    const resolve = (orgId: string) => resolveEdrInstaller({ provider: 'bitdefender', orgId, downloadUrlTemplate: null, silentInstallArgsTemplate: null });
    expect(await resolve(f.orgs.a.id)).toMatchObject({ downloadUrl: LINK_URL, fileName: FILE_NAME });
    expect(await resolve(f.orgs.b.id)).toEqual({ error: expect.stringContaining('installer link not fetched yet') });
    expect(await resolve(f.orgs.c.id)).toEqual({ error: expect.stringContaining('maps to 2') });
    expect(await resolve(f.orgs.d.id)).toEqual({ error: expect.stringContaining('not mapped') });
  });

  it('readiness answers in one batch for orgs of different partners, each against its own partner tenant', async () => {
    const f = await seed();
    const readiness = await loadOrgInstallerReadiness('bitdefender', [f.orgs.a.id, f.orgs.d.id, f.orgs.z.id]);
    expect(readiness.get(f.orgs.a.id)).toEqual({ ok: true });
    expect(readiness.get(f.orgs.d.id)).toEqual({ ok: false, reason: 'org_not_mapped' });
    expect(readiness.get(f.orgs.z.id)).toEqual({ ok: true });
  });

  it('an org-scoped token can read the generated policy and cannot write it', async () => {
    const f = await seed();
    const context = orgContext(f.orgs.d.id, f.p.id);
    const read = await withDbAccessContext(context, () =>
      db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(eq(softwarePolicies.id, f.policy.id)),
    );
    expect(read).toEqual([{ id: f.policy.id }]);

    const updated = await withDbAccessContext(context, () =>
      db.update(softwarePolicies).set({ isActive: false }).where(eq(softwarePolicies.id, f.policy.id)).returning({ id: softwarePolicies.id }),
    );
    expect(updated).toEqual([]);
    const deleted = await withDbAccessContext(context, () =>
      db.delete(softwarePolicies).where(eq(softwarePolicies.id, f.policy.id)).returning({ id: softwarePolicies.id }),
    );
    expect(deleted).toEqual([]);
  });

  it("the compliance pass writes a coverage row per device, each on its own org's verdict, and none for the other partner", async () => {
    const f = await seed();
    await compliancePass(f);

    const rows = await coverageRows([f.orgs.a.id, f.orgs.b.id, f.orgs.c.id, f.orgs.d.id, f.orgs.z.id]);
    expect(rows).toHaveLength(5);
    const byDevice = new Map(rows.map((row) => [row.deviceId, row]));
    expect(byDevice.get(f.dev.a)).toMatchObject({ orgId: f.orgs.a.id, vendor: 'bitdefender', state: 'pending', policyId: f.policy.id });
    expect(byDevice.get(f.dev.aMac)).toMatchObject({ orgId: f.orgs.a.id, state: 'not_applicable', reasonCode: 'requires_mdm_approval' });
    expect(byDevice.get(f.dev.b)).toMatchObject({ orgId: f.orgs.b.id, state: 'not_applicable', reasonCode: 'installer_link_missing' });
    expect(byDevice.get(f.dev.c)).toMatchObject({ orgId: f.orgs.c.id, state: 'not_applicable', reasonCode: 'tenant_ambiguous' });
    expect(byDevice.get(f.dev.d)).toMatchObject({ orgId: f.orgs.d.id, state: 'not_applicable', reasonCode: 'org_not_mapped' });
    expect(byDevice.has(f.dev.z)).toBe(false);
  });

  it("reconcile turns A's Windows device covered from a linked endpoint and leaves the not_applicable row alone", async () => {
    const f = await seed();
    await compliancePass(f);
    await withSystemDbAccessContext(() =>
      addEndpoint(f.connection, f.p.id, f.orgs.a.id, f.tenantA, { hostname: 'covered', deviceId: f.dev.a }),
    );

    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result).toMatchObject({ evaluated: 1, changed: 1, alertsRaised: 0 });

    const byDevice = new Map((await coverageRows([f.orgs.a.id])).map((row) => [row.deviceId, row]));
    expect(byDevice.get(f.dev.a)).toMatchObject({ state: 'covered', vendor: 'bitdefender' });
    expect(byDevice.get(f.dev.aMac)).toMatchObject({ state: 'not_applicable', reasonCode: 'requires_mdm_approval' });
  });
});

describe('edr_endpoints coverage source on live Postgres (#8170)', () => {
  const source = () => getVendorEndpointSource('bitdefender')!;
  const listA = (f: Fixture) => withSystemDbAccessContext(() => source().listForOrg(f.orgs.a.id));

  it("reads only the org's own tenants of this provider: not another org, another provider, a tombstoned tenant or another partner", async () => {
    const f = await seed();
    const { covered, stranger } = await withSystemDbAccessContext(async () => {
      const coveredId = await addEndpoint(f.connection, f.p.id, f.orgs.a.id, f.tenantA, { hostname: 'covered', deviceId: f.dev.a });
      const strangerId = await addEndpoint(f.connection, f.p.id, f.orgs.a.id, f.tenantA, { hostname: 'stranger', online: false });

      // Same org, other provider.
      const emsisoft = await addConnection(f.p.id, 'emsisoft');
      const emsisoftTenant = await addTenant(emsisoft, f.p.id, f.orgs.a.id);
      await addEndpoint(emsisoft, f.p.id, f.orgs.a.id, emsisoftTenant, { hostname: 'other-provider', provider: 'emsisoft' });

      // Same org, a tenant the vendor stopped listing, last synced long ago.
      const gone = await addTenant(f.connection, f.p.id, f.orgs.a.id, { vendorMissingSince: new Date() });
      await db.update(edrTenants).set({ lastInventorySyncAt: new Date(Date.now() - 2 * VENDOR_VIEW_STALE_MS) }).where(eq(edrTenants.id, gone));
      await addEndpoint(f.connection, f.p.id, f.orgs.a.id, gone, { hostname: 'tombstoned' });

      // Another org of the partner, and another partner, sharing a hostname.
      const tenantB = (await db.select({ id: edrTenants.id }).from(edrTenants).where(eq(edrTenants.orgId, f.orgs.b.id)))[0]!.id;
      await addEndpoint(f.connection, f.p.id, f.orgs.b.id, tenantB, { hostname: 'covered' });
      await addEndpoint(f.otherConnection, f.q.id, f.orgs.z.id, f.tenantZ, { hostname: 'covered' });
      return { covered: coveredId, stranger: strangerId };
    });

    const view = await listA(f);
    expect(view?.map((endpoint) => endpoint.endpointId).sort()).toEqual([covered, stranger].sort());
    expect(view?.find((endpoint) => endpoint.endpointId === covered)).toEqual({
      endpointId: covered, orgId: f.orgs.a.id, deviceId: f.dev.a, hostname: 'covered', online: true,
    });
    expect(view?.find((endpoint) => endpoint.endpointId === stranger)?.online).toBe(false);
  });

  it('a stale tenant, a never-synced one or a connection needing reauth makes the view unavailable, not empty', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() =>
      addEndpoint(f.connection, f.p.id, f.orgs.a.id, f.tenantA, { hostname: 'covered', deviceId: f.dev.a }),
    );
    await expect(listA(f)).resolves.toHaveLength(1);

    const setTenant = (lastInventorySyncAt: Date | null) => withSystemDbAccessContext(() =>
      db.update(edrTenants).set({ lastInventorySyncAt }).where(eq(edrTenants.id, f.tenantA)),
    );
    await setTenant(new Date(Date.now() - VENDOR_VIEW_STALE_MS - 60_000));
    await expect(listA(f)).resolves.toBeNull();
    await setTenant(null);
    await expect(listA(f)).resolves.toBeNull();
    await setTenant(new Date());
    await expect(listA(f)).resolves.toHaveLength(1);

    const setConnection = (values: { status?: 'connected' | 'reauth_required'; isActive?: boolean }) => withSystemDbAccessContext(() =>
      db.update(edrConnections).set(values).where(eq(edrConnections.id, f.connection)),
    );
    await setConnection({ status: 'reauth_required' });
    await expect(listA(f)).resolves.toBeNull();
    await setConnection({ status: 'connected', isActive: false });
    await expect(listA(f)).resolves.toBeNull();
  });

  it('an org with no mapped tenant is unavailable', async () => {
    const f = await seed();
    await expect(withSystemDbAccessContext(() => source().listForOrg(f.orgs.d.id))).resolves.toBeNull();
  });
});
