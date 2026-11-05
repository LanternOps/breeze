/**
 * #11065 W04: Run vendor updates end to end against real Postgres and Redis.
 *
 * What the unit tests mock, this proves, as `breeze_app` under the real RLS:
 *   - mounted at /api/v1, so the route runs self-managed: the device read, the
 *     seam's own transaction and the audit row all work with no request context;
 *   - the queued row: categories, reboot control, deadline and the org stamp;
 *   - refusals queue nothing, and a refusal is audited;
 *   - when_finished plus rebootRequired queues a real schedule_reboot only after
 *     the result's transaction commits; leave_to_me queues none;
 *   - history shows only this org's runs of this type, with their actors.
 *
 * Gates are closed in code at this wave, so the lab override opens them for the
 * seeded device: the same path a lab wave uses.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemUpdateRunRoute.integration.test.ts
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { withDbAccessContext } from '../../db';
import { auditLogs, deviceCommands, deviceHardware, devices } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { agentRoutes } from '../../routes/agents';
import { deviceRoutes } from '../../routes/devices';
import { commandResultHandlers } from '../../services/commandResultHandlers';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { createOrganization, createPartner, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const LIVE_ONLY_MS = 15 * 60 * 1000;

const needsReboot = {
  lane: 'dell',
  outcome: 'success_reboot_required',
  toolVersion: '5.7.2',
  rawExitCode: 1,
  errorCode: null,
  rebootRequired: true,
  shutdownRequired: false,
  items: [{ title: 'Driver A', category: 'driver', version: '1.0', result: 'installed' }],
  skippedCategories: [],
  takeover: 'not_attempted',
};

describe('#11065 POST /devices/:id/oem-updates/run', () => {
  let app: Hono;
  let env: TestEnvironment;
  let token: string;

  async function seedDevice(
    orgId: string,
    siteId: string,
    over: Partial<typeof devices.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await getTestDb().insert(devices).values({
      orgId,
      siteId,
      agentId: `oem-${randomUUID()}`,
      hostname: 'oem-host',
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.127.0',
      status: 'online',
      ...over,
    }).returning({ id: devices.id });
    await getTestDb().insert(deviceHardware).values({
      deviceId: row!.id,
      orgId,
      manufacturer: 'Dell Inc.',
      model: 'Latitude 7420',
      biosVersion: '1.20.0',
    });
    return row!.id;
  }

  const labDevice = async (over: Partial<typeof devices.$inferInsert> = {}) => {
    const deviceId = await seedDevice(env.organization.id, env.site.id, over);
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', deviceId);
    return deviceId;
  };

  const post = (deviceId: string, body: unknown) =>
    app.request(`/api/v1/devices/${deviceId}/oem-updates/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const get = (deviceId: string, path: string) =>
    app.request(`/api/v1/devices/${deviceId}/oem-updates/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  const rows = (deviceId: string, type: string) =>
    getTestDb().select().from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, type)));

  async function auditFor(deviceId: string) {
    for (let i = 0; i < 40; i++) {
      const [audit] = await getTestDb().select().from(auditLogs)
        .where(and(eq(auditLogs.resourceId, deviceId), eq(auditLogs.action, 'device.oem_updates.run')));
      if (audit) return audit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  }

  /** The agent's own org context, as the REST transport holds it around the handler. */
  const deliverResult = async (deviceId: string, commandId: string, result: unknown) => {
    const [command] = await rows(deviceId, 'oem_update_run');
    await withDbAccessContext(
      {
        scope: 'organization',
        orgId: env.organization.id,
        accessibleOrgIds: [env.organization.id],
        accessiblePartnerIds: [],
        currentPartnerId: env.partner.id,
      },
      () => commandResultHandlers.oem_update_run!({
        agentId: 'agent',
        command: command as never,
        commandId,
        result: { status: 'completed' } as never,
        resolvedDeviceId: deviceId,
        stdout: JSON.stringify(result),
      }) as Promise<unknown>,
    );
  };

  async function waitForReboot(deviceId: string) {
    for (let i = 0; i < 60; i++) {
      const [row] = await rows(deviceId, 'schedule_reboot');
      if (row) return row;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  }

  beforeEach(async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/api/v1/devices', deviceRoutes);
    env = await setupTestEnvironment({ scope: 'organization' });
    const payload: Omit<TokenPayload, 'type'> = {
      sub: env.user.id,
      email: env.user.email,
      roleId: env.role.id,
      orgId: env.organization.id,
      partnerId: env.partner.id,
      scope: 'organization',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    };
    token = await createAccessToken(payload);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('when_finished queues the run with every open category, the org stamp and the live_only deadline', async () => {
    const deviceId = await labDevice();
    const before = Date.now();
    const res = await post(deviceId, { reboot: 'when_finished' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.categories).toEqual(['bios', 'firmware', 'driver', 'application']);
    expect(body.skippedCategories).toEqual([]);

    const [row] = await rows(deviceId, 'oem_update_run');
    expect(row).toMatchObject({ id: body.commandId, submittedOrgId: env.organization.id, createdBy: env.user.id });
    expect(row!.payload).toMatchObject({
      lane: 'dell',
      trigger: 'on_demand',
      rebootControlled: true,
      categories: ['bios', 'firmware', 'driver', 'application'],
    });
    const deliverBy = row!.deliverBy!.getTime();
    expect(deliverBy).toBeGreaterThanOrEqual(before + LIVE_ONLY_MS - 5_000);
    expect(deliverBy).toBeLessThanOrEqual(Date.now() + LIVE_ONLY_MS + 5_000);

    const audit = await auditFor(deviceId);
    expect(audit).toBeDefined();
    expect(audit!.actorId).toBe(env.user.id);
    expect(audit!.result).toBe('success');
    expect(audit!.details).toMatchObject({ commandId: body.commandId, reboot: 'when_finished' });
  });

  it('leave_to_me sends no BIOS or firmware and says it skipped them', async () => {
    const deviceId = await labDevice();
    const res = await post(deviceId, { reboot: 'leave_to_me' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      categories: ['driver', 'application'],
      skippedCategories: ['bios', 'firmware'],
    });
    const [row] = await rows(deviceId, 'oem_update_run');
    expect(row!.payload).toMatchObject({ rebootControlled: false, categories: ['driver', 'application'] });
  });

  it('a closed gate is the real answer today: 409 lane_closed, nothing queued, the attempt audited', async () => {
    const deviceId = await seedDevice(env.organization.id, env.site.id);
    const res = await post(deviceId, { reboot: 'when_finished' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('lane_closed');
    expect(await rows(deviceId, 'oem_update_run')).toEqual([]);
    const audit = await auditFor(deviceId);
    expect(audit!.result).toBe('denied');
    expect(audit!.details).toMatchObject({ refusal: 'lane_closed' });
  });

  const REFUSALS: Array<[string, string, Partial<typeof devices.$inferInsert>, boolean]> = [
    ['refuses when flag off', 'flag_off', {}, true],
    ['offline is 409 offline, nothing queued', 'offline', { status: 'offline' }, false],
    ['refuses Quick Support device', 'ephemeral', { isEphemeral: true }, false],
    ['refuses decommissioned', 'decommissioned', { status: 'decommissioned' }, false],
    ['an old agent', 'agent_too_old', { agentVersion: '0.126.0' }, false],
  ];
  it.each(REFUSALS)('%s', async (_label, code, over, flagOff) => {
    const deviceId = await labDevice(over);
    if (flagOff) vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    const res = await post(deviceId, { reboot: 'when_finished' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(code);
    expect(await rows(deviceId, 'oem_update_run')).toEqual([]);
  });

  it('a second run while one is in flight is refused', async () => {
    const deviceId = await labDevice();
    expect((await post(deviceId, { reboot: 'when_finished' })).status).toBe(202);
    const res = await post(deviceId, { reboot: 'when_finished' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('run_in_flight');
    expect(await rows(deviceId, 'oem_update_run')).toHaveLength(1);
  });

  it("another org's device is a 404 on all three routes, and nothing is queued", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id);
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', deviceId);
    expect((await post(deviceId, { reboot: 'when_finished' })).status).toBe(404);
    expect((await get(deviceId, 'status')).status).toBe(404);
    expect((await get(deviceId, 'history')).status).toBe(404);
    expect(await rows(deviceId, 'oem_update_run')).toEqual([]);
  });

  describe('after the result', () => {
    it('when_finished then rebootRequired queues schedule_reboot with source oem_updates and the default warning', async () => {
      const deviceId = await labDevice();
      const { commandId } = await (await post(deviceId, { reboot: 'when_finished' })).json();

      await deliverResult(deviceId, commandId, needsReboot);

      const reboot = await waitForReboot(deviceId);
      expect(reboot).toBeDefined();
      expect(reboot!.submittedOrgId).toBe(env.organization.id);
      expect(reboot!.payload).toMatchObject({
        source: 'oem_updates',
        delayMinutes: 15,
        allowDeferral: false,
      });
    });

    it('over the real result route: one reboot after the commit, and a replayed result queues no second one', async () => {
      const deviceId = await labDevice();
      const { commandId } = await (await post(deviceId, { reboot: 'when_finished' })).json();

      const agentToken = `brz_${randomUUID().replaceAll('-', '')}`;
      const [device] = await getTestDb().update(devices)
        .set({ agentTokenHash: createHash('sha256').update(agentToken).digest('hex') })
        .where(eq(devices.id, deviceId))
        .returning({ agentId: devices.agentId });
      await getTestDb().update(deviceCommands).set({ status: 'sent' }).where(eq(deviceCommands.id, commandId));

      const agentApp = new Hono();
      agentApp.route('/api/v1/agents', agentRoutes);
      const report = () => agentApp.request(`/api/v1/agents/${device!.agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({ status: 'completed', exitCode: 0, stdout: JSON.stringify(needsReboot) }),
      });

      expect((await report()).status).toBe(200);
      const reboot = await waitForReboot(deviceId);
      expect(reboot?.payload).toMatchObject({ source: 'oem_updates' });

      expect((await report()).status).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(await rows(deviceId, 'schedule_reboot')).toHaveLength(1);

      const [run] = await rows(deviceId, 'oem_update_run');
      expect(run).toMatchObject({ status: 'completed' });
      const history = await (await get(deviceId, 'history')).json();
      expect(history.runs[0]).toMatchObject({ commandId, outcome: 'success_reboot_required', rebootRequired: true });
    });

    it('leave_to_me queues no reboot, and the device shows it is waiting for one', async () => {
      const deviceId = await labDevice();
      const { commandId } = await (await post(deviceId, { reboot: 'leave_to_me' })).json();

      await deliverResult(deviceId, commandId, needsReboot);
      await new Promise((r) => setTimeout(r, 200));

      expect(await rows(deviceId, 'schedule_reboot')).toEqual([]);
      const status = await (await get(deviceId, 'status')).json();
      expect(status.displayState).toBe('waiting_for_reboot');
      expect(status.status).toMatchObject({ lastOutcome: 'success_reboot_required', rebootRequired: true });
    });
  });

  describe('GET status', () => {
    it('reads as the org, with the gates the lab override opened', async () => {
      const deviceId = await labDevice();
      const res = await get(deviceId, 'status');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        displayState: 'not_managed',
        lane: 'dell',
        status: null,
        gates: { bios: 'open', firmware: 'open', driver: 'open', application: 'open' },
      });
    });

    it('shows no lane with the flag off, so the console offers nothing', async () => {
      const deviceId = await labDevice();
      vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
      const body = await (await get(deviceId, 'status')).json();
      expect(body.lane).toBeNull();
    });
  });

  describe('GET history', () => {
    const insertRun = (deviceId: string, over: Partial<typeof deviceCommands.$inferInsert>) =>
      getTestDb().insert(deviceCommands).values({
        deviceId,
        type: 'oem_update_run',
        payload: { trigger: 'on_demand', rebootControlled: true },
        status: 'completed',
        targetRole: 'agent',
        submittedOrgId: env.organization.id,
        createdBy: env.user.id,
        ...over,
      }).returning({ id: deviceCommands.id });

    it('only type oem_update_run', async () => {
      const deviceId = await labDevice();
      await insertRun(deviceId, { type: 'script' });
      const [run] = await insertRun(deviceId, {});
      const body = await (await get(deviceId, 'history')).json();
      expect(body.total).toBe(1);
      expect(body.runs.map((r: { commandId: string }) => r.commandId)).toEqual([run!.id]);
    });

    it("filters submitted_org_id to the device's current org: a run from before a move is absent, with its actor", async () => {
      const partner = await createPartner();
      const earlierOrg = await createOrganization({ partnerId: partner.id });
      const deviceId = await labDevice();
      await insertRun(deviceId, { submittedOrgId: earlierOrg.id });
      const [run] = await insertRun(deviceId, {});
      const body = await (await get(deviceId, 'history')).json();
      expect(body.total).toBe(1);
      expect(body.runs[0].commandId).toBe(run!.id);
      expect(body.runs[0].actor.id).toBe(env.user.id);
    });

    it('null submitted_org_id excluded', async () => {
      const deviceId = await labDevice();
      await insertRun(deviceId, { submittedOrgId: null });
      const body = await (await get(deviceId, 'history')).json();
      expect(body).toEqual({ runs: [], total: 0 });
    });

    it('pagination: newest first, total across pages', async () => {
      const deviceId = await labDevice();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const [run] = await insertRun(deviceId, { createdAt: new Date(Date.UTC(2026, 10, 1 + i)) });
        ids.push(run!.id);
      }
      const first = await (await get(deviceId, 'history?limit=2&offset=0')).json();
      expect(first.total).toBe(3);
      expect(first.runs.map((r: { commandId: string }) => r.commandId)).toEqual([ids[2], ids[1]]);
      const second = await (await get(deviceId, 'history?limit=2&offset=2')).json();
      expect(second.total).toBe(3);
      expect(second.runs.map((r: { commandId: string }) => r.commandId)).toEqual([ids[0]]);
    });

    it('a malformed result shows as no outcome, not a failed request', async () => {
      const deviceId = await labDevice();
      await insertRun(deviceId, { result: { status: 'completed', stdout: 'not json' } });
      const body = await (await get(deviceId, 'history')).json();
      expect(body.runs[0]).toMatchObject({ outcome: null, items: [], status: 'completed' });
    });
  });
});
