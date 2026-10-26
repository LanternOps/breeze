/**
 * Integration test — W11 (#6781) manage_security_policies, manage_compliance_policies and get_security_compliance
 * honour the org axis, the partner-wide gate and the site / exact-device axes against real Postgres as the
 * unprivileged `breeze_app` role (org-axis RLS genuinely enforced; the site axis and the partner-wide gate are
 * app-layer).
 *
 * Entry point: `executeTool`, so the central `deviceArgs` gate runs before the handler exactly as in production.
 * The human approval step lives in the chat layer (unit-tested in aiGuardrails.*): this suite pins the CLASS each
 * write is raised at (`checkGuardrails`) and then tests the scope behaviour that runs AFTER approval.
 *
 * Every refusal has a CONTROL: the same call by the caller the guard admits lands, and the stored row proves it.
 * Only the compliance-alert reconcile scheduler and the per-org probe cache invalidation (Redis/BullMQ) are stubbed.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn((..._a: unknown[]) => undefined),
  invalidate: vi.fn((..._a: unknown[]) => undefined),
}));
vi.mock('../../services/complianceAlertReconcileTrigger', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scheduleComplianceAlertReconcile: mocks.reconcile,
}));
vi.mock('../../services/agentOrgSettingsCache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateOrgPolicyProbeCache: mocks.invalidate,
}));

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import { automationPolicies, devices, securityPolicies, securityStatus } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
type Who = 'restricted' | 'orgAdmin' | 'otherOrg' | 'partnerAll' | 'partnerSel';

function makeAuth(opts: {
  userId: string; partnerId: string; orgIds: string[]; scope?: 'organization' | 'partner';
  partnerOrgAccess?: 'all' | 'selected'; allowedSiteIds?: string[]; allowedDeviceIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    partnerOrgAccess: opts.partnerOrgAccess,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    allowedDeviceIds: opts.allowedDeviceIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'w11-security-policy-writes' },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string; orgA: string; orgB: string; userId: string; siteA: string; siteB: string;
  devA: string; devB: string; devOther: string;
  secA: string; secB: string; secWide: string;
  cpA: string; cpB: string; cpWide: string;
  auth: Record<Who, AuthContext>;
}

async function seedDevice(orgId: string, siteId: string, firewallEnabled: boolean): Promise<string> {
  const db = getTestDb();
  const [row] = await db.insert(devices).values({
    orgId, siteId, agentId: `w11-sec-${randomUUID()}`, hostname: `w11-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  await db.insert(securityStatus).values({ deviceId: row!.id, orgId, provider: 'windows_defender', firewallEnabled, realTimeProtection: true } as typeof securityStatus.$inferInsert);
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const db = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W11 A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'W11 B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'W11 other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w11-${randomUUID()}@example.com` });
  const sec = async (v: { orgId: string | null; partnerId: string | null; name: string }) => {
    const [row] = await db.insert(securityPolicies).values({ ...v, settings: { scanSchedule: 'weekly', realTimeProtection: true } }).returning({ id: securityPolicies.id });
    return row!.id;
  };
  const cp = async (v: { orgId: string | null; partnerId: string | null; name: string }) => {
    const [row] = await db.insert(automationPolicies).values({ ...v, enabled: true, targets: {}, rules: [] } as typeof automationPolicies.$inferInsert).returning({ id: automationPolicies.id });
    return row!.id;
  };
  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, userId: user.id, siteA: siteA.id, siteB: siteB.id,
    devA: await seedDevice(orgA.id, siteA.id, true),
    devB: await seedDevice(orgA.id, siteB.id, false),
    devOther: await seedDevice(orgB.id, siteOther.id, false),
    secA: await sec({ orgId: orgA.id, partnerId: null, name: 'sec A' }),
    secB: await sec({ orgId: orgB.id, partnerId: null, name: 'sec B' }),
    secWide: await sec({ orgId: null, partnerId: partner.id, name: 'sec partner-wide' }),
    cpA: await cp({ orgId: orgA.id, partnerId: null, name: 'cp A' }),
    cpB: await cp({ orgId: orgB.id, partnerId: null, name: 'cp B' }),
    cpWide: await cp({ orgId: null, partnerId: partner.id, name: 'cp partner-wide' }),
    auth: {
      restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
      orgAdmin: makeAuth({ ...base, orgIds: [orgA.id] }),
      otherOrg: makeAuth({ ...base, orgIds: [orgB.id] }),
      partnerAll: makeAuth({ ...base, orgIds: [orgA.id, orgB.id], scope: 'partner', partnerOrgAccess: 'all' }),
      partnerSel: makeAuth({ ...base, orgIds: [orgA.id], scope: 'partner', partnerOrgAccess: 'selected' }),
    },
  };
}

function ctxFor(f: Fixture, who: Who, auth: AuthContext = f.auth[who]): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: f.partnerId, userId: f.userId,
  });
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>, auth: AuthContext = f.auth[who]) {
  const raw = await withDbAccessContext(ctxFor(f, who, auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

const secRow = async (id: string) => (await getTestDb().select().from(securityPolicies).where(eq(securityPolicies.id, id)))[0];
const cpEnabled = async (id: string) => (await getTestDb().select({ enabled: automationPolicies.enabled }).from(automationPolicies).where(eq(automationPolicies.id, id)))[0]?.enabled;

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  mocks.reconcile.mockClear();
  mocks.invalidate.mockClear();
  f = await seedFixture();
});

describe('the class each write is raised at (pinned here as well as in the guardrail contract)', () => {
  runDb('security-policy writes are supervised, a partner-wide create four-eyes; compliance deactivate by asserted owner', () => {
    expect(checkGuardrails('manage_security_policies', { action: 'update' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_security_policies', { action: 'create' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_security_policies', { action: 'create', ownerScope: 'partner' })).toMatchObject({ tier: 3, approvalScope: 'four_eyes' });
    expect(checkGuardrails('manage_compliance_policies', { action: 'deactivate', ownerScope: 'organization' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_compliance_policies', { action: 'deactivate', ownerScope: 'partner' })).toMatchObject({ tier: 3, approvalScope: 'four_eyes' });
  });
});

describe('manage_security_policies', () => {
  runDb('a partner-wide create needs full partner scope (CONTROL: partnerAll lands it with org_id NULL)', async () => {
    const sel = await run(f, 'partnerSel', 'manage_security_policies', { action: 'create', name: 'wide sel', ownerScope: 'partner' });
    expect(sel.body.code, sel.raw).toBe('ACCESS_DENIED');
    const all = await run(f, 'partnerAll', 'manage_security_policies', { action: 'create', name: 'wide all', ownerScope: 'partner' });
    expect(all.body.created, all.raw).toBe(true);
    const row = await secRow(all.body.policy.id);
    expect(row).toMatchObject({ orgId: null, partnerId: f.partnerId, name: 'wide all' });
  });

  runDb('a site-restricted caller cannot write org-wide policy (CONTROL: the org admin creates in its own org)', async () => {
    const restricted = await run(f, 'restricted', 'manage_security_policies', { action: 'create', name: 'site tech' });
    expect(restricted.body.code, restricted.raw).toBe('ACCESS_DENIED');
    const admin = await run(f, 'orgAdmin', 'manage_security_policies', { action: 'create', name: 'org admin', realTimeProtection: false });
    expect((await secRow(admin.body.policy.id))).toMatchObject({ orgId: f.orgA, partnerId: null });
  });

  runDb('an org caller cannot see or touch a partner-wide row; a selected-org partner caller sees it but cannot write it', async () => {
    const org = await run(f, 'orgAdmin', 'manage_security_policies', { action: 'update', policyId: f.secWide, name: 'hijack' });
    expect(org.body.code, org.raw).toBe('NOT_FOUND');
    const orgList = await run(f, 'orgAdmin', 'manage_security_policies', { action: 'list' });
    expect((orgList.body.policies as { id: string }[]).map((p) => p.id)).not.toContain(f.secWide);
    const sel = await run(f, 'partnerSel', 'manage_security_policies', { action: 'update', policyId: f.secWide, name: 'hijack' });
    expect(sel.body.code, sel.raw).toBe('ACCESS_DENIED');
    expect((await secRow(f.secWide))!.name).toBe('sec partner-wide');
    // CONTROL: full partner scope edits it.
    const all = await run(f, 'partnerAll', 'manage_security_policies', { action: 'update', policyId: f.secWide, autoQuarantine: false });
    expect(all.body.updated, all.raw).toBe(true);
    expect(((await secRow(f.secWide))!.settings as Record<string, unknown>).autoQuarantine).toBe(false);
  });

  runDb('another org\'s policy is not found and unchanged (CONTROL: its own org edits it); update never writes name into settings', async () => {
    const foreign = await run(f, 'otherOrg', 'manage_security_policies', { action: 'update', policyId: f.secA, name: 'x' });
    const missing = await run(f, 'otherOrg', 'manage_security_policies', { action: 'update', policyId: randomUUID(), name: 'x' });
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
    const own = await run(f, 'orgAdmin', 'manage_security_policies', { action: 'update', policyId: f.secA, name: 'renamed', exclusions: ['C:\\Tools'] });
    expect(own.body.updated, own.raw).toBe(true);
    const row = await secRow(f.secA);
    expect(row!.name).toBe('renamed');
    expect(row!.settings).toMatchObject({ exclusions: ['C:\\Tools'], scanSchedule: 'weekly' });
    expect(row!.settings).not.toHaveProperty('name');
  });
});

describe('manage_compliance_policies:deactivate', () => {
  runDb('an org policy: the org admin deactivates it (stored), another org cannot (not found, still enabled)', async () => {
    const foreign = await run(f, 'otherOrg', 'manage_compliance_policies', { action: 'deactivate', policyId: f.cpA, ownerScope: 'organization' });
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    expect(await cpEnabled(f.cpA)).toBe(true);
    const own = await run(f, 'orgAdmin', 'manage_compliance_policies', { action: 'deactivate', policyId: f.cpA, ownerScope: 'organization' });
    expect(own.body.deactivated, own.raw).toBe(true);
    expect(await cpEnabled(f.cpA)).toBe(false);
    expect(mocks.reconcile).toHaveBeenCalledWith({ orgId: f.orgA }, 'automation-policy-deactivate');
    expect(mocks.invalidate).toHaveBeenCalledWith(f.orgA);
  });

  runDb('a site-restricted caller is refused by the route\'s governance ceiling', async () => {
    const out = await run(f, 'restricted', 'manage_compliance_policies', { action: 'deactivate', policyId: f.cpA, ownerScope: 'organization' });
    expect(out.body.code, out.raw).toBe('ACCESS_DENIED');
    expect(await cpEnabled(f.cpA)).toBe(true);
  });

  runDb('a partner-wide policy: only full partner scope deactivates it, and only when the owner is asserted as partner', async () => {
    const org = await run(f, 'orgAdmin', 'manage_compliance_policies', { action: 'deactivate', policyId: f.cpWide, ownerScope: 'partner' });
    expect(org.body.code, org.raw).toBe('NOT_FOUND');
    const sel = await run(f, 'partnerSel', 'manage_compliance_policies', { action: 'deactivate', policyId: f.cpWide, ownerScope: 'partner' });
    expect(sel.body.code, sel.raw).toBe('ACCESS_DENIED');
    const cheaper = await run(f, 'partnerAll', 'manage_compliance_policies', { action: 'deactivate', policyId: f.cpWide, ownerScope: 'organization' });
    expect(cheaper.body.code, cheaper.raw).toBe('OWNER_SCOPE_MISMATCH');
    expect(await cpEnabled(f.cpWide)).toBe(true);
    // CONTROL: the asserted partner owner with full partner scope lands it.
    const all = await run(f, 'partnerAll', 'manage_compliance_policies', { action: 'deactivate', policyId: f.cpWide, ownerScope: 'partner' });
    expect(all.body).toMatchObject({ deactivated: true, partnerWide: true });
    expect(await cpEnabled(f.cpWide)).toBe(false);
    expect(mocks.invalidate).toHaveBeenCalledWith(undefined);
  });
});

describe('get_security_compliance (site and exact-device axes against stored rows)', () => {
  runDb('a site-restricted caller sees only its site\'s devices (CONTROL: the org admin sees both)', async () => {
    const restricted = await run(f, 'restricted', 'get_security_compliance', { view: 'firewall' });
    expect((restricted.body.devices as { deviceId: string }[]).map((d) => d.deviceId), restricted.raw).toEqual([f.devA]);
    const admin = await run(f, 'orgAdmin', 'get_security_compliance', { view: 'firewall' });
    expect((admin.body.devices as { deviceId: string }[]).map((d) => d.deviceId).sort()).toEqual([f.devA, f.devB].sort());
    expect(admin.raw).not.toContain(f.devOther);
    expect(admin.raw).not.toMatch(/rulesCount|profiles/);
  });

  runDb('a device-bound session gets its own device only, and no org-wide aggregate', async () => {
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devB] } as unknown as AuthContext;
    const list = await run(f, 'orgAdmin', 'get_security_compliance', { view: 'status' }, bound);
    expect((list.body.devices as { deviceId: string }[]).map((d) => d.deviceId), list.raw).toEqual([f.devB]);
    const agg = await run(f, 'orgAdmin', 'get_security_compliance', { view: 'dashboard' }, bound);
    expect(agg.body.code).toBe('ACCESS_DENIED');
    // CONTROL: the unbound org admin reads the dashboard.
    const own = await run(f, 'orgAdmin', 'get_security_compliance', { view: 'dashboard' });
    expect(own.body.view, own.raw).toBe('dashboard');
  });

  runDb('an out-of-site device on the status view is one opaque not-found (CONTROL: in-site reads)', async () => {
    const hidden = await run(f, 'restricted', 'get_security_compliance', { view: 'status', deviceId: f.devB });
    const foreign = await run(f, 'restricted', 'get_security_compliance', { view: 'status', deviceId: f.devOther });
    expect(hidden.body.error).toBeTruthy();
    expect(foreign.body.error).toBe(hidden.body.error);
    const inSite = await run(f, 'restricted', 'get_security_compliance', { view: 'status', deviceId: f.devA });
    expect(inSite.body.device?.deviceId, inSite.raw).toBe(f.devA);
  });
});
