/**
 * Integration test — W04 (#6758) policy, remediation, training and network
 * write tools honour the partner-wide gate, the site axis and the org axis,
 * against real Postgres as the unprivileged `breeze_app` role (org-axis RLS
 * genuinely enforced; the site axis and the partner-wide gate are app-layer).
 *
 * Tools: manage_software_policy, manage_browser_policy,
 * manage_peripheral_policy, remediate_sensitive_data,
 * remediate_software_violation, assign_security_training,
 * configure_network_baseline, acknowledge_network_device.
 *
 * Entry point: `executeTool`, so the CENTRAL `enforceDeviceArgs` gate (the
 * tools' `deviceArgs`) runs before the handler exactly as in production. Most
 * of these are Tier 3; the human approval step lives in the chat layer
 * (unit-tested in aiGuardrails.*), not in `executeTool`, so this suite tests
 * the scope behaviour that runs AFTER approval.
 *
 * Fixture: partner P owns org A (sites A and B, a device in each) and org B (a
 * device, policies, users, baselines, findings of its own). Callers:
 *   restricted    org A, site-restricted to site A
 *   orgAdmin      org A, unrestricted
 *   otherOrg      org B
 *   partnerAll    partner scope, orgAccess "all"      (canManagePartnerWidePolicies)
 *   partnerSel    partner scope, orgAccess "selected" (org A only; NOT partner-wide)
 *
 * Partner-wide rows (org_id NULL, partner_id set) exist for software and
 * peripheral policies. `browser_policies.org_id` is NOT NULL, so browser
 * policies have no partner-wide shape: that tool's cross-org / site axes are
 * covered instead.
 *
 * Only the BullMQ schedulers (`scheduleSoftwareComplianceCheck`,
 * `scheduleSoftwareRemediation`, `schedulePeripheralPolicyDevices`), the device
 * command dispatch (`aiDispatchDeviceCommand`, `aiQueueCommand`) and the Redis
 * event bus are stubbed; every refusal under test happens before them.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  scheduleSoftwareComplianceCheck: vi.fn(async (..._a: unknown[]) => undefined),
  scheduleSoftwareRemediation: vi.fn(async (_policyId: string, deviceIds: string[]) => deviceIds.length),
  schedulePeripheralPolicyDevices: vi.fn(async (..._a: unknown[]) => undefined),
  aiDispatchDeviceCommand: vi.fn(async (_auth: unknown, _tool: string, input: { deviceId: string }) => ({
    ok: true as const,
    command: { id: crypto.randomUUID(), deviceId: input.deviceId },
  })),
  aiQueueCommand: vi.fn(async (..._a: unknown[]) => ({ id: crypto.randomUUID() })),
  publishEvent: vi.fn(async (..._a: unknown[]) => 'test-event-id'),
}));

vi.mock('../../jobs/softwareComplianceWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/softwareComplianceWorker')>();
  return { ...actual, scheduleSoftwareComplianceCheck: mocks.scheduleSoftwareComplianceCheck };
});
vi.mock('../../jobs/softwareRemediationWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/softwareRemediationWorker')>();
  return { ...actual, scheduleSoftwareRemediation: mocks.scheduleSoftwareRemediation };
});
vi.mock('../../jobs/peripheralJobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/peripheralJobs')>();
  return { ...actual, schedulePeripheralPolicyDevices: mocks.schedulePeripheralPolicyDevices };
});
vi.mock('../../services/aiDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiDispatch')>();
  return {
    ...actual,
    aiDispatchDeviceCommand: mocks.aiDispatchDeviceCommand,
    aiQueueCommand: mocks.aiQueueCommand,
  };
});
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: mocks.publishEvent };
});

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import {
  browserPolicies,
  devices,
  networkBaselines,
  networkChangeEvents,
  organizationUsers,
  peripheralPolicies,
  sensitiveDataFindings,
  sensitiveDataScans,
  softwareComplianceStatus,
  softwarePolicies,
  userRiskEvents,
} from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createRole, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const DEVICE_DENIED = 'Device not found or access denied';
const POLICY_DENIED = 'Policy not found or access denied';
const SITE_CEILING = 'Site-restricted users cannot modify organization-wide settings. Ask an unrestricted administrator.';
const PARTNER_WIDE_SOFTWARE = 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")';
const PARTNER_WIDE_PERIPHERAL = 'Modifying a partner-wide peripheral policy requires full partner org access (orgAccess must be "all")';

type Who = 'restricted' | 'orgAdmin' | 'otherOrg' | 'partnerAll' | 'partnerSel';

function makeAuth(opts: {
  userId: string;
  partnerId: string;
  orgIds: string[];
  scope?: 'organization' | 'partner';
  partnerOrgAccess?: 'all' | 'selected';
  allowedSiteIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    // assign_security_training re-checks MFA when 2FA is enabled.
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    partnerOrgAccess: opts.partnerOrgAccess,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'policy-writes-scope' },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  siteA: string;
  siteB: string;
  siteOther: string;
  devA: string;
  devB: string;
  devOther: string;
  swA: string;
  swB: string;
  swWide: string;
  swArmed: string;
  perA: string;
  perB: string;
  perWide: string;
  brSiteA: string;
  brSiteB: string;
  brOther: string;
  findA: string;
  findB: string;
  findOther: string;
  trainA: string;
  trainB: string;
  trainOther: string;
  baseA: string;
  baseB: string;
  baseOther: string;
  evA: string;
  evB: string;
  evOther: string;
  auth: Record<Who, AuthContext>;
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `policy-writes-${randomUUID()}`,
    hostname: `pw-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const testDb = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'Policy writes A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'Policy writes B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'Policy writes other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `pw-${randomUUID()}@example.com` });

  const devA = await seedDevice(orgA.id, siteA.id);
  const devB = await seedDevice(orgA.id, siteB.id);
  const devOther = await seedDevice(orgB.id, siteOther.id);

  const software = async (v: Partial<typeof softwarePolicies.$inferInsert> & { name: string }) => {
    const [row] = await testDb.insert(softwarePolicies).values({
      mode: 'blocklist',
      rules: { software: [{ name: 'Bad App' }], allowUnknown: false } as any,
      ...v,
    }).returning({ id: softwarePolicies.id });
    return row!.id;
  };
  const peripheral = async (v: Partial<typeof peripheralPolicies.$inferInsert> & { name: string }) => {
    const [row] = await testDb.insert(peripheralPolicies).values({
      deviceClass: 'storage',
      action: 'block',
      targetType: 'organization',
      ...v,
    }).returning({ id: peripheralPolicies.id });
    return row!.id;
  };
  const browser = async (orgId: string, name: string, targetType: string, targetIds: string[]) => {
    const [row] = await testDb.insert(browserPolicies).values({
      orgId, name, targetType, targetIds, allowedExtensions: [], blockedExtensions: [], requiredExtensions: [],
    }).returning({ id: browserPolicies.id });
    return row!.id;
  };

  const swA = await software({ orgId: orgA.id, name: 'sw A' });
  const swArmed = await software({
    orgId: orgA.id, name: 'sw armed', enforceMode: true, remediationOptions: { autoUninstall: true } as any,
  });
  // The violation fallback (no deviceIds) enumerates violating devices org-wide.
  await testDb.insert(softwareComplianceStatus).values([devA, devB].map((deviceId) => ({
    deviceId, policyId: swArmed, status: 'violation', lastChecked: new Date(),
  })));

  const finding = async (orgId: string, deviceId: string) => {
    const [scan] = await testDb.insert(sensitiveDataScans).values({ orgId, deviceId, status: 'completed' })
      .returning({ id: sensitiveDataScans.id });
    const [row] = await testDb.insert(sensitiveDataFindings).values({
      orgId, deviceId, scanId: scan!.id, filePath: `C:\\scope\\${randomUUID()}.txt`,
      dataType: 'pii', patternId: 'ssn', risk: 'high',
    }).returning({ id: sensitiveDataFindings.id });
    return row!.id;
  };

  const [roleA] = [await createRole({ scope: 'organization', orgId: orgA.id })];
  const [roleB] = [await createRole({ scope: 'organization', orgId: orgB.id })];
  const member = async (orgId: string, roleId: string, siteIds: string[]) => {
    const u = await createUser({ partnerId: partner.id, orgId, email: `pw-member-${randomUUID()}@example.com` });
    await testDb.insert(organizationUsers).values({ userId: u.id, orgId, roleId, siteIds });
    return u.id;
  };

  const baseline = async (orgId: string, siteId: string, subnet: string) => {
    const [row] = await testDb.insert(networkBaselines).values({
      orgId, siteId, subnet, knownDevices: [], scanSchedule: { enabled: true, intervalHours: 4 } as any,
    }).returning({ id: networkBaselines.id });
    return row!.id;
  };
  const baseA = await baseline(orgA.id, siteA.id, '10.1.0.0/24');
  const baseB = await baseline(orgA.id, siteB.id, '10.2.0.0/24');
  const baseOther = await baseline(orgB.id, siteOther.id, '10.3.0.0/24');
  const event = async (orgId: string, siteId: string, baselineId: string, ip: string) => {
    const [row] = await testDb.insert(networkChangeEvents).values({
      orgId, siteId, baselineId, eventType: 'new_device', ipAddress: ip,
    }).returning({ id: networkChangeEvents.id });
    return row!.id;
  };

  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    siteA: siteA.id,
    siteB: siteB.id,
    siteOther: siteOther.id,
    devA,
    devB,
    devOther,
    swA,
    swB: await software({ orgId: orgB.id, name: 'sw B' }),
    swWide: await software({ partnerId: partner.id, orgId: null, name: 'sw partner-wide' }),
    swArmed,
    perA: await peripheral({ orgId: orgA.id, name: 'per A' }),
    perB: await peripheral({ orgId: orgB.id, name: 'per B' }),
    perWide: await peripheral({ partnerId: partner.id, orgId: null, name: 'per partner-wide' }),
    brSiteA: await browser(orgA.id, 'br site A', 'site', [siteA.id]),
    brSiteB: await browser(orgA.id, 'br site B', 'site', [siteB.id]),
    brOther: await browser(orgB.id, 'br other', 'org', []),
    findA: await finding(orgA.id, devA),
    findB: await finding(orgA.id, devB),
    findOther: await finding(orgB.id, devOther),
    trainA: await member(orgA.id, roleA.id, [siteA.id]),
    trainB: await member(orgA.id, roleA.id, [siteB.id]),
    trainOther: await member(orgB.id, roleB.id, [siteOther.id]),
    baseA,
    baseB,
    baseOther,
    evA: await event(orgA.id, siteA.id, baseA, '10.1.0.10'),
    evB: await event(orgA.id, siteB.id, baseB, '10.2.0.10'),
    evOther: await event(orgB.id, siteOther.id, baseOther, '10.3.0.10'),
    auth: {
      restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
      orgAdmin: makeAuth({ ...base, orgIds: [orgA.id] }),
      otherOrg: makeAuth({ ...base, orgIds: [orgB.id] }),
      partnerAll: makeAuth({ ...base, orgIds: [orgA.id, orgB.id], scope: 'partner', partnerOrgAccess: 'all' }),
      partnerSel: makeAuth({ ...base, orgIds: [orgA.id], scope: 'partner', partnerOrgAccess: 'selected' }),
    },
  };
}

function ctxFor(f: Fixture, who: Who): DbAccessContext {
  const auth = f.auth[who];
  return buildDbAccessContext({
    scope: auth.scope,
    orgId: auth.orgId,
    accessibleOrgIds: auth.accessibleOrgIds ?? [],
    partnerId: f.partnerId,
    userId: f.userId,
  });
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(ctxFor(f, who), () => executeTool(tool, input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const db = () => getTestDb();
const swName = async (id: string) => (await db().select().from(softwarePolicies).where(eq(softwarePolicies.id, id)))[0]!;
const perRow = async (id: string) => (await db().select().from(peripheralPolicies).where(eq(peripheralPolicies.id, id)))[0]!;
const brRow = async (id: string) => (await db().select().from(browserPolicies).where(eq(browserPolicies.id, id)))[0]!;
const findingRow = async (id: string) => (await db().select().from(sensitiveDataFindings).where(eq(sensitiveDataFindings.id, id)))[0]!;
const baselineRow = async (id: string) => (await db().select().from(networkBaselines).where(eq(networkBaselines.id, id)))[0]!;
const eventRow = async (id: string) => (await db().select().from(networkChangeEvents).where(eq(networkChangeEvents.id, id)))[0]!;

describe('W04 policy / remediation / training / network write tools — scope (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    Object.values(mocks).forEach((m) => m.mockClear());
    f = await seedFixture();
  });

  describe('manage_software_policy', () => {
    const rename = (policyId: string) => ({ action: 'update', policyId, name: 'renamed' });
    const disable = (policyId: string) => ({ action: 'delete', policyId });

    runDb('an org caller updates and disables its own policy, but not another org\'s (not found)', async () => {
      const ok = await run(f, 'orgAdmin', 'manage_software_policy', rename(f.swA));
      expect(ok.error).toBeUndefined();
      expect((await swName(f.swA)).name).toBe('renamed');

      expect(await run(f, 'orgAdmin', 'manage_software_policy', rename(f.swB))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'orgAdmin', 'manage_software_policy', disable(f.swB))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'otherOrg', 'manage_software_policy', rename(f.swA))).toEqual({ error: POLICY_DENIED });
      const b = await swName(f.swB);
      expect(b.name).toBe('sw B');
      expect(b.isActive).toBe(true);

      const off = await run(f, 'orgAdmin', 'manage_software_policy', disable(f.swA));
      expect(off.error).toBeUndefined();
      expect((await swName(f.swA)).isActive).toBe(false);
    });

    runDb('an org caller cannot touch a partner-wide row (not found), read it, or write cross-org', async () => {
      expect(await run(f, 'orgAdmin', 'manage_software_policy', rename(f.swWide))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'orgAdmin', 'manage_software_policy', disable(f.swWide))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'orgAdmin', 'manage_software_policy', { action: 'get', policyId: f.swWide })).toEqual({ error: POLICY_DENIED });
      const wide = await swName(f.swWide);
      expect(wide.name).toBe('sw partner-wide');
      expect(wide.isActive).toBe(true);

      const create = await run(f, 'orgAdmin', 'manage_software_policy', {
        action: 'create', name: 'x-org', mode: 'blocklist', orgId: f.orgB, software: [{ name: 'Bad' }],
      });
      expect(create.error).toBe('Cannot access another organization');
      const rows = await db().select({ id: softwarePolicies.id }).from(softwarePolicies).where(eq(softwarePolicies.name, 'x-org'));
      expect(rows).toHaveLength(0);
    });

    runDb('a partner caller WITHOUT full org access sees the partner-wide row but cannot write it', async () => {
      const seen = await run(f, 'partnerSel', 'manage_software_policy', { action: 'get', policyId: f.swWide });
      expect(seen.policy?.id).toBe(f.swWide);

      expect(await run(f, 'partnerSel', 'manage_software_policy', rename(f.swWide))).toEqual({ error: PARTNER_WIDE_SOFTWARE });
      expect(await run(f, 'partnerSel', 'manage_software_policy', disable(f.swWide))).toEqual({ error: PARTNER_WIDE_SOFTWARE });
      const wide = await swName(f.swWide);
      expect(wide.name).toBe('sw partner-wide');
      expect(wide.isActive).toBe(true);
      // ...and still cannot reach another org's policy
      expect(await run(f, 'partnerSel', 'manage_software_policy', rename(f.swB))).toEqual({ error: POLICY_DENIED });
    });

    runDb('a partner caller WITH full org access (canManagePartnerWidePolicies) writes the partner-wide row', async () => {
      const ok = await run(f, 'partnerAll', 'manage_software_policy', rename(f.swWide));
      expect(ok.error).toBeUndefined();
      expect((await swName(f.swWide)).name).toBe('renamed');
    });

    runDb('a site-restricted caller may not mutate software policy at all', async () => {
      expect(await run(f, 'restricted', 'manage_software_policy', rename(f.swA))).toEqual({ error: SITE_CEILING });
      expect(await run(f, 'restricted', 'manage_software_policy', disable(f.swA))).toEqual({ error: SITE_CEILING });
      expect((await swName(f.swA)).name).toBe('sw A');
    });
  });

  describe('manage_peripheral_policy', () => {
    const rename = (policy_id: string) => ({ action: 'update', policy_id, name: 'renamed' });
    const disable = (policy_id: string) => ({ action: 'disable', policy_id });

    runDb('an org caller updates and disables its own policy, but not another org\'s (not found)', async () => {
      const ok = await run(f, 'orgAdmin', 'manage_peripheral_policy', rename(f.perA));
      expect(ok.error).toBeUndefined();
      expect((await perRow(f.perA)).name).toBe('renamed');

      expect(await run(f, 'orgAdmin', 'manage_peripheral_policy', rename(f.perB))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'orgAdmin', 'manage_peripheral_policy', disable(f.perB))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'otherOrg', 'manage_peripheral_policy', rename(f.perA))).toEqual({ error: POLICY_DENIED });
      const b = await perRow(f.perB);
      expect(b.name).toBe('per B');
      expect(b.isActive).toBe(true);

      const off = await run(f, 'orgAdmin', 'manage_peripheral_policy', disable(f.perA));
      expect(off.error).toBeUndefined();
      expect((await perRow(f.perA)).isActive).toBe(false);
    });

    runDb('an org caller cannot touch a partner-wide row (not found) or create in another org', async () => {
      expect(await run(f, 'orgAdmin', 'manage_peripheral_policy', rename(f.perWide))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'orgAdmin', 'manage_peripheral_policy', disable(f.perWide))).toEqual({ error: POLICY_DENIED });
      const wide = await perRow(f.perWide);
      expect(wide.name).toBe('per partner-wide');
      expect(wide.isActive).toBe(true);

      const create = await run(f, 'orgAdmin', 'manage_peripheral_policy', {
        action: 'create', org_id: f.orgB, name: 'x-org', device_class: 'storage', policy_action: 'block', target_type: 'organization',
      });
      expect(create.error).toBe('Cannot access another organization');
      expect(await db().select({ id: peripheralPolicies.id }).from(peripheralPolicies).where(eq(peripheralPolicies.name, 'x-org'))).toHaveLength(0);
    });

    runDb('a partner caller WITHOUT full org access sees but cannot write the partner-wide row', async () => {
      expect(await run(f, 'partnerSel', 'manage_peripheral_policy', rename(f.perWide))).toEqual({ error: PARTNER_WIDE_PERIPHERAL });
      expect(await run(f, 'partnerSel', 'manage_peripheral_policy', disable(f.perWide))).toEqual({ error: PARTNER_WIDE_PERIPHERAL });
      expect(await run(f, 'partnerSel', 'manage_peripheral_policy', {
        action: 'add_exception', policy_id: f.perWide, exception: { vendor: 'Acme' },
      })).toEqual({ error: PARTNER_WIDE_PERIPHERAL });
      const wide = await perRow(f.perWide);
      expect(wide.name).toBe('per partner-wide');
      expect(wide.isActive).toBe(true);
      expect(wide.exceptions).toEqual([]);
      expect(await run(f, 'partnerSel', 'manage_peripheral_policy', rename(f.perB))).toEqual({ error: POLICY_DENIED });
    });

    runDb('a partner caller WITH full org access writes the partner-wide row', async () => {
      const ok = await run(f, 'partnerAll', 'manage_peripheral_policy', rename(f.perWide));
      expect(ok.error).toBeUndefined();
      expect((await perRow(f.perWide)).name).toBe('renamed');
    });

    runDb('a site-restricted caller may not mutate peripheral policy at all', async () => {
      expect(await run(f, 'restricted', 'manage_peripheral_policy', rename(f.perA))).toEqual({ error: SITE_CEILING });
      expect((await perRow(f.perA)).name).toBe('per A');
    });
  });

  describe('manage_browser_policy', () => {
    const rename = (policyId: string) => ({ action: 'update', policyId, name: 'renamed' });

    runDb('cross-org policies are not found for update and apply, in both directions', async () => {
      expect(await run(f, 'orgAdmin', 'manage_browser_policy', rename(f.brOther))).toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'orgAdmin', 'manage_browser_policy', { action: 'apply', policyId: f.brOther, deviceIds: [f.devA] }))
        .toEqual({ error: POLICY_DENIED });
      expect(await run(f, 'otherOrg', 'manage_browser_policy', rename(f.brSiteA))).toEqual({ error: POLICY_DENIED });
      expect((await brRow(f.brOther)).name).toBe('br other');
      expect(mocks.aiDispatchDeviceCommand).not.toHaveBeenCalled();
    });

    runDb('an org caller cannot create a policy in another org', async () => {
      const create = await run(f, 'orgAdmin', 'manage_browser_policy', {
        action: 'create', orgId: f.orgB, name: 'x-org', targetType: 'org',
      });
      expect(create.error).toBe('Cannot access another organization');
      expect(await db().select({ id: browserPolicies.id }).from(browserPolicies).where(eq(browserPolicies.name, 'x-org'))).toHaveLength(0);
    });

    runDb('apply with out-of-site deviceIds is refused by the central gate; in-site deviceIds dispatch', async () => {
      const denied = await run(f, 'restricted', 'manage_browser_policy', { action: 'apply', policyId: f.brSiteA, deviceIds: [f.devB] });
      expect(denied).toEqual({ error: DEVICE_DENIED });
      // in-site id FIRST: the gate must still refuse the out-of-site id after it
      expect(await run(f, 'restricted', 'manage_browser_policy', { action: 'apply', policyId: f.brSiteA, deviceIds: [f.devA, f.devB] }))
        .toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', 'manage_browser_policy', { action: 'apply', policyId: f.brSiteA, deviceIds: [f.devOther] }))
        .toEqual({ error: DEVICE_DENIED });
      expect(mocks.aiDispatchDeviceCommand).not.toHaveBeenCalled();

      const ok = await run(f, 'restricted', 'manage_browser_policy', { action: 'apply', policyId: f.brSiteA, deviceIds: [f.devA] });
      expect(ok.error).toBeUndefined();
      expect(ok.queuedCommands).toBe(1);
      expect(mocks.aiDispatchDeviceCommand).toHaveBeenCalledTimes(1);
      expect((mocks.aiDispatchDeviceCommand.mock.calls[0]![2] as { deviceId: string }).deviceId).toBe(f.devA);
    });

    runDb('a site-restricted caller cannot update or apply a policy targeted at another site; unrestricted can', async () => {
      const msg = 'Access denied: policy is outside your site scope';
      expect(await run(f, 'restricted', 'manage_browser_policy', rename(f.brSiteB))).toEqual({ error: msg });
      expect(await run(f, 'restricted', 'manage_browser_policy', { action: 'apply', policyId: f.brSiteB, deviceIds: [f.devA] })).toEqual({ error: msg });
      expect((await brRow(f.brSiteB)).name).toBe('br site B');
      expect(mocks.aiDispatchDeviceCommand).not.toHaveBeenCalled();

      const wide = await run(f, 'orgAdmin', 'manage_browser_policy', { action: 'apply', policyId: f.brSiteB, deviceIds: [f.devB] });
      expect(wide.error).toBeUndefined();
      expect(wide.queuedCommands).toBe(1);
    });
  });

  describe('remediate_sensitive_data', () => {
    runDb('a finding on an out-of-site device is refused whole; no status write or command', async () => {
      const msg = 'One or more findings are on devices outside your site scope — access denied';
      expect(await run(f, 'restricted', 'remediate_sensitive_data', { findingIds: [f.findB], action: 'false_positive' }))
        .toEqual({ error: msg });
      expect(await run(f, 'restricted', 'remediate_sensitive_data', { findingIds: [f.findA, f.findB], action: 'quarantine', confirm: true }))
        .toEqual({ error: msg });
      expect((await findingRow(f.findB)).status).toBe('open');
      expect((await findingRow(f.findA)).status).toBe('open');
      expect(mocks.aiQueueCommand).not.toHaveBeenCalled();
    });

    runDb('an in-site finding is remediated (status write) and queues a command for destructive actions', async () => {
      const ok = await run(f, 'restricted', 'remediate_sensitive_data', { findingIds: [f.findA], action: 'false_positive' });
      expect(ok.error).toBeUndefined();
      expect(ok.updated).toBe(1);
      expect((await findingRow(f.findA)).status).toBe('false_positive');

      const queued = await run(f, 'restricted', 'remediate_sensitive_data', { findingIds: [f.findA], action: 'quarantine', confirm: true });
      expect(queued.error).toBeUndefined();
      expect(queued.queued).toHaveLength(1);
      expect(mocks.aiQueueCommand).toHaveBeenCalledTimes(1);
      expect(mocks.aiQueueCommand.mock.calls[0]![2]).toBe(f.devA);
    });

    runDb('cross-org findings are not found; unrestricted reaches the site-B finding', async () => {
      expect(await run(f, 'otherOrg', 'remediate_sensitive_data', { findingIds: [f.findA], action: 'accept_risk' }))
        .toEqual({ error: 'No findings found or access denied' });
      expect(await run(f, 'restricted', 'remediate_sensitive_data', { findingIds: [f.findOther], action: 'accept_risk' }))
        .toEqual({ error: 'No findings found or access denied' });
      expect((await findingRow(f.findA)).status).toBe('open');
      expect((await findingRow(f.findOther)).status).toBe('open');

      const wide = await run(f, 'orgAdmin', 'remediate_sensitive_data', { findingIds: [f.findB], action: 'accept_risk' });
      expect(wide.error).toBeUndefined();
      expect((await findingRow(f.findB)).status).toBe('accepted');
    });
  });

  describe('remediate_software_violation', () => {
    const remediate = (extra: Record<string, unknown>) => ({ policyId: f.swArmed, ...extra });

    runDb('out-of-site deviceIds are refused by the central gate and nothing is scheduled', async () => {
      expect(await run(f, 'restricted', 'remediate_software_violation', remediate({ deviceIds: [f.devB] }))).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', 'remediate_software_violation', remediate({ deviceIds: [f.devA, f.devB] }))).toEqual({ error: DEVICE_DENIED });
      expect(mocks.scheduleSoftwareRemediation).not.toHaveBeenCalled();
    });

    runDb('in-site deviceIds schedule remediation; the implicit violation set is narrowed to the caller\'s sites', async () => {
      const ok = await run(f, 'restricted', 'remediate_software_violation', remediate({ deviceIds: [f.devA] }));
      expect(ok.error).toBeUndefined();
      expect(mocks.scheduleSoftwareRemediation).toHaveBeenCalledWith(f.swArmed, [f.devA]);

      mocks.scheduleSoftwareRemediation.mockClear();
      const implicit = await run(f, 'restricted', 'remediate_software_violation', remediate({}));
      expect(implicit.error).toBeUndefined();
      expect(mocks.scheduleSoftwareRemediation).toHaveBeenCalledTimes(1);
      expect(mocks.scheduleSoftwareRemediation.mock.calls[0]![1]).toEqual([f.devA]);
    });

    runDb('cross-org caller gets not found; unrestricted reaches both sites', async () => {
      expect(await run(f, 'otherOrg', 'remediate_software_violation', remediate({ deviceIds: [f.devA] }))).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'otherOrg', 'remediate_software_violation', remediate({ deviceIds: [f.devOther] }))).toEqual({ error: POLICY_DENIED });
      expect(mocks.scheduleSoftwareRemediation).not.toHaveBeenCalled();

      const wide = await run(f, 'orgAdmin', 'remediate_software_violation', remediate({}));
      expect(wide.error).toBeUndefined();
      expect([...(mocks.scheduleSoftwareRemediation.mock.calls[0]![1] as string[])].sort()).toEqual([f.devA, f.devB].sort());
    });
  });

  describe('assign_security_training', () => {
    const assign = (userId: string, extra: Record<string, unknown> = {}) => ({ userId, ...extra });
    const trainingEvents = (userId: string) =>
      db().select({ id: userRiskEvents.id }).from(userRiskEvents).where(eq(userRiskEvents.userId, userId));

    runDb('a user outside the caller\'s sites, or in another org, is not found and nothing is recorded', async () => {
      const msg = { error: 'User not found in this organization' };
      expect(await run(f, 'restricted', 'assign_security_training', assign(f.trainB))).toEqual(msg);
      expect(await run(f, 'orgAdmin', 'assign_security_training', assign(f.trainOther))).toEqual(msg);
      expect(await run(f, 'otherOrg', 'assign_security_training', assign(f.trainA))).toEqual(msg);
      expect(await run(f, 'orgAdmin', 'assign_security_training', assign(f.trainOther, { orgId: f.orgB })))
        .toEqual({ error: 'Cannot access another organization' });
      for (const id of [f.trainA, f.trainB, f.trainOther]) expect(await trainingEvents(id)).toHaveLength(0);
    });

    runDb('an in-site user is assigned; unrestricted reaches the site-B user', async () => {
      const ok = await run(f, 'restricted', 'assign_security_training', assign(f.trainA));
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(await trainingEvents(f.trainA)).toHaveLength(1);

      const wide = await run(f, 'orgAdmin', 'assign_security_training', assign(f.trainB));
      expect(wide.error).toBeUndefined();
      expect(await trainingEvents(f.trainB)).toHaveLength(1);
    });
  });

  describe('configure_network_baseline', () => {
    const update = (baseline_id: string) => ({ baseline_id, scan_interval_hours: 8 });
    const interval = async (id: string) => (await baselineRow(id)).scanSchedule as { intervalHours?: number };

    runDb('an out-of-site baseline is not found and unchanged; an in-site one is updated', async () => {
      expect(await run(f, 'restricted', 'configure_network_baseline', update(f.baseB))).toEqual({ error: 'Baseline not found or access denied' });
      expect((await interval(f.baseB)).intervalHours).toBe(4);

      const ok = await run(f, 'restricted', 'configure_network_baseline', update(f.baseA));
      expect(ok.error).toBeUndefined();
      expect(ok.action).toBe('updated');
      expect((await interval(f.baseA)).intervalHours).toBe(8);
    });

    runDb('cross-org baselines are not found in both directions; unrestricted reaches site B', async () => {
      expect(await run(f, 'otherOrg', 'configure_network_baseline', update(f.baseA))).toEqual({ error: 'Baseline not found or access denied' });
      expect(await run(f, 'orgAdmin', 'configure_network_baseline', update(f.baseOther))).toEqual({ error: 'Baseline not found or access denied' });
      expect((await interval(f.baseA)).intervalHours).toBe(4);
      expect((await interval(f.baseOther)).intervalHours).toBe(4);

      const wide = await run(f, 'orgAdmin', 'configure_network_baseline', update(f.baseB));
      expect(wide.error).toBeUndefined();
      expect((await interval(f.baseB)).intervalHours).toBe(8);
    });

    runDb('create is refused for another org or another site and succeeds in-site', async () => {
      const create = (org_id: string, site_id: string, subnet: string) => ({ org_id, site_id, subnet });
      expect(await run(f, 'orgAdmin', 'configure_network_baseline', create(f.orgB, f.siteOther, '10.9.0.0/24')))
        .toEqual({ error: 'Access to this organization denied' });
      expect(await run(f, 'orgAdmin', 'configure_network_baseline', create(f.orgA, f.siteOther, '10.9.0.0/24')))
        .toEqual({ error: 'Site not found for this organization' });
      expect(await run(f, 'restricted', 'configure_network_baseline', create(f.orgA, f.siteB, '10.9.0.0/24')))
        .toEqual({ error: 'Site not found or access denied' });
      expect(await db().select({ id: networkBaselines.id }).from(networkBaselines).where(eq(networkBaselines.subnet, '10.9.0.0/24'))).toHaveLength(0);

      const ok = await run(f, 'restricted', 'configure_network_baseline', create(f.orgA, f.siteA, '10.9.0.0/24'));
      expect(ok.error).toBeUndefined();
      expect(ok.action).toBe('created');
    });
  });

  describe('acknowledge_network_device', () => {
    const ack = (event_id: string) => ({ event_id, notes: 'scope probe' });

    runDb('an out-of-site event is not found and stays unacknowledged; an in-site one is acknowledged', async () => {
      expect(await run(f, 'restricted', 'acknowledge_network_device', ack(f.evB))).toEqual({ error: 'Event not found or access denied' });
      expect((await eventRow(f.evB)).acknowledged).toBe(false);

      const ok = await run(f, 'restricted', 'acknowledge_network_device', ack(f.evA));
      expect(ok.error).toBeUndefined();
      expect((await eventRow(f.evA)).acknowledged).toBe(true);
    });

    runDb('cross-org events are not found in both directions; unrestricted reaches site B', async () => {
      expect(await run(f, 'otherOrg', 'acknowledge_network_device', ack(f.evA))).toEqual({ error: 'Event not found or access denied' });
      expect(await run(f, 'orgAdmin', 'acknowledge_network_device', ack(f.evOther))).toEqual({ error: 'Event not found or access denied' });
      expect((await eventRow(f.evA)).acknowledged).toBe(false);
      expect((await eventRow(f.evOther)).acknowledged).toBe(false);

      const wide = await run(f, 'orgAdmin', 'acknowledge_network_device', ack(f.evB));
      expect(wide.error).toBeUndefined();
      expect((await eventRow(f.evB)).acknowledged).toBe(true);
    });
  });
});
