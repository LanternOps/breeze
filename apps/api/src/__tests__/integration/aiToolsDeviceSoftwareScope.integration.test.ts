/**
 * Integration test — W12 (#6782) manage_device_software, bootstrap_homebrew, manage_software_inventory,
 * manage_custom_fields and manage_fleet_findings honour the org axis, the site axis and the partner-wide gate
 * against real Postgres as the unprivileged `breeze_app` role (org-axis RLS genuinely enforced; the site axis and
 * the partner-wide gate are app-layer).
 *
 * Entry point: `executeTool`, so the central `deviceArgs` gate runs before the handler exactly as in production.
 * The human approval step lives in the chat layer (unit-tested in aiGuardrails.*): this suite pins the CLASS each
 * write is raised at (`checkGuardrails`) and then tests the scope behaviour that runs AFTER approval. Proven against
 * stored rows:
 *   - device software: an out-of-site device gets no device_commands row; an in-site call queues exactly one
 *     command of the right type (real `aiQueueCommand` → `queueCommand`, nothing stubbed);
 *   - inventory approve: the org "Default Allowlist" (+ its config policy and org assignment) is created with the
 *     caller's id only when it is a `users` row (W12-D3), a site-restricted caller is refused, and a same-named
 *     default config policy that carries another feature link is refused with a 409 (W12-D13);
 *   - custom fields: partner-wide create needs full partner org access; an existing partner-wide definition is never
 *     edited (W12-D10);
 *   - fleet findings: another org's finding is not found and unchanged.
 * Every refusal has a CONTROL that lands the same call for the caller the guard admits. Nothing is stubbed.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import {
  configPolicyAssignments, configPolicyFeatureLinks, configurationPolicies, customFieldDefinitions, deviceCommands,
  devices, fleetFindingDevices, fleetFindings, softwarePolicies,
} from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
type Who = 'restricted' | 'orgAdmin' | 'otherOrg' | 'partnerAll' | 'partnerSel';
const AI_SESSION_ID = randomUUID();

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
    aiOrigin: { kind: 'ai_assistant', sessionId: AI_SESSION_ID }, // device_commands.ai_session_id is a uuid column
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string; orgA: string; orgB: string; userId: string; siteA: string; siteB: string;
  devA: string; devB: string; devOther: string;
  cfA: string; cfWide: string; findingA: string; findingB: string;
  auth: Record<Who, AuthContext>;
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `w12-sw-${randomUUID()}`, hostname: `w12s-${randomUUID().slice(0, 8)}`,
    osType: 'macos', osVersion: '15.1', architecture: 'arm64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedFinding(orgId: string, deviceIds: string[]): Promise<string> {
  const db0 = getTestDb();
  const now = new Date();
  const [row] = await db0.insert(fleetFindings).values({
    orgId, kind: 'reliability_offenders', semanticKey: `w12:${randomUUID()}`, title: 'W12 crashing app', firstSeenAt: now, lastSeenAt: now,
    deviceCount: deviceIds.length,
  } as typeof fleetFindings.$inferInsert).returning({ id: fleetFindings.id });
  await db0.insert(fleetFindingDevices).values(deviceIds.map((deviceId) => ({
    findingId: row!.id, orgId, deviceId, sourceKind: 'device_reliability', firstSeenAt: now, lastSeenAt: now,
  })));
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const db0 = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W12 sw A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'W12 sw B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'W12 sw other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w12s-${randomUUID()}@example.com` });
  const cf = async (v: { orgId: string | null; partnerId: string | null; name: string; fieldKey: string }) => {
    const [row] = await db0.insert(customFieldDefinitions).values({ ...v, type: 'text' }).returning({ id: customFieldDefinitions.id });
    return row!.id;
  };
  const devA = await seedDevice(orgA.id, siteA.id);
  const devB = await seedDevice(orgA.id, siteB.id);
  const devOther = await seedDevice(orgB.id, siteOther.id);
  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, userId: user.id, siteA: siteA.id, siteB: siteB.id,
    devA, devB, devOther,
    cfA: await cf({ orgId: orgA.id, partnerId: null, name: 'Asset tag', fieldKey: 'asset_tag' }),
    cfWide: await cf({ orgId: null, partnerId: partner.id, name: 'Partner contract', fieldKey: 'partner_contract' }),
    findingA: await seedFinding(orgA.id, [devA, devB]),
    findingB: await seedFinding(orgB.id, [devOther]),
    auth: {
      restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
      orgAdmin: makeAuth({ ...base, orgIds: [orgA.id] }),
      otherOrg: makeAuth({ ...base, orgIds: [orgB.id] }),
      partnerAll: makeAuth({ ...base, orgIds: [orgA.id, orgB.id], scope: 'partner', partnerOrgAccess: 'all' }),
      partnerSel: makeAuth({ ...base, orgIds: [orgA.id], scope: 'partner', partnerOrgAccess: 'selected' }),
    },
  };
}

function ctxFor(f: Fixture, auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: f.partnerId, userId: auth.user.id,
  });
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>, auth: AuthContext = f.auth[who]) {
  const raw = await withDbAccessContext(ctxFor(f, auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

const commandsFor = (deviceId: string) => getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId));
const defaultAllowlist = (orgId: string) => getTestDb().select().from(softwarePolicies)
  .where(and(eq(softwarePolicies.orgId, orgId), eq(softwarePolicies.name, 'Default Allowlist')));
const configPolicyNamed = (orgId: string, name: string) => getTestDb().select().from(configurationPolicies)
  .where(and(eq(configurationPolicies.orgId, orgId), eq(configurationPolicies.name, name)));
const cfRow = async (id: string) => (await getTestDb().select().from(customFieldDefinitions).where(eq(customFieldDefinitions.id, id)))[0];
const findingRow = async (id: string) => (await getTestDb().select().from(fleetFindings).where(eq(fleetFindings.id, id)))[0]!;

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedFixture();
});

describe('the class each write is raised at (pinned here as well as in the guardrail contract)', () => {
  runDb('device-reaching writes and inventory writes are supervised; finding lifecycle and an org definition are t2', () => {
    for (const action of ['update', 'uninstall']) {
      expect(checkGuardrails('manage_device_software', { action })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
    expect(checkGuardrails('bootstrap_homebrew', {})).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    for (const action of ['approve', 'deny', 'clear']) {
      expect(checkGuardrails('manage_software_inventory', { action })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
    expect(checkGuardrails('manage_fleet_findings', { action: 'acknowledge' })).toMatchObject({ tier: 2 });
    expect(checkGuardrails('manage_custom_fields', { action: 'create_definition' })).toMatchObject({ tier: 2 });
    expect(checkGuardrails('manage_custom_fields', { action: 'create_definition', ownerScope: 'partner' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
  });
});

describe('manage_device_software and bootstrap_homebrew (site axis against device_commands)', () => {
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ['manage_device_software', { action: 'update', name: 'Google Chrome' }, 'software_update'],
    ['manage_device_software', { action: 'uninstall', name: 'Google Chrome' }, 'software_uninstall'],
    ['bootstrap_homebrew', {}, 'homebrew_bootstrap'],
  ];

  runDb('an out-of-site or foreign device gets no command (CONTROL: in-site queues exactly one command of the right type each)', async () => {
    for (const [tool, input] of calls) {
      const outOfSite = await run(f, 'restricted', tool, { ...input, deviceId: f.devB });
      expect(outOfSite.body.error, outOfSite.raw).toBeTruthy();
      const foreign = await run(f, 'restricted', tool, { ...input, deviceId: f.devOther });
      expect(foreign.body.error, foreign.raw).toBeTruthy();
    }
    expect(await commandsFor(f.devB)).toHaveLength(0);
    expect(await commandsFor(f.devOther)).toHaveLength(0);

    for (const [tool, input, type] of calls) {
      const before = (await commandsFor(f.devA)).length;
      const ok = await run(f, 'restricted', tool, { ...input, deviceId: f.devA });
      expect(ok.body.queued, ok.raw).toBe(true);
      const rows = await commandsFor(f.devA);
      expect(rows).toHaveLength(before + 1);
      const row = rows.find((r) => r.id === ok.body.commandId);
      expect(row, ok.raw).toMatchObject({ deviceId: f.devA, type, createdBy: f.userId });
    }
    expect((await commandsFor(f.devA)).map((r) => r.type).sort()).toEqual(['homebrew_bootstrap', 'software_uninstall', 'software_update']);
  });

  runDb('a device-bound session cannot reach another device in its own site set', async () => {
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devA] } as unknown as AuthContext;
    const out = await run(f, 'orgAdmin', 'manage_device_software', { action: 'uninstall', deviceId: f.devB, name: 'Zoom' }, bound);
    expect(out.body.error, out.raw).toBeTruthy();
    expect(await commandsFor(f.devB)).toHaveLength(0);
  });
});

describe('manage_software_inventory:approve', () => {
  runDb('creates the org Default Allowlist, its config policy and org assignment stamped with a verified users id', async () => {
    const out = await run(f, 'orgAdmin', 'manage_software_inventory', { action: 'approve', softwareName: 'Firefox', vendor: 'Mozilla' });
    expect(out.body.success, out.raw).toBe(true);
    const [policy] = await defaultAllowlist(f.orgA);
    expect(policy).toMatchObject({ id: out.body.policyId, orgId: f.orgA, mode: 'allowlist', enforceMode: false, createdBy: f.userId });
    expect((policy!.rules as { software: unknown[] }).software).toEqual([{ name: 'Firefox', vendor: 'Mozilla' }]);
    const [config] = await configPolicyNamed(f.orgA, 'Default Allowlist Config');
    expect(config).toMatchObject({ createdBy: f.userId, status: 'active' });
    const [assignment] = await getTestDb().select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, config!.id));
    expect(assignment).toMatchObject({ level: 'organization', targetId: f.orgA, assignedBy: f.userId });
    // A second approve appends to the same row.
    const again = await run(f, 'orgAdmin', 'manage_software_inventory', { action: 'approve', softwareName: '7-Zip' });
    expect(again.body.policyId, again.raw).toBe(policy!.id);
    expect(((await defaultAllowlist(f.orgA))[0]!.rules as { software: { name: string }[] }).software.map((s) => s.name)).toEqual(['Firefox', '7-Zip']);
  });

  runDb('a caller whose id is not a users row (agent-like principal) writes NULL created_by / assigned_by, never a 23503', async () => {
    const synthetic = makeAuth({ userId: randomUUID(), partnerId: f.partnerId, orgIds: [f.orgA] });
    const out = await run(f, 'orgAdmin', 'manage_software_inventory', { action: 'approve', softwareName: 'Firefox' }, synthetic);
    expect(out.body.success, out.raw).toBe(true);
    const [policy] = await defaultAllowlist(f.orgA);
    expect(policy!.createdBy).toBeNull();
    const [config] = await configPolicyNamed(f.orgA, 'Default Allowlist Config');
    expect(config!.createdBy).toBeNull();
    const [assignment] = await getTestDb().select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, config!.id));
    expect(assignment!.assignedBy).toBeNull();
  });

  runDb('a site-restricted or device-bound caller is refused and writes nothing; a foreign orgId is refused', async () => {
    const restricted = await run(f, 'restricted', 'manage_software_inventory', { action: 'approve', softwareName: 'Firefox' });
    expect(restricted.body.code, restricted.raw).toBe('ACCESS_DENIED');
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devA] } as unknown as AuthContext;
    const deviceBound = await run(f, 'orgAdmin', 'manage_software_inventory', { action: 'approve', softwareName: 'Firefox' }, bound);
    expect(deviceBound.body.code, deviceBound.raw).toBe('ACCESS_DENIED');
    const foreign = await run(f, 'orgAdmin', 'manage_software_inventory', { action: 'approve', softwareName: 'Firefox', orgId: f.orgB });
    expect(foreign.body.error, foreign.raw).toBeTruthy();
    expect(await defaultAllowlist(f.orgA)).toHaveLength(0);
    expect(await defaultAllowlist(f.orgB)).toHaveLength(0);
    expect(await configPolicyNamed(f.orgA, 'Default Allowlist Config')).toHaveLength(0);
  });

  runDb('refuses (409) when "Default Allowlist Config" carries another feature link, writing nothing (CONTROL: without it, approve lands)', async () => {
    const [config] = await getTestDb().insert(configurationPolicies).values({ orgId: f.orgA, name: 'Default Allowlist Config', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [link] = await getTestDb().insert(configPolicyFeatureLinks).values({ configPolicyId: config!.id, featureType: 'patch', inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    const refused = await run(f, 'orgAdmin', 'manage_software_inventory', { action: 'approve', softwareName: 'Firefox' });
    expect(refused.body.code, refused.raw).toBe('CONFLICT');
    expect(await defaultAllowlist(f.orgA)).toHaveLength(0);
    const links = await getTestDb().select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, config!.id));
    expect(links.map((l) => l.featureType)).toEqual(['patch']);
    expect(await getTestDb().select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, config!.id))).toHaveLength(0);

    await getTestDb().delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, link!.id));
    const ok = await run(f, 'orgAdmin', 'manage_software_inventory', { action: 'approve', softwareName: 'Firefox' });
    expect(ok.body.success, ok.raw).toBe(true);
    const after = await getTestDb().select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, config!.id));
    expect(after).toEqual([expect.objectContaining({ featureType: 'software_policy', featurePolicyId: ok.body.policyId })]);
  });
});

describe('manage_custom_fields', () => {
  const named = (fieldKey: string) => getTestDb().select().from(customFieldDefinitions).where(eq(customFieldDefinitions.fieldKey, fieldKey));

  runDb('a partner-wide create needs full partner org access (CONTROL: partnerAll lands it with org_id NULL)', async () => {
    const input = { action: 'create_definition', ownerScope: 'partner', name: 'Warranty tier', fieldKey: 'warranty_tier', type: 'text' };
    const sel = await run(f, 'partnerSel', 'manage_custom_fields', input);
    expect(sel.body.code, sel.raw).toBe('ACCESS_DENIED');
    const org = await run(f, 'orgAdmin', 'manage_custom_fields', input);
    expect(org.body.code, org.raw).toBe('ACCESS_DENIED');
    expect(await named('warranty_tier')).toHaveLength(0);
    const all = await run(f, 'partnerAll', 'manage_custom_fields', input);
    expect(all.body.definition, all.raw).toBeTruthy();
    const rows = await named('warranty_tier');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: null, partnerId: f.partnerId });
  });

  runDb('an EXISTING partner-wide definition is never edited or deleted here, even by a full partner admin (CONTROL: an org definition updates)', async () => {
    const upd = await run(f, 'partnerAll', 'manage_custom_fields', { action: 'update_definition', definitionId: f.cfWide, name: 'hijack' });
    expect(upd.body.code, upd.raw).toBe('ACCESS_DENIED');
    const del = await run(f, 'partnerAll', 'manage_custom_fields', { action: 'delete_definition', definitionId: f.cfWide });
    expect(del.body.code, del.raw).toBe('ACCESS_DENIED');
    expect(await cfRow(f.cfWide)).toMatchObject({ name: 'Partner contract', orgId: null, partnerId: f.partnerId });

    const own = await run(f, 'orgAdmin', 'manage_custom_fields', { action: 'update_definition', definitionId: f.cfA, name: 'Asset tag (v2)' });
    expect(own.body.definition, own.raw).toBeTruthy();
    expect((await cfRow(f.cfA))!.name).toBe('Asset tag (v2)');
  });

  runDb('another org\'s definition is not found and unchanged', async () => {
    const out = await run(f, 'otherOrg', 'manage_custom_fields', { action: 'update_definition', definitionId: f.cfA, name: 'x' });
    expect(out.body.code, out.raw).toBe('NOT_FOUND');
    expect((await cfRow(f.cfA))!.name).toBe('Asset tag');
  });
});

describe('manage_fleet_findings', () => {
  runDb('acknowledging another org\'s finding is not found and leaves it open (CONTROL: its own org acknowledges, stamped with the user)', async () => {
    const foreign = await run(f, 'otherOrg', 'manage_fleet_findings', { action: 'acknowledge', findingId: f.findingA });
    const missing = await run(f, 'otherOrg', 'manage_fleet_findings', { action: 'acknowledge', findingId: randomUUID() });
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
    expect(await findingRow(f.findingA)).toMatchObject({ status: 'open', acknowledgedBy: null });

    const own = await run(f, 'orgAdmin', 'manage_fleet_findings', { action: 'acknowledge', findingId: f.findingA });
    expect(own.body.status, own.raw).toBe('acknowledged');
    expect(await findingRow(f.findingA)).toMatchObject({ status: 'acknowledged', acknowledgedBy: f.userId });
    // The other org's own finding is untouched.
    expect((await findingRow(f.findingB)).status).toBe('open');
  });

  runDb('a site-restricted caller cannot change a finding that spans a device outside its sites', async () => {
    const out = await run(f, 'restricted', 'manage_fleet_findings', { action: 'acknowledge', findingId: f.findingA });
    expect(out.body.code, out.raw).toBe('ACCESS_DENIED');
    expect((await findingRow(f.findingA)).status).toBe('open');
  });
});
