/**
 * The manual reattach action end to end (#8318 wave 2-2, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §7.3, §8, §9) against real PostgreSQL (the API as `breeze_app`) and Redis:
 * the REAL auth middleware, the REAL `device_reattach` grant store and the
 * REAL candidates search.
 *
 * Proven here:
 *   - POST /devices/:id/reattach creates the `requested` intent and consumes
 *     the grant (GETDEL) inside the creating transaction; a replay finds it
 *     gone;
 *   - a refusal leaves the grant spendable, and the same grant succeeds once
 *     the refusal is gone; a grant bound to another install of the target is
 *     refused and NOT consumed; a missing grant is 403 STEP_UP_REQUIRED;
 *   - a transaction that fails after the consume rolls everything back and
 *     the grant is gone (F20): the technician steps up again;
 *   - technicians limited to selected orgs: 403 full_admin_required for a
 *     parked source, 403 org_access_denied for an org they lack, accepted
 *     inside their own orgs; typed name and OS-change confirmations;
 *   - GET /devices/:id/reinstall-candidates leaks nothing: a parked source is
 *     a 404 to a technician, a candidate in an org the viewer lacks is only
 *     `reviewPending`, an organization user never sees a candidate, a
 *     site-restricted user cannot see a source outside their sites.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceReattachRoute.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { deviceRoutes } from '../../routes/devices';
import { deviceHardware, deviceReattachIntents, organizationUsers, refreshTokenFamilies, users } from '../../db/schema';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { deviceReattachResourceDigest, mintStepUpGrant, type DeviceReattachResource } from '../../services/mfaStepUpGrant';
import { getRedis } from '../../services/redis';
import { createRole, createUser, grantRolePermissions } from './db-utils';
import {
  parkedSource,
  readDevice,
  seedAgentDevice,
  seedReattachTenant,
  silentTarget,
  type ReattachTenant,
  type SeededAgentDevice,
  type SeedDeviceOptions,
} from './deviceReattachFixtures';
import { getTestDb } from './setup';

// One test makes the creating transaction fail right after the grant is
// consumed, through the REAL consume.
const consumeSeam = vi.hoisted(() => ({ failAfterConsume: false }));
vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mfaStepUpGrant')>();
  return {
    ...actual,
    consumeStepUpGrant: async (...args: Parameters<typeof actual.consumeStepUpGrant>) => {
      const consumed = await actual.consumeStepUpGrant(...args);
      if (consumeSeam.failAfterConsume) throw new Error('injected failure after the consume');
      return consumed;
    },
  };
});

beforeEach(() => {
  consumeSeam.failAfterConsume = false;
});

const UUID = '4c4c4544-0042-3510-8051-b4c04f4d3132';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/devices', deviceRoutes);
  return app;
}

interface Caller {
  userId: string;
  token: string;
  sid: string;
  authEpoch: number;
  mfaEpoch: number;
}

async function seedSession(userId: string): Promise<string> {
  const familyId = randomUUID();
  await getTestDb().insert(refreshTokenFamilies).values({ familyId, userId, absoluteExpiresAt: new Date(Date.now() + 86_400_000) });
  return familyId;
}

async function epochsOf(userId: string) {
  const [row] = await getTestDb().select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch }).from(users).where(eq(users.id, userId));
  return row!;
}

async function partnerCaller(tenant: ReattachTenant, who: 'admin' | 'techA'): Promise<Caller> {
  const user = tenant[who];
  const sid = await seedSession(user.id);
  const epochs = await epochsOf(user.id);
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id, email: user.email, roleId: user.roleId, orgId: null, partnerId: tenant.partnerId,
    scope: 'partner', mfa: true, aep: epochs.authEpoch, mep: epochs.mfaEpoch, sid,
  };
  return { userId: user.id, token: await createAccessToken(payload), sid, ...epochs };
}

async function orgCaller(tenant: ReattachTenant, orgId: string, siteIds: string[] | null = null): Promise<Caller> {
  const user = await createUser({ partnerId: tenant.partnerId, orgId, email: `org-${randomUUID()}@reattach.test`, name: 'Org user' });
  const role = await createRole({ scope: 'organization', orgId, name: `org ${randomUUID().slice(0, 8)}` });
  await grantRolePermissions(role.id, [{ resource: 'devices', action: 'read' }]);
  await getTestDb().insert(organizationUsers).values({ userId: user.id, orgId, roleId: role.id, ...(siteIds ? { siteIds } : {}) });
  const sid = await seedSession(user.id);
  const epochs = await epochsOf(user.id);
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id, email: user.email, roleId: role.id, orgId, partnerId: tenant.partnerId,
    scope: 'organization', mfa: true, aep: epochs.authEpoch, mep: epochs.mfaEpoch, sid,
  };
  return { userId: user.id, token: await createAccessToken(payload), sid, ...epochs };
}

/** An older, silent record with hardware: created 30 days ago, last seen two hours ago. */
async function oldTarget(place: { orgId: string; siteId: string }, options: SeedDeviceOptions = {}, systemUuid: string | null = UUID) {
  const device = await silentTarget(place, options);
  await getTestDb().execute(sql`UPDATE devices SET created_at = now() - interval '30 days' WHERE id = ${device.id}::uuid`);
  await getTestDb().insert(deviceHardware).values({ deviceId: device.id, orgId: device.orgId, systemUuid, serialNumber: 'SN-1', manufacturer: 'Dell Inc.', model: 'Latitude' });
  return device;
}

async function withHardware(device: SeededAgentDevice, systemUuid = UUID) {
  await getTestDb().insert(deviceHardware).values({ deviceId: device.id, orgId: device.orgId, systemUuid, serialNumber: 'SN-1', manufacturer: 'Dell Inc.', model: 'Latitude' });
  return device;
}

async function mint(caller: Caller, resource: DeviceReattachResource): Promise<string> {
  const grant = await mintStepUpGrant({
    userId: caller.userId,
    operation: 'device_reattach',
    authEpoch: caller.authEpoch,
    mfaEpoch: caller.mfaEpoch,
    sid: caller.sid,
    resourceDigest: deviceReattachResourceDigest(resource),
  });
  if (!grant) throw new Error('grant mint failed (Redis?)');
  return grant;
}

/** The grant for exactly what the dialog showed: the target's current install. */
async function mintFor(caller: Caller, source: SeededAgentDevice, target: SeededAgentDevice, over: Partial<DeviceReattachResource> = {}) {
  const row = await readDevice(target.id);
  return mint(caller, {
    sourceDeviceId: source.id,
    targetDeviceId: target.id,
    targetAgentId: row!.agentId,
    targetIncarnation: row!.installIncarnation,
    evidenceLevel: 'hint',
    restoreDecommissioned: false,
    ...over,
  });
}

const grantExists = async (grantId: string) => (await getRedis()!.exists(`mfa:stepup:${grantId}`)) === 1;

const intentsOf = (sourceId: string) => getTestDb().select().from(deviceReattachIntents).where(eq(deviceReattachIntents.sourceDeviceId, sourceId));

let app: Hono;
beforeEach(() => {
  app = buildApp();
});

const post = (caller: Caller, sourceId: string, body: Record<string, unknown>) =>
  app.request(`/devices/${sourceId}/reattach`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const getCandidates = (caller: Caller, sourceId: string) =>
  app.request(`/devices/${sourceId}/reinstall-candidates`, { headers: { Authorization: `Bearer ${caller.token}` } });

const reattachBody = (target: SeededAgentDevice, grant: string | undefined, over: Record<string, unknown> = {}) => ({
  targetDeviceId: target.id,
  possessionConfirmed: true,
  confirmTargetName: target.hostname,
  ...(grant ? { stepUpGrant: grant } : {}),
  ...over,
});

describe('POST /devices/:id/reattach — the device_reattach step-up (#8318 §8)', () => {
  it('creates the requested intent, consumes the grant in the creating transaction, and a replay finds it gone', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const grant = await mintFor(admin, source, target);

    const res = await post(admin, source.id, reattachBody(target, grant));
    expect(res.status).toBe(202);
    const { intent } = await res.json() as { intent: { id: string; state: string; evidenceLevel: string } };
    expect(intent).toMatchObject({ state: 'requested', evidenceLevel: 'hint' });
    const [row] = await intentsOf(source.id);
    expect(row).toMatchObject({ id: intent.id, targetDeviceId: target.id, stepUpGrantRef: grant, requestedBy: tenant.admin.id });
    expect(await grantExists(grant)).toBe(false);

    // The replay, against a second free target so no other refusal answers first.
    const other = await silentTarget(tenant.orgA);
    const replay = await post(admin, (await parkedSource(tenant)).id, reattachBody(other, grant));
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('a refusal leaves the grant spendable; once the refusal is gone the same grant succeeds', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const source = await parkedSource(tenant);
    const target = await seedAgentDevice(tenant.orgA, { status: 'online', lastSeenAt: new Date() });
    const grant = await mintFor(admin, source, target);

    const alive = await post(admin, source.id, reattachBody(target, grant));
    expect(alive.status).toBe(409);
    expect(await alive.json()).toMatchObject({ code: 'target_alive' });
    expect(await grantExists(grant)).toBe(true);

    const wrongName = await post(admin, source.id, reattachBody(target, grant, { confirmTargetName: 'SOMETHING-ELSE' }));
    expect(wrongName.status).toBe(409); // still target_alive: the name is checked after liveness
    expect(await grantExists(grant)).toBe(true);

    await getTestDb().execute(sql`UPDATE devices SET status = 'offline', last_seen_at = now() - interval '2 hours' WHERE id = ${target.id}::uuid`);
    const mismatch = await post(admin, source.id, reattachBody(target, grant, { confirmTargetName: 'SOMETHING-ELSE' }));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: 'confirm_target_name_mismatch' });
    expect(await grantExists(grant)).toBe(true);

    const ok = await post(admin, source.id, reattachBody(target, grant, { confirmTargetName: target.hostname.toUpperCase() }));
    expect(ok.status).toBe(202);
    expect(await grantExists(grant)).toBe(false);
  });

  it('refuses a grant bound to another install of the target without consuming it', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const stale = await mintFor(admin, source, target, { targetIncarnation: 2 });
    const otherRestore = await mintFor(admin, source, target, { restoreDecommissioned: true });

    for (const grant of [stale, otherRestore]) {
      const res = await post(admin, source.id, reattachBody(target, grant));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(await grantExists(grant)).toBe(true);
    }
    expect(await intentsOf(source.id)).toHaveLength(0);
  });

  it('a missing grant is 403 STEP_UP_REQUIRED and writes nothing', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const res = await post(admin, source.id, reattachBody(target, undefined));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await intentsOf(source.id)).toHaveLength(0);
  });

  it('a failure after the consume rolls the intent back and the grant is gone (F20)', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const grant = await mintFor(admin, source, target);

    consumeSeam.failAfterConsume = true;
    const res = await post(admin, source.id, reattachBody(target, grant));
    expect(res.status).toBe(500);
    expect(await intentsOf(source.id)).toHaveLength(0);
    expect(await grantExists(grant)).toBe(false);
  });
});

describe('POST /devices/:id/reattach — who may reattach (#8318 §8, §9.3)', () => {
  it('a technician limited to selected orgs: 403 full_admin_required for a parked source, grant unspent', async () => {
    const tenant = await seedReattachTenant();
    const tech = await partnerCaller(tenant, 'techA');
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const grant = await mintFor(tech, source, target);
    const res = await post(tech, source.id, reattachBody(target, grant));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'full_admin_required' });
    expect(await grantExists(grant)).toBe(true);
  });

  it('a technician: 403 org_access_denied when either org is not theirs; accepted inside their own org', async () => {
    const tenant = await seedReattachTenant();
    const tech = await partnerCaller(tenant, 'techA');

    const sourceInB = await seedAgentDevice(tenant.orgB, { rebindProtocolVersion: 1 });
    const targetInA = await silentTarget(tenant.orgA);
    const deniedSource = await post(tech, sourceInB.id, reattachBody(targetInA, await mintFor(tech, sourceInB, targetInA)));
    expect(deniedSource.status).toBe(403);
    expect(await deniedSource.json()).toMatchObject({ code: 'org_access_denied' });

    const sourceInA = await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 });
    const targetInB = await silentTarget(tenant.orgB);
    const deniedTarget = await post(tech, sourceInA.id, reattachBody(targetInB, await mintFor(tech, sourceInA, targetInB)));
    expect(deniedTarget.status).toBe(403);
    expect(await deniedTarget.json()).toMatchObject({ code: 'org_access_denied' });

    const ok = await post(tech, sourceInA.id, reattachBody(targetInA, await mintFor(tech, sourceInA, targetInA)));
    expect(ok.status).toBe(202);
  });

  it('an OS change needs acknowledgeOsChange', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const source = await parkedSource(tenant, { osType: 'linux' });
    const target = await silentTarget(tenant.orgA);
    const grant = await mintFor(admin, source, target);
    const refused = await post(admin, source.id, reattachBody(target, grant));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'os_changed' });
    const ok = await post(admin, source.id, reattachBody(target, grant, { acknowledgeOsChange: true }));
    expect(ok.status).toBe(202);
  });

  it('an organization user is refused at the gate', async () => {
    const tenant = await seedReattachTenant();
    const orgUser = await orgCaller(tenant, tenant.orgA.orgId);
    const source = await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 });
    const target = await silentTarget(tenant.orgA);
    const res = await post(orgUser, source.id, reattachBody(target, undefined));
    expect(res.status).toBe(403);
    expect(await intentsOf(source.id)).toHaveLength(0);
  });
});

describe('GET /devices/:id/reinstall-candidates — no leaks (#8318 §7.3)', () => {
  it('a parked source: the full admin sees the ranked candidate with its step-up binding; a technician gets 404', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const tech = await partnerCaller(tenant, 'techA');
    const target = await oldTarget(tenant.orgA);
    const source = await withHardware(await parkedSource(tenant));

    const res = await getCandidates(admin, source.id);
    expect(res.status).toBe(200);
    const view = await res.json() as any;
    expect(view.source).toMatchObject({ deviceId: source.id, parked: true, rebindSupported: true, systemUuid: UUID });
    expect(view.reviewPending).toBe(false);
    expect(view.candidates).toHaveLength(1);
    const targetRow = await readDevice(target.id);
    expect(view.candidates[0]).toMatchObject({
      deviceId: target.id,
      orgId: tenant.orgA.orgId,
      hostname: target.hostname,
      evidence: 'system_uuid',
      reason: 'hardware',
      evidenceLevel: 'hint',
      osChanged: false,
      requiresRestore: false,
      serialNumber: 'SN-1',
      stepUpBinding: { targetAgentId: targetRow!.agentId, targetIncarnation: targetRow!.installIncarnation },
    });

    // The binding the read returns is exactly what the reattach accepts.
    const grant = await mint(admin, {
      sourceDeviceId: source.id,
      targetDeviceId: target.id,
      ...view.candidates[0].stepUpBinding,
      evidenceLevel: view.candidates[0].evidenceLevel,
      restoreDecommissioned: false,
    });
    expect((await post(admin, source.id, reattachBody(target, grant))).status).toBe(202);
    const after = await (await getCandidates(admin, source.id)).json() as any;
    expect(after.openIntent).toMatchObject({ state: 'requested', targetDeviceId: target.id });

    const techView = await getCandidates(tech, source.id);
    expect(techView.status).toBe(404);
    expect(await techView.text()).not.toContain(target.hostname);
  });

  it('a candidate in an org the technician lacks is only reviewPending', async () => {
    const tenant = await seedReattachTenant();
    const admin = await partnerCaller(tenant, 'admin');
    const tech = await partnerCaller(tenant, 'techA');
    const target = await oldTarget(tenant.orgB);
    const source = await withHardware(await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 }));

    const techRes = await getCandidates(tech, source.id);
    expect(techRes.status).toBe(200);
    const text = await techRes.text();
    expect(JSON.parse(text)).toMatchObject({ candidates: [], reviewPending: true });
    expect(text).not.toContain(target.id);
    expect(text).not.toContain(target.hostname);
    expect(text).not.toContain(tenant.orgB.orgId);

    const adminView = await (await getCandidates(admin, source.id)).json() as any;
    expect(adminView.candidates.map((c: any) => c.deviceId)).toEqual([target.id]);
  });

  it('an organization user never sees a candidate, even in their own org', async () => {
    const tenant = await seedReattachTenant();
    const orgUser = await orgCaller(tenant, tenant.orgA.orgId);
    const target = await oldTarget(tenant.orgA);
    const source = await withHardware(await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 }));
    const res = await getCandidates(orgUser, source.id);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ candidates: [], reviewPending: true });
    expect(text).not.toContain(target.id);
  });

  it('a site-restricted user cannot see a source outside their sites; a source in another org is a 404', async () => {
    const tenant = await seedReattachTenant();
    const otherSite = (await getTestDb().execute(sql`
      INSERT INTO sites (org_id, name) VALUES (${tenant.orgA.orgId}::uuid, 'Other site') RETURNING id`) as unknown as Array<{ id: string }>)[0]!.id;
    const restricted = await orgCaller(tenant, tenant.orgA.orgId, [otherSite]);
    await oldTarget(tenant.orgA);
    const source = await withHardware(await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 }));
    expect((await getCandidates(restricted, source.id)).status).toBe(404);

    const orgBUser = await orgCaller(tenant, tenant.orgB.orgId);
    expect((await getCandidates(orgBUser, source.id)).status).toBe(404);
  });
});
