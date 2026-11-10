/**
 * The portal password fallback made visible (#11582, part of #11377).
 *
 * W4 D2 masks Microsoft sign-in off for an org whose Entra tenant is no longer
 * proven, and an `sso_only` org falls back to password. That fallback stays
 * exactly as it is. What this suite pins:
 *  - one `organization.portal_sign_in.password_fallback` audit row on the org
 *    whenever a PROVEN tenant is lost while Microsoft sign-in was on for it, on
 *    every path that loses one (MSP removal, AI for Office delete and repoint,
 *    displacement by another org's proof run), and none otherwise;
 *  - the admin notice on `GET …/portal-entra-tenant` (`passwordFallback`),
 *    derived from that row: it holds until the tenant is proven again or an
 *    admin dismisses it (`POST …/password-fallback/dismiss`).
 *
 * Runs as breeze_app under forced RLS through the real routers; fixtures and
 * read-backs use the superuser connection.
 */
import './setup';

vi.hoisted(() => {
  // config/env.ts reads this at import time; the AI for Office admin group is dark (404) without it.
  process.env.CLIENT_AI_ENTRA_CLIENT_ID = process.env.CLIENT_AI_ENTRA_CLIENT_ID || '11111111-1111-4111-8111-111111111111';
});

vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({ sendPortalEntraTenantDisplaced: async () => undefined }),
}));

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser, setupTestEnvironment } from './db-utils';
import { auditLogs, clientAiTenantMappings, partners, portalAccessPolicies } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { recordEntraTenantProof, type RecordEntraProofInput } from '../../services/portalEntraTenantProof';
import { clientAiAdminRoutes } from '../../routes/clientAi/admin';
import { registerPortalEntraTenantRoutes } from '../../routes/orgPortalEntraTenant';

const admin = () => getTestDb();
const newTenant = () => randomUUID();
const FALLBACK = 'organization.portal_sign_in.password_fallback';
const DISMISSED = 'organization.portal_sign_in.password_fallback_dismissed';

const ENV_KEYS = ['PORTAL_ENTRA_CLIENT_ID', 'PORTAL_ENTRA_CLIENT_SECRET', 'PORTAL_ENTRA_CALLBACK_BASE_URL'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // The portal Entra app is configured, so Microsoft is a capability of this deployment.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PORTAL_ENTRA_CLIENT_ID = '22222222-2222-4222-8222-222222222222';
  process.env.PORTAL_ENTRA_CLIENT_SECRET = 'portal-app-secret';
  process.env.PORTAL_ENTRA_CALLBACK_BASE_URL = 'https://portal.msp.example';
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

const proofRun = (orgId: string, tenantId: string, provenByUserId: string | null): RecordEntraProofInput => ({
  orgId, tenantId, via: 'proof_run', evidence: { adminOid: randomUUID(), runId: randomUUID() }, provenByUserId,
});

async function audits(orgId: string, action: string) {
  return admin().select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, action)));
}

async function setPolicy(values: typeof portalAccessPolicies.$inferInsert) {
  await admin().insert(portalAccessPolicies).values(values);
}

async function mspSession() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  await admin().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, env.partner.id));
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/client-ai/admin', clientAiAdminRoutes);
  const orgs = new Hono();
  orgs.use('*', authMiddleware);
  registerPortalEntraTenantRoutes(orgs);
  app.route('/', orgs);
  const headers = (body: boolean) => ({ Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) });
  const tenantRoute = (method: string, suffix = '') =>
    app.request(`/organizations/${env.organization.id}/portal-entra-tenant${suffix}`, { method, headers: headers(false) });
  const mapping = (method: 'PUT' | 'DELETE', entraTenantId?: string) =>
    app.request(`/client-ai/admin/orgs/${env.organization.id}/tenant-mapping`, {
      method,
      headers: headers(entraTenantId !== undefined),
      ...(entraTenantId !== undefined ? { body: JSON.stringify({ entraTenantId }) } : {}),
    });
  const notice = async () => {
    const res = await tenantRoute('GET');
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { passwordFallback: unknown } }).data.passwordFallback;
  };
  return { env, orgId: env.organization.id, tenantRoute, mapping, notice };
}

describe('password fallback audit + notice through the MSP tenant routes', () => {
  it('removing a proven tenant while Microsoft is on (partner default) audits the fallback once and raises the notice; dismiss clears it', async () => {
    const s = await mspSession();
    await setPolicy({ partnerId: s.env.partner.id, entraEnabled: true });
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(s.orgId, tenant, s.env.user.id));
    expect(await s.notice()).toBeNull();

    const res = await s.tenantRoute('DELETE');
    expect(res.status).toBe(200);
    // The response body is unchanged by #11582.
    expect(await res.json()).toEqual({ data: { removed: true, tenantId: tenant } });

    const rows = await audits(s.orgId, FALLBACK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'user',
      actorId: s.env.user.id,
      resourceType: 'organization',
      resourceId: s.orgId,
      resourceName: tenant,
      details: { tenantId: tenant, cause: 'tenant_removed', ssoOnlyLifted: false },
    });
    expect(await s.notice()).toEqual({ since: rows[0]!.timestamp.toISOString(), tenantId: tenant, cause: 'tenant_removed' });

    const dismiss = await s.tenantRoute('POST', '/password-fallback/dismiss');
    expect(dismiss.status).toBe(200);
    expect(await dismiss.json()).toEqual({ data: { dismissed: true } });
    expect(await s.notice()).toBeNull();
    expect(await audits(s.orgId, DISMISSED)).toHaveLength(1);

    // Nothing left to dismiss: no second row.
    expect(await (await s.tenantRoute('POST', '/password-fallback/dismiss')).json()).toEqual({ data: { dismissed: false } });
    expect(await audits(s.orgId, DISMISSED)).toHaveLength(1);
  });

  it('an org override of sso_only records ssoOnlyLifted: true (password sign-in came back)', async () => {
    const s = await mspSession();
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(s.orgId, tenant, s.env.user.id));
    await setPolicy({ orgId: s.orgId, entraEnabled: true, passwordMode: 'sso_only' });

    await s.tenantRoute('DELETE');
    const [row] = await audits(s.orgId, FALLBACK);
    expect(row?.details).toEqual({ tenantId: tenant, cause: 'tenant_removed', ssoOnlyLifted: true });
  });

  it('proving the tenant again clears the notice without a dismissal; a later loss raises it again', async () => {
    const s = await mspSession();
    await setPolicy({ partnerId: s.env.partner.id, entraEnabled: true });
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(s.orgId, tenant, s.env.user.id));
    await s.tenantRoute('DELETE');
    expect(await s.notice()).not.toBeNull();

    await recordEntraTenantProof(proofRun(s.orgId, tenant, s.env.user.id));
    expect(await s.notice()).toBeNull();

    await s.tenantRoute('DELETE');
    expect(await audits(s.orgId, FALLBACK)).toHaveLength(2);
    expect(await s.notice()).toMatchObject({ tenantId: tenant, cause: 'tenant_removed' });
  });

  it('Microsoft off for the org: losing the proof changes nothing users see → no audit, no notice', async () => {
    const s = await mspSession();
    await setPolicy({ partnerId: s.env.partner.id, entraEnabled: true });
    await setPolicy({ orgId: s.orgId, entraEnabled: false });
    await recordEntraTenantProof(proofRun(s.orgId, newTenant(), s.env.user.id));

    await s.tenantRoute('DELETE');
    expect(await audits(s.orgId, FALLBACK)).toHaveLength(0);
    expect(await s.notice()).toBeNull();
  });

  it('turning Microsoft off after the fallback hides the notice (the org is no longer falling back)', async () => {
    const s = await mspSession();
    await setPolicy({ partnerId: s.env.partner.id, entraEnabled: true });
    await recordEntraTenantProof(proofRun(s.orgId, newTenant(), s.env.user.id));
    await s.tenantRoute('DELETE');
    expect(await s.notice()).not.toBeNull();

    await setPolicy({ orgId: s.orgId, entraEnabled: false });
    expect(await s.notice()).toBeNull();
  });
});

describe('password fallback audit through the AI for Office mapping routes', () => {
  it('DELETE of a proven mapping audits the fallback; DELETE of an unproven one does not', async () => {
    const s = await mspSession();
    await setPolicy({ partnerId: s.env.partner.id, entraEnabled: true });
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(s.orgId, tenant, s.env.user.id));

    expect((await s.mapping('DELETE')).status).toBe(200);
    const rows = await audits(s.orgId, FALLBACK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual({ tenantId: tenant, cause: 'ai_for_office_mapping_removed', ssoOnlyLifted: false });

    // An unproven mapping was never a Microsoft sign-in path.
    expect((await s.mapping('PUT', newTenant())).status).toBe(200);
    expect((await s.mapping('DELETE')).status).toBe(200);
    expect(await audits(s.orgId, FALLBACK)).toHaveLength(1);
  });

  it('PUT to a different tenant (the trigger clears the proof) audits the fallback; re-saving the same tenant does not', async () => {
    const s = await mspSession();
    await setPolicy({ partnerId: s.env.partner.id, entraEnabled: true });
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(s.orgId, tenant, s.env.user.id));

    expect((await s.mapping('PUT', tenant)).status).toBe(200);
    expect(await audits(s.orgId, FALLBACK)).toHaveLength(0);

    expect((await s.mapping('PUT', newTenant())).status).toBe(200);
    const rows = await audits(s.orgId, FALLBACK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual({ tenantId: tenant, cause: 'ai_for_office_mapping_changed', ssoOnlyLifted: false });
    expect(await s.notice()).toMatchObject({ tenantId: tenant, cause: 'ai_for_office_mapping_changed' });
  });
});

describe('password fallback audit on displacement', () => {
  it("another org's proof run takes a proven tenant: the displaced org gets the fallback row (Microsoft on), the prover none", async () => {
    const victim = await createPartner();
    const victimOrg = await createOrganization({ partnerId: victim.id });
    await setPolicy({ partnerId: victim.id, entraEnabled: true });
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(victimOrg.id, tenant, null));

    const winner = await createPartner();
    const winnerOrg = await createOrganization({ partnerId: winner.id });
    const tech = await createUser({ partnerId: winner.id, email: `tech-${randomUUID()}@msp.test` });
    const outcome = await recordEntraTenantProof(proofRun(winnerOrg.id, tenant, tech.id));
    expect(outcome.displaced).toMatchObject({ orgId: victimOrg.id, wasProven: true });

    const rows = await audits(victimOrg.id, FALLBACK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'user',
      actorId: tech.id,
      resourceType: 'organization',
      resourceId: victimOrg.id,
      details: { tenantId: tenant, cause: 'tenant_displaced', ssoOnlyLifted: false },
    });
    expect(await audits(winnerOrg.id, FALLBACK)).toHaveLength(0);
  });

  it('displacing an UNPROVEN mapping, or a proven one in an org with Microsoft off, writes no fallback row', async () => {
    const tenant = newTenant();
    const unprovenPartner = await createPartner();
    const unprovenOrg = await createOrganization({ partnerId: unprovenPartner.id });
    await setPolicy({ partnerId: unprovenPartner.id, entraEnabled: true });
    await admin().insert(clientAiTenantMappings).values({ orgId: unprovenOrg.id, entraTenantId: tenant });

    const offPartner = await createPartner();
    const offOrg = await createOrganization({ partnerId: offPartner.id });
    await recordEntraTenantProof(proofRun(offOrg.id, tenant, null)); // displaces the unproven mapping

    const winnerOrg = await createOrganization({ partnerId: (await createPartner()).id });
    await recordEntraTenantProof(proofRun(winnerOrg.id, tenant, null)); // displaces offOrg's proven mapping

    expect(await audits(unprovenOrg.id, FALLBACK)).toHaveLength(0);
    expect(await audits(offOrg.id, FALLBACK)).toHaveLength(0);
  });
});
