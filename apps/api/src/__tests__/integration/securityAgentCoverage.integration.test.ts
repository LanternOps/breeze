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
import { describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts,
  configPolicyAssignments,
  configurationPolicies,
  deviceCommands,
  devices,
  huntressAgents,
  huntressIntegrations,
  huntressOrgMappings,
  s1Agents,
  s1Integrations,
  s1OrgMappings,
  securityAgentDeviceStatus,
  softwareComplianceStatus,
  softwareDeployments,
  softwarePolicies,
  softwareVersions,
} from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { addFeatureLink } from '../../services/configurationPolicy';
import { processCheckPolicy } from '../../jobs/softwareComplianceWorker';
import { processRemediateDeviceInstall } from '../../jobs/softwareRemediationWorker';
import {
  listCoverageOrgsForPartner,
  listCoveragePartners,
  reconcileOrgCoverage,
  type ReconcileDeps,
} from '../../services/securityAgents/coverageReconcileRun';
import {
  defaultCoverageAlertDeps,
  SECURITY_AGENT_COVERAGE_ALERT_SOURCE,
} from '../../services/securityAgents/coverageAlerts';
import { getVendorEndpointSource } from '../../services/securityAgents/vendorEndpointSources';
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
      // A synced integration: the reconciler trusts only a fresh vendor view.
      lastSyncAt: new Date(),
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

  // ---- review-round cases ------------------------------------------------

  async function secondDeviceInA(f: Fixture): Promise<string> {
    const site = await createSite({ orgId: f.orgs.a.id });
    return (await createDevice({ orgId: f.orgs.a.id, siteId: site.id, hostname: `cov-a2-${f.orgs.a.id.slice(0, 8)}` })).id;
  }

  it('alert cap: deferred transitions keep their prior state and are raised on the next run', async () => {
    const f = await seed();
    const dA2 = await secondDeviceInA(f);
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: true, installRemediationStatus: 'gave_up' });
    await setCompliance(f, dA2, { missing: true, installRemediationStatus: 'gave_up' });

    const first = await reconcileOrgCoverage(f.orgs.a.id, undefined, { maxAlertsPerRun: 1 });
    expect(first).toMatchObject({ alertsRaised: 1, alertsDeferred: 1 });
    const states = [(await rowFor(f.dev.a))?.state, (await rowFor(dA2))?.state].sort();
    expect(states).toEqual(['gap', 'pending']);

    const second = await reconcileOrgCoverage(f.orgs.a.id, undefined, { maxAlertsPerRun: 1 });
    expect(second).toMatchObject({ alertsRaised: 1, alertsDeferred: 0 });
    expect((await rowFor(f.dev.a))?.state).toBe('gap');
    expect((await rowFor(dA2))?.state).toBe('gap');
    expect(await coverageAlerts(f.dev.a)).toHaveLength(1);
    expect(await coverageAlerts(dA2)).toHaveLength(1);
  });

  it.each([
    ['returns false', async () => false],
    ['throws', async () => { throw new Error('alert pipeline down'); }],
  ])('a raise that %s keeps the prior state (retried next run), never a silent gap', async (_name, raise) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await seed();
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: true, installRemediationStatus: 'gave_up' });
    const failing: ReconcileDeps = { alerts: { ...defaultCoverageAlertDeps, raise }, sourceFor: getVendorEndpointSource };

    const result = await reconcileOrgCoverage(f.orgs.a.id, failing);
    expect(result).toMatchObject({ alertsRaised: 0, alertsDeferred: 1, changed: 0 });
    expect((await rowFor(f.dev.a))?.state).toBe('pending');

    const retried = await reconcileOrgCoverage(f.orgs.a.id);
    expect(retried.alertsRaised).toBe(1);
    expect((await rowFor(f.dev.a))?.state).toBe('gap');
    err.mockRestore();
  });

  it('a later compliance pass leaves a reconciled gap alone (same state_changed_at); unmapping the org moves it to not_applicable and resolves the alert', async () => {
    const f = await seed();
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: true, installRemediationStatus: 'gave_up' });
    await reconcileOrgCoverage(f.orgs.a.id);
    const gap = await rowFor(f.dev.a);
    expect(gap?.state).toBe('gap');

    await compliancePass(f);
    const after = await rowFor(f.dev.a);
    expect(after).toMatchObject({ state: 'gap', reasonCode: 'install_failed' });
    expect(after?.stateChangedAt.getTime()).toBe(gap?.stateChangedAt.getTime());

    await withSystemDbAccessContext(() => db.delete(huntressOrgMappings).where(eq(huntressOrgMappings.orgId, f.orgs.a.id)));
    await compliancePass(f);
    expect(await rowFor(f.dev.a)).toMatchObject({ state: 'not_applicable', reasonCode: 'org_not_mapped' });
    const resolved = await reconcileOrgCoverage(f.orgs.a.id);
    expect(resolved.alertsResolved).toBe(1);
    expect(await coverageAlerts(f.dev.a, 'active')).toEqual([]);
  });

  it('deactivating the generated policy prunes its rows on the next reconcile', async () => {
    const f = await seed();
    await compliancePass(f);
    await withSystemDbAccessContext(() =>
      db.update(softwarePolicies).set({ isActive: false }).where(eq(softwarePolicies.id, f.policyId)),
    );
    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result.pruned).toBe(1);
    expect(await rowFor(f.dev.a)).toBeUndefined();
  });

  it("an org whose last rows the compliance worker pruned stays in the fan-out until its open alerts are resolved", async () => {
    const f = await seed();
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: true, installRemediationStatus: 'gave_up' });
    await reconcileOrgCoverage(f.orgs.a.id);
    expect(await coverageAlerts(f.dev.a, 'active')).toHaveLength(1);

    // The policy stops reaching org A: the compliance worker deletes its rows directly.
    await withSystemDbAccessContext(() =>
      db.delete(securityAgentDeviceStatus).where(eq(securityAgentDeviceStatus.orgId, f.orgs.a.id)),
    );
    const orgs = await withSystemDbAccessContext(() => listCoverageOrgsForPartner(f.p.id));
    expect(orgs).toContain(f.orgs.a.id);

    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result.alertsResolved).toBe(1);
    expect(await coverageAlerts(f.dev.a, 'active')).toEqual([]);
    expect(await withSystemDbAccessContext(() => listCoverageOrgsForPartner(f.p.id))).not.toContain(f.orgs.a.id);
  });

  it('vendor_only rows are dropped once the org has no in-scope device rows for that vendor', async () => {
    const f = await seed();
    await compliancePass(f);
    await addAgent(f, { orgId: f.orgs.a.id, deviceId: null, hostname: 'ghost-host-scope-exit' });
    await reconcileOrgCoverage(f.orgs.a.id);
    expect((await statusRows()).filter((r) => r.orgId === f.orgs.a.id && r.state === 'vendor_only')).toHaveLength(1);

    await withSystemDbAccessContext(() =>
      db.delete(securityAgentDeviceStatus).where(and(
        eq(securityAgentDeviceStatus.orgId, f.orgs.a.id),
        eq(securityAgentDeviceStatus.deviceId, f.dev.a),
      )),
    );
    await reconcileOrgCoverage(f.orgs.a.id);
    expect((await statusRows()).filter((r) => r.orgId === f.orgs.a.id)).toEqual([]);
  });

  it('an unavailable vendor view (stale sync) changes nothing: covered stays covered and open alerts stay open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await seed();
    await compliancePass(f);
    await setCompliance(f, f.dev.a, { missing: false, installRemediationStatus: 'none' });
    await addAgent(f, { orgId: f.orgs.b.id, deviceId: f.dev.a, hostname: f.host.a });
    await reconcileOrgCoverage(f.orgs.a.id);
    expect((await rowFor(f.dev.a))?.state).toBe('mismatched_org');

    await withSystemDbAccessContext(() =>
      db.update(huntressIntegrations)
        .set({ lastSyncAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
        .where(eq(huntressIntegrations.id, f.integrationId)),
    );
    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result).toMatchObject({ evaluated: 0, changed: 0, alertsResolved: 0 });
    expect((await rowFor(f.dev.a))?.state).toBe('mismatched_org');
    expect(await coverageAlerts(f.dev.a, 'active')).toHaveLength(1);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// #6960 W04 — SentinelOne. Same partner-wide fan-out shape, S1 tables:
// partner P with an active, freshly synced S1 integration and the MSI uploaded
//   org A — site mapped, registration token present → dA pending, one deployment
//   org B — site mapped, NO token                  → dB not_applicable / org_key_missing
//   org C — no site mapped                         → dC not_applicable / org_not_mapped
// and partner Q (org Z / device dZ) untouched. Placeholder secrets only.
// ---------------------------------------------------------------------------

const S1_ENABLED = { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] };

async function seedS1() {
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
    host[key] = `s1cov-${key}-${orgs[key].id.slice(0, 8)}`;
    dev[key] = (await createDevice({ orgId: orgs[key].id, siteId: site.id, hostname: host[key] })).id;
  }

  return withSystemDbAccessContext(async () => {
    const [integration] = await db.insert(s1Integrations).values({
      partnerId: p.id,
      name: 'SentinelOne (test)',
      apiTokenEncrypted: encryptSecret('<s1-api-token>', { aad: 's1_integrations.api_token_encrypted' })!,
      managementUrl: 'https://<s1-mgmt-url>.example.invalid',
      isActive: true,
      lastSyncAt: new Date(),
    }).returning({ id: s1Integrations.id });
    await db.insert(s1OrgMappings).values([
      {
        integrationId: integration!.id, partnerId: p.id, s1SiteId: `site-a-${orgs.a.id.slice(0, 8)}`, orgId: orgs.a.id,
        registrationToken: encryptSecret('<site-token>', { aad: 's1_org_mappings.registration_token' })!,
      },
      { integrationId: integration!.id, partnerId: p.id, s1SiteId: `site-b-${orgs.b.id.slice(0, 8)}`, orgId: orgs.b.id, registrationToken: null },
    ]);
    const { catalogId } = await ensureBuiltinPackage({ provider: 'sentinelone', partnerId: p.id });
    await db.insert(softwareVersions).values({
      catalogId,
      version: '1.0.0',
      // A stored URL rather than an uploaded object, so dispatch completes
      // without S3 in the test stack. Placeholder host.
      downloadUrl: 'https://downloads.example.invalid/placeholder-sentinelone.msi',
      fileType: 'msi',
      originalFileName: 'placeholder-sentinelone.msi',
      supportedOs: ['windows'],
      silentInstallArgs: 'SITE_TOKEN={s1_site_token} /q /NORESTART',
      isLatest: true,
    });

    const [cp] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: p.id, name: 'Partner-wide SentinelOne', status: 'active' })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: cp!.id, level: 'partner', targetId: p.id });
    const link = await addFeatureLink(cp!.id, 'security_agents', null, S1_ENABLED, undefined, undefined, {
      securityAgentsArmAuthorized: true,
    });
    const [policy] = await db
      .select({
        id: softwarePolicies.id,
        orgId: softwarePolicies.orgId,
        partnerId: softwarePolicies.partnerId,
        approvalGeneration: softwarePolicies.approvalGeneration,
      })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.managedByLinkId, link!.id));
    return { p, q, orgs, dev, host, catalogId, integrationId: integration!.id, policy: policy! };
  });
}

type S1Fixture = Awaited<ReturnType<typeof seedS1>>;

async function addS1Agent(f: S1Fixture, values: { orgId: string; deviceId?: string | null; computerName?: string | null; status?: string }) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(s1Agents).values({
      orgId: values.orgId,
      integrationId: f.integrationId,
      s1AgentId: `s1-agent-${Math.random().toString(36).slice(2)}`,
      deviceId: values.deviceId ?? null,
      status: values.status ?? 'online',
      metadata: { computerName: values.computerName ?? null },
    }).returning({ id: s1Agents.id }),
  );
  return row!.id;
}

async function s1RowFor(deviceId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(securityAgentDeviceStatus)
      .where(and(eq(securityAgentDeviceStatus.deviceId, deviceId), eq(securityAgentDeviceStatus.vendor, 'sentinelone'))),
  );
  return row;
}

const s1CompliancePass = (f: S1Fixture) =>
  withSystemDbAccessContext(() => processCheckPolicy({ type: 'check-policy', policyId: f.policy.id }));

async function setS1Installed(f: S1Fixture, deviceId: string) {
  await withSystemDbAccessContext(() =>
    db.update(softwareComplianceStatus)
      .set({ status: 'compliant', violations: [], installRemediationStatus: 'none' })
      .where(and(eq(softwareComplianceStatus.policyId, f.policy.id), eq(softwareComplianceStatus.deviceId, deviceId))),
  );
}

function s1InstallJob(f: S1Fixture, deviceId: string) {
  return {
    type: 'install-remediate-device' as const,
    policyId: f.policy.id,
    deviceId,
    catalogIds: [f.catalogId],
    generation: f.policy.approvalGeneration,
    attempt: 1,
  };
}

async function forceS1Missing(f: S1Fixture, deviceId: string) {
  await withSystemDbAccessContext(() =>
    db.update(softwareComplianceStatus)
      .set({
        status: 'violation',
        violations: [{ type: 'missing', rule: { name: 'Sentinel Agent*', catalogId: f.catalogId }, severity: 'high', detectedAt: new Date().toISOString() }],
        installRemediationStatus: 'pending',
      })
      .where(and(eq(softwareComplianceStatus.policyId, f.policy.id), eq(softwareComplianceStatus.deviceId, deviceId))),
  );
}

const deploymentsIn = (orgId: string) => withSystemDbAccessContext(() =>
  db.select({ id: softwareDeployments.id }).from(softwareDeployments).where(eq(softwareDeployments.orgId, orgId)),
);

describe('security agent coverage — SentinelOne on live Postgres (#6960 W04)', () => {
  it('a partner-wide S1 link generates a PARTNER-owned policy (org_id NULL) with the S1 rule', async () => {
    const f = await seedS1();
    expect(f.policy).toMatchObject({ orgId: null, partnerId: f.p.id });
  });

  it("status rows land under each DEVICE's org with the readiness reason; one deployment for the ready org, none for the others", async () => {
    const f = await seedS1();
    await s1CompliancePass(f);

    expect(await s1RowFor(f.dev.a)).toMatchObject({ orgId: f.orgs.a.id, vendor: 'sentinelone', state: 'pending', reasonCode: null, policyId: f.policy.id });
    expect(await s1RowFor(f.dev.b)).toMatchObject({ orgId: f.orgs.b.id, state: 'not_applicable', reasonCode: 'org_key_missing' });
    expect(await s1RowFor(f.dev.c)).toMatchObject({ orgId: f.orgs.c.id, state: 'not_applicable', reasonCode: 'org_not_mapped' });
    expect(await s1RowFor(f.dev.z)).toBeUndefined();
    expect((await statusRows()).some((r) => r.orgId === f.orgs.z.id)).toBe(false);

    // The install job: the ready org queues exactly one deployment whose
    // command carries ITS site token; the unready orgs queue none even with a
    // (forced) cached missing violation.
    const ready = await processRemediateDeviceInstall(s1InstallJob(f, f.dev.a));
    expect(ready).toMatchObject({ deploymentsCreated: 1, errors: 0 });
    expect(await deploymentsIn(f.orgs.a.id)).toHaveLength(1);
    const commands = await withSystemDbAccessContext(() =>
      db.select({ payload: deviceCommands.payload }).from(deviceCommands).where(eq(deviceCommands.deviceId, f.dev.a)),
    );
    expect(JSON.stringify(commands.map((c) => c.payload))).toContain('SITE_TOKEN=<site-token>');

    for (const key of ['b', 'c'] as const) {
      await forceS1Missing(f, f.dev[key]);
      const notReady = await processRemediateDeviceInstall(s1InstallJob(f, f.dev[key]));
      expect(notReady, key).toMatchObject({ deploymentsCreated: 0 });
      expect(await deploymentsIn(f.orgs[key].id)).toEqual([]);
    }
    expect(await deploymentsIn(f.orgs.z.id)).toEqual([]);
  });

  it('an org-scoped session sees only its own org S1 rows; the other partner sees none', async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    const visible = await withDbAccessContext(orgContext(f.orgs.b.id, f.p.id), () =>
      db.select({ orgId: securityAgentDeviceStatus.orgId }).from(securityAgentDeviceStatus),
    );
    expect(visible.length).toBeGreaterThan(0);
    expect(new Set(visible.map((r) => r.orgId))).toEqual(new Set([f.orgs.b.id]));
    const otherPartner = await withDbAccessContext(orgContext(f.orgs.z.id, f.q.id), () =>
      db.select({ id: securityAgentDeviceStatus.id }).from(securityAgentDeviceStatus),
    );
    expect(otherPartner).toEqual([]);
  });

  it('reconcile through the s1_agents source: covered, then vendor_offline when S1 reports it offline', async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    const agentId = await addS1Agent(f, { orgId: f.orgs.a.id, deviceId: f.dev.a, computerName: f.host.a });

    await reconcileOrgCoverage(f.orgs.a.id);
    expect(await s1RowFor(f.dev.a)).toMatchObject({ state: 'covered', vendorEndpointId: agentId });

    await withSystemDbAccessContext(() => db.update(s1Agents).set({ status: 'offline' }).where(eq(s1Agents.id, agentId)));
    await reconcileOrgCoverage(f.orgs.a.id);
    expect(await s1RowFor(f.dev.a)).toMatchObject({ state: 'vendor_offline' });
    // not_applicable rows are never reconciled.
    await reconcileOrgCoverage(f.orgs.b.id);
    expect(await s1RowFor(f.dev.b)).toMatchObject({ state: 'not_applicable', reasonCode: 'org_key_missing' });
  });

  it("mismatched_org: an agent under org B's site carrying dA's computerName alerts and redeploys nothing", async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    await setS1Installed(f, f.dev.a);
    const before = await deploymentsIn(f.orgs.a.id);
    await addS1Agent(f, { orgId: f.orgs.b.id, deviceId: null, computerName: f.host.a.toUpperCase() });

    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result.alertsRaised).toBe(1);
    expect(await s1RowFor(f.dev.a)).toMatchObject({ state: 'mismatched_org', reasonCode: 'vendor_org_mismatch' });
    expect(await deploymentsIn(f.orgs.a.id)).toHaveLength(before.length);
  });

  it("a device moved into org A whose agent sync still files under org B's site is mismatched_org", async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    await addS1Agent(f, { orgId: f.orgs.b.id, deviceId: f.dev.a, computerName: f.host.a });
    await reconcileOrgCoverage(f.orgs.a.id);
    expect(await s1RowFor(f.dev.a)).toMatchObject({ state: 'mismatched_org', reasonCode: 'vendor_org_mismatch' });
  });

  it("another PARTNER's S1 agent carrying dA's computerName is never matched (integration filter)", async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    await setS1Installed(f, f.dev.a);
    await withSystemDbAccessContext(async () => {
      const [qIntegration] = await db.insert(s1Integrations).values({
        partnerId: f.q.id,
        name: 'SentinelOne (other partner)',
        apiTokenEncrypted: encryptSecret('<s1-api-token>', { aad: 's1_integrations.api_token_encrypted' })!,
        managementUrl: 'https://<s1-mgmt-url>.example.invalid',
        isActive: true,
        lastSyncAt: new Date(),
      }).returning({ id: s1Integrations.id });
      await db.insert(s1Agents).values({
        orgId: f.orgs.z.id, integrationId: qIntegration!.id, s1AgentId: `q-agent-${f.orgs.z.id.slice(0, 8)}`,
        deviceId: null, status: 'online', metadata: { computerName: f.host.a },
      });
    });
    const result = await reconcileOrgCoverage(f.orgs.a.id);
    expect(result.alertsRaised).toBe(0);
    expect(await s1RowFor(f.dev.a)).toMatchObject({ state: 'pending', reasonCode: 'awaiting_vendor_report' });
  });

  it('an unlinked in-org S1 agent no Breeze device matches is vendor_only', async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    const endpointId = await addS1Agent(f, { orgId: f.orgs.a.id, deviceId: null, computerName: 's1-ghost-not-enrolled' });
    await reconcileOrgCoverage(f.orgs.a.id);
    const vendorOnly = (await statusRows()).filter((r) => r.vendor === 'sentinelone' && r.state === 'vendor_only' && r.orgId === f.orgs.a.id);
    expect(vendorOnly).toEqual([expect.objectContaining({ vendorEndpointId: endpointId, deviceId: null })]);
  });

  it('a stale S1 sync makes the view unavailable: covered stays covered', async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    await addS1Agent(f, { orgId: f.orgs.a.id, deviceId: f.dev.a, computerName: f.host.a });
    await reconcileOrgCoverage(f.orgs.a.id);
    expect((await s1RowFor(f.dev.a))?.state).toBe('covered');

    await withSystemDbAccessContext(() =>
      db.update(s1Integrations).set({ lastSyncAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }).where(eq(s1Integrations.id, f.integrationId)),
    );
    // The agent row is gone too: a fresh-but-empty view would downgrade dA.
    await withSystemDbAccessContext(() => db.delete(s1Agents).where(eq(s1Agents.integrationId, f.integrationId)));
    await reconcileOrgCoverage(f.orgs.a.id);
    expect((await s1RowFor(f.dev.a))?.state).toBe('covered');
  });

  it('an installed device whose agent sits under an UNMAPPED site has no s1_agents row and stays pending', async () => {
    const f = await seedS1();
    await s1CompliancePass(f);
    await setS1Installed(f, f.dev.a);
    await reconcileOrgCoverage(f.orgs.a.id);
    expect(await s1RowFor(f.dev.a)).toMatchObject({ state: 'pending', reasonCode: 'awaiting_vendor_report' });
  });
});
