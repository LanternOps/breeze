/**
 * Integration test — W13 (#6783, PR A) device inventory and record tools honour the org axis, the site axis and the
 * exact-device axis against real Postgres as the unprivileged `breeze_app` role (org-axis RLS genuinely enforced; the
 * site and device axes are app-layer).
 *
 * Entry point: `executeTool`, so the central `deviceArgs` gate runs before the handler exactly as in production.
 * The human approval step lives in the chat layer (unit-tested in aiGuardrails.*): this suite pins the CLASS each
 * write is raised at (`checkGuardrails`) and then tests the scope behaviour that runs AFTER approval, against
 * stored rows:
 *   - manage_device_function:set — an out-of-site or foreign device gets no assessment row; in-site writes one
 *     manual row recorded against the calling user;
 *   - manage_device_links — a group naming an out-of-site device is not created; another org's group is not found
 *     and survives a dissolve; a device-bound session cannot create one;
 *   - manage_manual_assets — a create in an out-of-site site is refused; another org's asset is not found and
 *     survives a delete; a device-bound session is refused;
 *   - manage_device_warranty / get_device_events / get_management_posture — reads never cross the org, site or
 *     device axis (the posture aggregate counts only reachable devices).
 * Every refusal has a CONTROL that lands the same call for the caller the guard admits. Nothing is stubbed;
 * no call here reaches a device or a vendor (warranty refresh is only exercised on refused paths).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import { auditLogs, deviceFunctionAssessments, deviceLinkGroups, deviceWarranty, devices, manualAssets } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
type Who = 'restricted' | 'orgAdmin' | 'otherOrg';
const AI_SESSION_ID = randomUUID();

function makeAuth(opts: {
  userId: string; partnerId: string; orgIds: string[]; allowedSiteIds?: string[]; allowedDeviceIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: orgIds[0]!,
    scope: 'organization',
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    allowedDeviceIds: opts.allowedDeviceIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: AI_SESSION_ID },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string; orgA: string; orgB: string; userId: string; siteA: string; siteB: string; siteOther: string;
  devA: string; devA2: string; devB: string; devOther: string; assetOther: string; groupOther: string;
  auth: Record<Who, AuthContext>;
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `w13-ops-${randomUUID()}`, hostname: `w13o-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'x64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const db0 = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W13 ops A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'W13 ops B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'W13 ops other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w13o-${randomUUID()}@example.com` });
  const devA = await seedDevice(orgA.id, siteA.id);
  const devA2 = await seedDevice(orgA.id, siteA.id);
  const devB = await seedDevice(orgA.id, siteB.id);
  const devOther = await seedDevice(orgB.id, siteOther.id);
  const devOther2 = await seedDevice(orgB.id, siteOther.id);

  const [asset] = await db0.insert(manualAssets).values({
    orgId: orgB.id, siteId: siteOther.id, name: 'Other org phone', assetType: 'phone',
  } as typeof manualAssets.$inferInsert).returning({ id: manualAssets.id });
  const [group] = await db0.insert(deviceLinkGroups).values({ orgId: orgB.id, kind: 'multiboot', name: 'Other org dual boot' })
    .returning({ id: deviceLinkGroups.id });
  await db0.update(devices).set({ linkGroupId: group!.id }).where(inArray(devices.id, [devOther, devOther2]));

  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().split('T')[0]!;
  await db0.insert(deviceWarranty).values([
    { deviceId: devA, orgId: orgA.id, manufacturer: 'Dell Inc.', status: 'active', warrantyEndDate: inDays(20) },
    { deviceId: devB, orgId: orgA.id, manufacturer: 'Dell Inc.', status: 'active', warrantyEndDate: inDays(25) },
    { deviceId: devOther, orgId: orgB.id, manufacturer: 'Dell Inc.', status: 'active', warrantyEndDate: inDays(30) },
  ] as Array<typeof deviceWarranty.$inferInsert>);

  await db0.insert(auditLogs).values([
    { orgId: orgA.id, actorType: 'user', actorId: user.id, actorEmail: 'op@example.com', action: 'script.execute', resourceType: 'device', resourceId: devA, resourceName: 'devA', result: 'success', ipAddress: '192.0.2.44' },
    { orgId: orgA.id, actorType: 'user', actorId: user.id, actorEmail: 'op@example.com', action: 'script.execute', resourceType: 'device', resourceId: devB, resourceName: 'devB', result: 'success' },
  ] as Array<typeof auditLogs.$inferInsert>);

  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, userId: user.id, siteA: siteA.id, siteB: siteB.id, siteOther: siteOther.id,
    devA, devA2, devB, devOther, assetOther: asset!.id, groupOther: group!.id,
    auth: {
      restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
      orgAdmin: makeAuth({ ...base, orgIds: [orgA.id] }),
      otherOrg: makeAuth({ ...base, orgIds: [orgB.id] }),
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

const assessmentsFor = (deviceId: string) => getTestDb().select().from(deviceFunctionAssessments)
  .where(eq(deviceFunctionAssessments.deviceId, deviceId));
const linkOf = async (deviceId: string) => (await getTestDb().select({ g: devices.linkGroupId }).from(devices).where(eq(devices.id, deviceId)))[0]!.g;

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedFixture();
});

describe('the class each write is raised at (pinned here as well as in the guardrail contract)', () => {
  runDb('function set, manual-asset delete and warranty refresh are supervised; link and asset edits t2', () => {
    expect(checkGuardrails('manage_device_function', { action: 'set' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_manual_assets', { action: 'delete' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_device_warranty', { action: 'refresh' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    for (const action of ['create', 'update', 'dissolve']) expect(checkGuardrails('manage_device_links', { action })).toMatchObject({ tier: 2 });
    for (const action of ['create', 'update', 'link', 'unlink']) expect(checkGuardrails('manage_manual_assets', { action })).toMatchObject({ tier: 2 });
  });
});

describe('manage_device_function:set (site axis against device_function_assessments)', () => {
  runDb('an out-of-site or foreign device gets no assessment (CONTROL: in-site writes one manual row for the caller)', async () => {
    for (const deviceId of [f.devB, f.devOther]) {
      const out = await run(f, 'restricted', 'manage_device_function', { action: 'set', deviceId, functionKey: 'file_server' });
      expect(out.body.error, out.raw).toBeTruthy();
      expect(await assessmentsFor(deviceId)).toHaveLength(0);
    }
    const ok = await run(f, 'restricted', 'manage_device_function', { action: 'set', deviceId: f.devA, functionKey: 'file_server' });
    expect(ok.body.outcome, ok.raw).toBe('written');
    const rows = await assessmentsFor(f.devA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ functionKey: 'file_server', source: 'manual', active: true, createdByUserId: f.userId });
  });
});

describe('manage_device_links', () => {
  runDb('a group naming an out-of-site device is not created (CONTROL: two in-site devices link)', async () => {
    const refused = await run(f, 'restricted', 'manage_device_links', { action: 'create', deviceIds: [f.devA, f.devB] });
    expect(refused.body.error, refused.raw).toBeTruthy();
    expect(await linkOf(f.devA)).toBeNull();
    expect(await linkOf(f.devB)).toBeNull();

    const ok = await run(f, 'restricted', 'manage_device_links', { action: 'create', deviceIds: [f.devA, f.devA2], name: 'Dual boot' });
    expect(ok.body.group?.id, ok.raw).toBeTruthy();
    expect(await linkOf(f.devA)).toBe(ok.body.group.id);
    expect(await linkOf(f.devA2)).toBe(ok.body.group.id);
  });

  runDb('another org\'s group is not found and survives a dissolve (CONTROL: its own org dissolves it)', async () => {
    const get = await run(f, 'orgAdmin', 'manage_device_links', { action: 'get', groupId: f.groupOther });
    expect(get.body.code, get.raw).toBe('NOT_FOUND');
    const dissolve = await run(f, 'orgAdmin', 'manage_device_links', { action: 'dissolve', groupId: f.groupOther });
    expect(dissolve.body.code, dissolve.raw).toBe('NOT_FOUND');
    expect(await linkOf(f.devOther)).toBe(f.groupOther);

    const own = await run(f, 'otherOrg', 'manage_device_links', { action: 'dissolve', groupId: f.groupOther });
    expect(own.body.dissolved, own.raw).toBe(true);
    expect(await linkOf(f.devOther)).toBeNull();
  });

  runDb('a device-bound session cannot link even its own devices (CONTROL: an unbound one can)', async () => {
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devA, f.devA2] } as unknown as AuthContext;
    const refused = await run(f, 'orgAdmin', 'manage_device_links', { action: 'create', deviceIds: [f.devA, f.devA2] }, bound);
    expect(refused.body.code, refused.raw).toBe('ACCESS_DENIED');
    expect(await linkOf(f.devA)).toBeNull();
    const ok = await run(f, 'orgAdmin', 'manage_device_links', { action: 'create', deviceIds: [f.devA, f.devA2] });
    expect(ok.body.group?.id, ok.raw).toBeTruthy();
  });
});

describe('manage_manual_assets', () => {
  const assetsNamed = (name: string) => getTestDb().select().from(manualAssets).where(eq(manualAssets.name, name));

  runDb('a create in an out-of-site site is refused (CONTROL: in-site creates one row for the caller)', async () => {
    const refused = await run(f, 'restricted', 'manage_manual_assets', { action: 'create', orgId: f.orgA, siteId: f.siteB, name: 'W13 refused printer' });
    expect(refused.body.error, refused.raw).toBeTruthy();
    expect(await assetsNamed('W13 refused printer')).toHaveLength(0);

    const ok = await run(f, 'restricted', 'manage_manual_assets', { action: 'create', orgId: f.orgA, siteId: f.siteA, name: 'W13 spare laptop' });
    expect(ok.body.asset?.id, ok.raw).toBeTruthy();
    const rows = await assetsNamed('W13 spare laptop');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: f.orgA, siteId: f.siteA, createdBy: f.userId });
  });

  runDb('another org\'s asset is not found and survives a delete (CONTROL: its own org deletes it)', async () => {
    const out = await run(f, 'orgAdmin', 'manage_manual_assets', { action: 'delete', assetId: f.assetOther });
    expect(out.body.code, out.raw).toBe('NOT_FOUND');
    expect(await getTestDb().select().from(manualAssets).where(eq(manualAssets.id, f.assetOther))).toHaveLength(1);
    const own = await run(f, 'otherOrg', 'manage_manual_assets', { action: 'delete', assetId: f.assetOther });
    expect(own.body.deleted, own.raw).toBe(true);
    expect(await getTestDb().select().from(manualAssets).where(eq(manualAssets.id, f.assetOther))).toHaveLength(0);
  });

  runDb('a device-bound session is refused list and create', async () => {
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devA] } as unknown as AuthContext;
    for (const input of [{ action: 'list' }, { action: 'create', orgId: f.orgA, siteId: f.siteA, name: 'W13 bound' }]) {
      const out = await run(f, 'orgAdmin', 'manage_manual_assets', input, bound);
      expect(out.body.code, out.raw).toBe('ACCESS_DENIED');
    }
    expect(await assetsNamed('W13 bound')).toHaveLength(0);
  });
});

describe('reads never cross an axis', () => {
  runDb('expiring warranties: site-restricted sees only in-site devices, device-bound only its device, never another org', async () => {
    const ids = (body: Record<string, any>) => (body.devices as Array<{ deviceId: string }>).map((d) => d.deviceId).sort();
    const admin = await run(f, 'orgAdmin', 'manage_device_warranty', { action: 'expiring', days: 60 });
    expect(ids(admin.body), admin.raw).toEqual([f.devA, f.devB].sort());
    const restricted = await run(f, 'restricted', 'manage_device_warranty', { action: 'expiring', days: 60 });
    expect(ids(restricted.body), restricted.raw).toEqual([f.devA]);
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devB] } as unknown as AuthContext;
    const boundOut = await run(f, 'orgAdmin', 'manage_device_warranty', { action: 'expiring', days: 60 }, bound);
    expect(ids(boundOut.body), boundOut.raw).toEqual([f.devB]);
  });

  runDb('warranty refresh on an out-of-site or foreign device is refused before anything is queued', async () => {
    for (const deviceId of [f.devB, f.devOther]) {
      const out = await run(f, 'restricted', 'manage_device_warranty', { action: 'refresh', deviceId });
      expect(out.body.error, out.raw).toBeTruthy();
      expect(out.body.queued).toBeUndefined();
    }
  });

  runDb('device events: out-of-site / foreign devices are refused; in-site returns the feed without email or IP', async () => {
    for (const deviceId of [f.devB, f.devOther]) {
      const out = await run(f, 'restricted', 'get_device_events', { deviceId });
      expect(out.body.error, out.raw).toBeTruthy();
    }
    const ok = await run(f, 'restricted', 'get_device_events', { deviceId: f.devA });
    expect(ok.body.events, ok.raw).toHaveLength(1);
    expect(ok.raw).not.toContain('op@example.com');
    expect(ok.raw).not.toContain('192.0.2.44');
  });

  runDb('management posture totals count only the devices the caller may reach', async () => {
    const total = (body: Record<string, any>) => body.totals?.totalDevices;
    const admin = await run(f, 'orgAdmin', 'get_management_posture', {});
    expect(total(admin.body), admin.raw).toBe(3);
    const restricted = await run(f, 'restricted', 'get_management_posture', {});
    expect(total(restricted.body), restricted.raw).toBe(2);
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devB] } as unknown as AuthContext;
    const boundOut = await run(f, 'orgAdmin', 'get_management_posture', {}, bound);
    expect(total(boundOut.body), boundOut.raw).toBe(1);
    const foreign = await run(f, 'orgAdmin', 'get_management_posture', { orgId: f.orgB });
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
  });
});

