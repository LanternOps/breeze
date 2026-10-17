/**
 * #6960 W01 — the security_agents write gates and the managed-policy 409s,
 * through the REAL routes (authMiddleware → requirePermission → requireMfa →
 * handler) on real Postgres with minted tokens. The mocked route tests prove
 * the branching; this proves nothing between the token and the row bypasses it.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityAgentsRoutes.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { configPolicyRoutes } from '../../routes/configurationPolicies';
import { softwarePoliciesRoutes } from '../../routes/softwarePolicies';
import {
  configPolicyFeatureLinks,
  configurationPolicies,
  softwarePolicies,
  softwarePolicyAudit,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/configuration-policies', configPolicyRoutes);
  app.route('/software-policies', softwarePoliciesRoutes);
  return app;
}

const DISABLED = { version: 1, agents: [{ vendor: 'huntress', enabled: false }] };
const ENABLED = { version: 1, agents: [{ vendor: 'huntress', enabled: true }] };
const S1_ENABLED = { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] };

async function seed(permissions: Array<{ resource: string; action: string }>) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(role.id, permissions);
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `sa-${randomUUID().slice(0, 8)}@example.test` });
  await assignUserToOrganization(user.id, org.id, role.id);
  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: org.id,
    partnerId: partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });

  const tdb = getTestDb() as any;
  const [cp] = await tdb
    .insert(configurationPolicies)
    .values({ orgId: org.id, name: `SA routes ${randomUUID().slice(0, 8)}`, status: 'active' })
    .returning({ id: configurationPolicies.id });
  return { orgId: org.id, partnerId: partner.id as string, token, configPolicyId: cp.id as string };
}

function call(app: Hono, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const RW_EXECUTE = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];
const RW_ONLY = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
];

describe('security_agents feature-link writes through the real route (#6960)', () => {
  it('stores a disabled-only link; refuses featurePolicyId, unknown keys, a not-enableable vendor, and Huntress without its catalog package', async () => {
    const app = buildApp();
    const { token, configPolicyId } = await seed(RW_EXECUTE);
    const base = `/configuration-policies/${configPolicyId}/features`;

    const withPolicyId = await call(app, token, 'POST', base, {
      featureType: 'security_agents', featurePolicyId: randomUUID(), inlineSettings: DISABLED,
    });
    expect(withPolicyId.status).toBe(400);
    expect((await withPolicyId.json()).code).toBe('security_agents_feature_policy_not_allowed');

    const secret = await call(app, token, 'POST', base, {
      featureType: 'security_agents', inlineSettings: { ...DISABLED, apiKey: '<acct-key>' },
    });
    expect(secret.status).toBe(400);

    const enablingS1 = await call(app, token, 'POST', base, { featureType: 'security_agents', inlineSettings: S1_ENABLED });
    expect(enablingS1.status).toBe(400);
    expect((await enablingS1.json()).code).toBe('vendor_not_enableable');

    // No Huntress integration connected → no partner catalog package → the
    // generator refuses inside the write transaction, and nothing is stored.
    const enabling = await call(app, token, 'POST', base, { featureType: 'security_agents', inlineSettings: ENABLED });
    expect(enabling.status).toBe(400);
    expect(await enabling.json()).toMatchObject({
      code: 'security_agents_catalog_missing',
      vendors: ['huntress'],
      setupPath: '/integrations#huntress',
    });
    const afterRefusal = await (getTestDb() as any)
      .select({ id: configPolicyFeatureLinks.id })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId));
    expect(afterRefusal).toEqual([]);

    const ok = await call(app, token, 'POST', base, { featureType: 'security_agents', inlineSettings: DISABLED });
    expect(ok.status).toBe(201);
    const link = await ok.json();

    const rows = await (getTestDb() as any)
      .select({ featurePolicyId: configPolicyFeatureLinks.featurePolicyId, inlineSettings: configPolicyFeatureLinks.inlineSettings })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId));
    expect(rows).toEqual([{ featurePolicyId: null, inlineSettings: DISABLED }]);

    const patchPolicyId = await call(app, token, 'PATCH', `${base}/${link.id}`, { featurePolicyId: randomUUID() });
    expect(patchPolicyId.status).toBe(400);
  });

  it('a writer without devices.execute cannot enable a vendor (403, before the enableable check)', async () => {
    const app = buildApp();
    const { token, configPolicyId } = await seed(RW_ONLY);
    const res = await call(app, token, 'POST', `/configuration-policies/${configPolicyId}/features`, {
      featureType: 'security_agents', inlineSettings: ENABLED,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('security_agents_execute_required');
  });
});

describe('generated software policies are read-only through the real route (#6960)', () => {
  it('PATCH, DELETE and manual remediation answer 409 with the owning config policy; the row is unchanged', async () => {
    const app = buildApp();
    const { orgId, token, configPolicyId } = await seed(RW_EXECUTE);
    const tdb = getTestDb() as any;
    const [link] = await tdb
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId, featureType: 'security_agents', inlineSettings: DISABLED })
      .returning({ id: configPolicyFeatureLinks.id });
    const [policy] = await tdb
      .insert(softwarePolicies)
      .values({
        orgId,
        name: 'Generated',
        mode: 'allowlist',
        rules: { software: [], allowUnknown: true },
        enforceMode: true,
        remediationOptions: { autoInstall: true, autoUninstall: false },
        managedByLinkId: link.id,
      })
      .returning({ id: softwarePolicies.id });

    for (const [method, path, body] of [
      ['PATCH', `/software-policies/${policy.id}`, { name: 'Renamed' }],
      ['DELETE', `/software-policies/${policy.id}`, undefined],
      ['POST', `/software-policies/${policy.id}/remediate`, {}],
    ] as const) {
      const res = await call(app, token, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'managed_software_policy_read_only', configPolicyId });
    }

    const [after] = await tdb
      .select({ name: softwarePolicies.name, isActive: softwarePolicies.isActive, managedByLinkId: softwarePolicies.managedByLinkId })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.id, policy.id));
    expect(after).toEqual({ name: 'Generated', isActive: true, managedByLinkId: link.id });
  });

  it('POST refuses a caller-supplied managedByLinkId and creates nothing', async () => {
    const app = buildApp();
    const { orgId, token } = await seed(RW_EXECUTE);
    const res = await call(app, token, 'POST', '/software-policies', {
      orgId,
      name: 'Smuggled',
      mode: 'allowlist',
      rules: { software: [{ name: 'Anything' }] },
      managedByLinkId: randomUUID(),
    });
    expect(res.status).toBe(400);
    const rows = await (getTestDb() as any)
      .select({ id: softwarePolicies.id })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.orgId, orgId));
    expect(rows).toEqual([]);
  });
});

async function generatedFor(linkId: string) {
  const rows = await (getTestDb() as any)
    .select()
    .from(softwarePolicies)
    .where(eq(softwarePolicies.managedByLinkId, linkId));
  return rows as Array<typeof softwarePolicies.$inferSelect>;
}

describe('the generated software policy follows the link through the real route (#6960 W02)', () => {
  it('enable creates it; disable deactivates (same row); re-enable reuses it; generation bumps only on change', async () => {
    const app = buildApp();
    const { orgId, partnerId, token, configPolicyId } = await seed(RW_EXECUTE);
    const { catalogId } = await ensureBuiltinPackage({ provider: 'huntress', partnerId });
    const base = `/configuration-policies/${configPolicyId}/features`;

    const created = await call(app, token, 'POST', base, { featureType: 'security_agents', inlineSettings: ENABLED });
    expect(created.status).toBe(201);
    const link = await created.json();

    const [policy] = await generatedFor(link.id);
    expect(policy).toMatchObject({
      orgId,
      partnerId: null,
      mode: 'allowlist',
      enforceMode: true,
      isActive: true,
      approvalGeneration: 1,
      remediationOptions: { autoInstall: true, autoUninstall: false },
    });
    expect(policy!.rules).toMatchObject({ allowUnknown: true, software: [{ name: 'Huntress Agent*', catalogId }] });

    const audits = await (getTestDb() as any)
      .select({ action: softwarePolicyAudit.action, actor: softwarePolicyAudit.actor })
      .from(softwarePolicyAudit)
      .where(eq(softwarePolicyAudit.policyId, policy!.id));
    expect(audits).toEqual([{ action: 'policy_created', actor: 'user' }]);

    const disabled = await call(app, token, 'PATCH', `${base}/${link.id}`, { inlineSettings: DISABLED });
    expect(disabled.status).toBe(200);
    const afterDisable = await generatedFor(link.id);
    expect(afterDisable).toHaveLength(1);
    expect(afterDisable[0]).toMatchObject({ id: policy!.id, isActive: false, approvalGeneration: 2 });
    expect(afterDisable[0]!.rules.software).toEqual([]);

    // Saving the same settings again changes nothing (no generation churn).
    await call(app, token, 'PATCH', `${base}/${link.id}`, { inlineSettings: DISABLED });
    expect((await generatedFor(link.id))[0]).toMatchObject({ approvalGeneration: 2 });

    const reEnabled = await call(app, token, 'PATCH', `${base}/${link.id}`, { inlineSettings: ENABLED });
    expect(reEnabled.status).toBe(200);
    expect((await generatedFor(link.id))[0]).toMatchObject({ id: policy!.id, isActive: true, approvalGeneration: 3 });

    // The generated row is read-only through the software-policy route…
    const patchGenerated = await call(app, token, 'PATCH', `/software-policies/${policy!.id}`, { name: 'Hijacked' });
    expect(patchGenerated.status).toBe(409);
    // …and cannot be linked as an ordinary software_policy feature.
    const linkGenerated = await call(app, token, 'POST', base, { featureType: 'software_policy', featurePolicyId: policy!.id });
    expect(linkGenerated.status).toBe(400);

    // Removing the link removes the generated policy (cascade), never uninstalls.
    const removed = await call(app, token, 'DELETE', `${base}/${link.id}`);
    expect(removed.status).toBe(200);
    expect(await generatedFor(link.id)).toEqual([]);
  });

  it('a writer without devices.execute may disable an enabled vendor (disarming), and it deactivates', async () => {
    const app = buildApp();
    const { partnerId, token, configPolicyId } = await seed(RW_EXECUTE);
    await ensureBuiltinPackage({ provider: 'huntress', partnerId });
    const base = `/configuration-policies/${configPolicyId}/features`;
    const link = await (await call(app, token, 'POST', base, { featureType: 'security_agents', inlineSettings: ENABLED })).json();

    const { token: writerToken } = await (async () => {
      const tdb = getTestDb() as any;
      const [cpRow] = await tdb.select({ orgId: configurationPolicies.orgId }).from(configurationPolicies)
        .where(eq(configurationPolicies.id, configPolicyId));
      const role = await createRole({ scope: 'organization', orgId: cpRow.orgId, partnerId });
      await grantRolePermissions(role.id, RW_ONLY);
      const user = await createUser({ partnerId, orgId: cpRow.orgId, email: `sa-w-${randomUUID().slice(0, 8)}@example.test` });
      await assignUserToOrganization(user.id, cpRow.orgId, role.id);
      return {
        token: await createAccessToken({
          sub: user.id, email: user.email, roleId: role.id, orgId: cpRow.orgId, partnerId,
          scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
        }),
      };
    })();

    const res = await call(app, writerToken, 'PATCH', `${base}/${link.id}`, { inlineSettings: DISABLED });
    expect(res.status).toBe(200);
    expect((await generatedFor(link.id))[0]).toMatchObject({ isActive: false });
  });

  it('a partner-wide config policy generates a PARTNER-owned policy (org_id NULL)', async () => {
    const app = buildApp();
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const { catalogId } = await ensureBuiltinPackage({ provider: 'huntress', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: null, email: `sa-p-${randomUUID().slice(0, 8)}@example.test` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const token = await createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId: partner.id, scope: 'partner',
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const [cp] = await (getTestDb() as any)
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: partner.id, name: `SA partner-wide ${randomUUID().slice(0, 8)}`, status: 'active' })
      .returning({ id: configurationPolicies.id });

    const res = await call(app, token, 'POST', `/configuration-policies/${cp.id}/features`, {
      featureType: 'security_agents', inlineSettings: ENABLED,
    });
    expect(res.status).toBe(201);
    const link = await res.json();
    const [policy] = await generatedFor(link.id);
    expect(policy).toMatchObject({ orgId: null, partnerId: partner.id, isActive: true });
    expect(policy!.rules.software).toEqual([expect.objectContaining({ catalogId })]);

    const partnerAudit = await (getTestDb() as any)
      .select({ partnerId: softwarePolicyAudit.partnerId, orgId: softwarePolicyAudit.orgId })
      .from(softwarePolicyAudit)
      .where(and(eq(softwarePolicyAudit.policyId, policy!.id), eq(softwarePolicyAudit.action, 'policy_created')));
    expect(partnerAudit).toEqual([{ partnerId: partner.id, orgId: null }]);
  });
});
