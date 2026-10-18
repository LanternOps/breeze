/**
 * #6960 W03 — security agent coverage on real Postgres as breeze_app:
 * `security_agent_device_status` written by the compliance worker and the
 * coverage reconciler for a PARTNER-WIDE Huntress link (generated policy has
 * org_id NULL), plus its tenancy pins.
 *
 * Fixture (same shape as securityAgentsPartnerRls.integration.test.ts):
 * partner P with an active Huntress integration (account key set) and
 *   org A — mapped, org key present   → dA ready (pending → reconciled)
 *   org B — mapped, NO org key        → dB not_applicable / org_key_missing
 *   org C — not mapped                → dC not_applicable / org_not_mapped
 * and partner Q with org Z / device dZ, which must never be touched.
 *
 * Proves: status rows land under each DEVICE's org (never the policy owner's
 * NULL org) with the right state/reason and zero deployments for the unready
 * orgs; recovery clears not_applicable; an org-scoped session sees only its own
 * org's rows and cannot write another org's (RLS); the reconciler classifies
 * covered / gap / mismatched_org / vendor_only with transition-only alerts;
 * deleting the owning config policy leaves rows intact (policy_id SET NULL);
 * a device org move restamps the row's org_id (composite FK ON UPDATE CASCADE).
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityAgentCoverage.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts,
  configPolicyAssignments,
  configurationPolicies,
  devices,
  huntressAgents,
  huntressIntegrations,
  huntressOrgMappings,
  securityAgentDeviceStatus,
  softwareComplianceStatus,
  softwareDeployments,
  softwarePolicies,
} from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { addFeatureLink } from '../../services/configurationPolicy';
import { processCheckPolicy } from '../../jobs/softwareComplianceWorker';
import {
  listCoverageOrgsForPartner,
  listCoveragePartners,
  reconcileOrgCoverage,
} from '../../services/securityAgents/coverageReconcileRun';
import { SECURITY_AGENT_COVERAGE_ALERT_SOURCE } from '../../services/securityAgents/coverageAlerts';
import { readSecurityAgentCoverage } from '../../services/securityAgents/coverageRead';
import type { EdrReadScope } from '../../services/edrProviders/read';
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
  const host: Record<'a' | 'b' | 'c' | 'z', string> = { a: '', b: '', c: '', z: '' };
  for (const key of ['a', 'b', 'c', 'z'] as const) {
    const site = await createSite({ orgId: orgs[key].id });
    host[key] = `cov-${key}-${orgs[key].id.slice(0, 8)}`;
    dev[key] = (await createDevice({ orgId: orgs[key].id, siteId: site.id, hostname: host[key] })).id;
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
      .select({ id: softwarePolicies.id })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.managedByLinkId, link!.id));
    return {
      p, q, orgs, dev, host, catalogId,
      integrationId: integration!.id,
      configPolicyId: cp!.id,
      policyId: policy!.id,
    };
  });
}

type Fixture = Awaited<ReturnType<typeof seed>>;

const statusRows = () => withSystemDbAccessContext(() => db.select().from(securityAgentDeviceStatus));

async function rowFor(deviceId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(securityAgentDeviceStatus).where(eq(securityAgentDeviceStatus.deviceId, deviceId)),
  );
  return row;
}

const compliancePass = (f: Fixture) =>
  withSystemDbAccessContext(() => processCheckPolicy({ type: 'check-policy', policyId: f.policyId }));

async function addAgent(f: Fixture, values: { orgId: string; deviceId?: string | null; hostname?: string | null; status?: string }) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(huntressAgents).values({
      orgId: values.orgId,
      integrationId: f.integrationId,
      huntressAgentId: `agent-${Math.random().toString(36).slice(2)}`,
      deviceId: values.deviceId ?? null,
      hostname: values.hostname ?? null,
      status: values.status ?? 'online',
    }).returning({ id: huntressAgents.id }),
  );
  return row!.id;
}

async function setCompliance(f: Fixture, deviceId: string, opts: { missing: boolean; installRemediationStatus: string }) {
  await withSystemDbAccessContext(() =>
    db.update(softwareComplianceStatus)
      .set({
        status: opts.missing ? 'violation' : 'compliant',
        violations: opts.missing
          ? [{ type: 'missing', rule: { name: 'Huntress Agent*', catalogId: f.catalogId }, severity: 'high', detectedAt: new Date().toISOString() }]
          : [],
        installRemediationStatus: opts.installRemediationStatus,
      })
      .where(and(eq(softwareComplianceStatus.policyId, f.policyId), eq(softwareComplianceStatus.deviceId, deviceId))),
  );
}

async function coverageAlerts(deviceId: string, status?: string) {
  return withSystemDbAccessContext(() =>
    db.select({ id: alerts.id, status: alerts.status, kind: sql<string>`${alerts.context}->>'kind'`, orgId: alerts.orgId })
      .from(alerts)
      .where(and(
        eq(alerts.deviceId, deviceId),
        sql`${alerts.context}->>'source' = ${SECURITY_AGENT_COVERAGE_ALERT_SOURCE}`,
        ...(status ? [eq(alerts.status, status as 'active')] : []),
      )),
  );
}

describe('security agent coverage — live Postgres (#6960 W03)', () => {
  it('a compliance pass writes status rows under each DEVICE org with the readiness reason, and no deployment for unready orgs', async () => {
    const f = await seed();
    await compliancePass(f);

    const rows = await statusRows();
    const byDevice = new Map(rows.filter((r) => r.deviceId).map((r) => [r.deviceId!, r]));
    expect(byDevice.get(f.dev.a)).toMatchObject({ orgId: f.orgs.a.id, vendor: 'huntress', state: 'pending', reasonCode: null, policyId: f.policyId });
    expect(byDevice.get(f.dev.b)).toMatchObject({ orgId: f.orgs.b.id, state: 'not_applicable', reasonCode: 'org_key_missing', policyId: f.policyId });
    expect(byDevice.get(f.dev.c)).toMatchObject({ orgId: f.orgs.c.id, state: 'not_applicable', reasonCode: 'org_not_mapped', policyId: f.policyId });
    // The second partner is untouched.
    expect(byDevice.has(f.dev.z)).toBe(false);
    expect(rows.some((r) => r.orgId === f.orgs.z.id)).toBe(false);

    const deployments = await withSystemDbAccessContext(() =>
      db.select({ orgId: softwareDeployments.orgId }).from(softwareDeployments),
    );
    expect(deployments.filter((d) => d.orgId === f.orgs.b.id || d.orgId === f.orgs.c.id)).toEqual([]);
  });

  it('recovery clears not_applicable: once org C is mapped with a key, the next pass moves dC to pending', async () => {
    const f = await seed();
    await compliancePass(f);
    expect((await rowFor(f.dev.c))?.state).toBe('not_applicable');

    await withSystemDbAccessContext(() =>
      db.insert(huntressOrgMappings).values({
        integrationId: f.integrationId, partnerId: f.p.id, huntressOrgId: 'h-c', huntressOrgKey: 'ORGKEY-C', orgId: f.orgs.c.id,
      }),
    );
    await compliancePass(f);
    expect(await rowFor(f.dev.c)).toMatchObject({ state: 'pending', reasonCode: null });
  });

  it('an org-scoped session sees only its own org rows and cannot forge or change another org row (RLS)', async () => {
    const f = await seed();
    await compliancePass(f);

    const visible = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      db.select({ orgId: securityAgentDeviceStatus.orgId }).from(securityAgentDeviceStatus),
    );
    expect(visible.length).toBeGreaterThan(0);
    expect(new Set(visible.map((r) => r.orgId))).toEqual(new Set([f.orgs.a.id]));

    // Forge: org A's session inserts a row claiming org B.
    const forged = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      db.insert(securityAgentDeviceStatus).values({
        orgId: f.orgs.b.id, deviceId: null, vendorEndpointId: 'forged', vendor: 'huntress', state: 'vendor_only',
      }),
    ).then(() => null, (error: unknown) => error as { message?: string; cause?: { message?: string } });
    expect(forged, 'cross-tenant insert must be rejected').not.toBeNull();
    expect(`${forged?.cause?.message ?? ''} ${forged?.message ?? ''}`).toMatch(/new row violates row-level security policy/);

    const changed = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      db.update(securityAgentDeviceStatus)
        .set({ state: 'covered' })
        .where(eq(securityAgentDeviceStatus.deviceId, f.dev.b))
        .returning({ id: securityAgentDeviceStatus.id }),
    );
    expect(changed).toEqual([]);
    expect((await rowFor(f.dev.b))?.state).toBe('not_applicable');

    const otherPartner = await withDbAccessContext(orgContext(f.orgs.z.id, f.q.id), () =>
      db.select({ id: securityAgentDeviceStatus.id }).from(securityAgentDeviceStatus),
    );
    expect(otherPartner).toEqual([]);
  });

  it('read model: an org session gets its own org summary and rows (problems first), nothing of other orgs', async () => {
    const f = await seed();
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: true, installRemediationStatus: 'gave_up' });
    await reconcileOrgCoverage(f.orgs.a.id);
    await addAgent(f, { orgId: f.orgs.a.id, deviceId: null, hostname: 'ghost-host-read-model' });
    await reconcileOrgCoverage(f.orgs.a.id);

    const scope = { auth: { scope: 'organization', orgId: f.orgs.a.id }, allowedDeviceIds: null, allowedSiteIds: null } as unknown as EdrReadScope;
    const result = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      readSecurityAgentCoverage(scope, { limit: 50, offset: 0 }),
    );
    expect(result.summary).toEqual([
      expect.objectContaining({ vendor: 'huntress', total: 2, counts: expect.objectContaining({ gap: 1, vendor_only: 1 }) }),
    ]);
    expect(result.rows.map((r) => r.state)).toEqual(['gap', 'vendor_only']);
    expect(result.rows[0]).toMatchObject({ deviceId: f.dev.a, deviceName: f.host.a, orgId: f.orgs.a.id });
    expect(result.rows.every((r) => r.orgId === f.orgs.a.id)).toBe(true);

    const filtered = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      readSecurityAgentCoverage(scope, { states: ['vendor_only'], limit: 50, offset: 0 }),
    );
    expect(filtered.total).toBe(1);
    // A site-restricted user never sees device-less vendor_only rows.
    const siteScoped = await withDbAccessContext(orgContext(f.orgs.a.id, f.p.id), () =>
      readSecurityAgentCoverage({ ...scope, allowedDeviceIds: [f.dev.a] } as EdrReadScope, { limit: 50, offset: 0 }),
    );
    expect(siteScoped.rows.map((r) => r.state)).toEqual(['gap']);
  });

  it('fan-out source: the partner and its orgs with rows are listed, the other partner is not', async () => {
    const f = await seed();
    await compliancePass(f);
    const partners = await withSystemDbAccessContext(() => listCoveragePartners());
    expect(partners).toContain(f.p.id);
    expect(partners).not.toContain(f.q.id);
    const orgs = await withSystemDbAccessContext(() => listCoverageOrgsForPartner(f.p.id));
    expect([...orgs].sort()).toEqual([f.orgs.a.id, f.orgs.b.id, f.orgs.c.id].sort());
  });

  it('reconcile: covered from a linked agent; not_applicable rows are left alone', async () => {
    const f = await seed();
    await compliancePass(f);
    await addAgent(f, { orgId: f.orgs.a.id, deviceId: f.dev.a, hostname: f.host.a });

    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result).toMatchObject({ evaluated: 1, changed: 1, alertsRaised: 0 });
    expect(await rowFor(f.dev.a)).toMatchObject({ orgId: f.orgs.a.id, state: 'covered' });

    await reconcileOrgCoverage(f.orgs.b.id);
    expect(await rowFor(f.dev.b)).toMatchObject({ state: 'not_applicable', reasonCode: 'org_key_missing' });
  });

  it('gap alert fires once on transition, zero on steady state, and resolves when the device is covered', async () => {
    const f = await seed();
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: true, installRemediationStatus: 'gave_up' });

    const first = await reconcileOrgCoverage(f.orgs.a.id);
    expect(first.alertsRaised).toBe(1);
    expect(await rowFor(f.dev.a)).toMatchObject({ state: 'gap', reasonCode: 'install_failed' });
    const raised = await coverageAlerts(f.dev.a);
    expect(raised).toEqual([expect.objectContaining({ status: 'active', kind: 'gap', orgId: f.orgs.a.id })]);

    const second = await reconcileOrgCoverage(f.orgs.a.id);
    expect(second.alertsRaised).toBe(0);
    expect(await coverageAlerts(f.dev.a)).toHaveLength(1);

    await addAgent(f, { orgId: f.orgs.a.id, deviceId: f.dev.a, hostname: f.host.a });
    const third = await reconcileOrgCoverage(f.orgs.a.id);
    expect(third).toMatchObject({ alertsRaised: 0, alertsResolved: 1 });
    expect((await rowFor(f.dev.a))?.state).toBe('covered');
    expect(await coverageAlerts(f.dev.a, 'active')).toEqual([]);
  });

  it("mismatched_org: an agent in another org's Huntress account with dA's hostname alerts and redeploys nothing", async () => {
    const f = await seed();
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: false, installRemediationStatus: 'none' });
    const before = await withSystemDbAccessContext(() =>
      db.select({ id: softwareDeployments.id }).from(softwareDeployments).where(eq(softwareDeployments.orgId, f.orgs.a.id)),
    );
    await addAgent(f, { orgId: f.orgs.b.id, deviceId: null, hostname: f.host.a.toUpperCase() });

    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result.alertsRaised).toBe(1);
    expect(await rowFor(f.dev.a)).toMatchObject({ state: 'mismatched_org', reasonCode: 'vendor_org_mismatch' });
    expect((await rowFor(f.dev.a))?.detail ?? '').not.toContain(f.orgs.b.id);
    expect(await coverageAlerts(f.dev.a)).toEqual([expect.objectContaining({ kind: 'mismatched_org', orgId: f.orgs.a.id })]);
    const after = await withSystemDbAccessContext(() =>
      db.select({ id: softwareDeployments.id }).from(softwareDeployments).where(eq(softwareDeployments.orgId, f.orgs.a.id)),
    );
    expect(after).toHaveLength(before.length);

    // Org B's reconcile must not ALSO call that agent vendor_only (a partner device has its hostname).
    await reconcileOrgCoverage(f.orgs.b.id);
    const vendorOnlyB = (await statusRows()).filter((r) => r.orgId === f.orgs.b.id && r.state === 'vendor_only');
    expect(vendorOnlyB).toEqual([]);
  });

  it('vendor_only rows are idempotent across runs (partial unique index) and dropped once matched', async () => {
    const f = await seed();
    await compliancePass(f);
    const endpointId = await addAgent(f, { orgId: f.orgs.a.id, deviceId: null, hostname: 'ghost-host-not-enrolled' });

    await reconcileOrgCoverage(f.orgs.a.id);
    await reconcileOrgCoverage(f.orgs.a.id);
    const vendorOnly = (await statusRows()).filter((r) => r.state === 'vendor_only');
    expect(vendorOnly).toEqual([expect.objectContaining({ orgId: f.orgs.a.id, deviceId: null, vendorEndpointId: endpointId, policyId: null })]);

    // The agent's hostname now names a Breeze device in the partner → no longer vendor_only.
    await withSystemDbAccessContext(() =>
      db.update(devices).set({ hostname: 'ghost-host-not-enrolled' }).where(eq(devices.id, f.dev.b)),
    );
    await reconcileOrgCoverage(f.orgs.a.id);
    expect((await statusRows()).filter((r) => r.state === 'vendor_only')).toEqual([]);
  });

  it('deleting the owning config policy succeeds and leaves status rows (policy_id SET NULL); the next reconcile prunes them', async () => {
    const f = await seed();
    await compliancePass(f);
    expect((await statusRows()).filter((r) => r.policyId === f.policyId)).toHaveLength(3);

    await withSystemDbAccessContext(() =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.id, f.configPolicyId)),
    );
    const orphaned = (await statusRows()).filter((r) => [f.dev.a, f.dev.b, f.dev.c].includes(r.deviceId ?? ''));
    expect(orphaned).toHaveLength(3);
    expect(orphaned.every((r) => r.policyId === null)).toBe(true);

    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result.pruned).toBe(1);
    expect(await rowFor(f.dev.a)).toBeUndefined();
  });

  it("moving a device to another org restamps its status row's org_id (composite FK ON UPDATE CASCADE)", async () => {
    const f = await seed();
    await compliancePass(f);
    const target = await createOrganization({ partnerId: f.p.id });
    const site = await createSite({ orgId: target.id });

    await withSystemDbAccessContext(() =>
      db.update(devices).set({ orgId: target.id, siteId: site.id }).where(eq(devices.id, f.dev.c)),
    );
    expect(await rowFor(f.dev.c)).toMatchObject({ orgId: target.id, state: 'not_applicable' });
  });
});
