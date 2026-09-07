import './setup';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, scriptExecutions, scripts, users } from '../../db/schema';
import { reapStaleDeviceCommands, reapStaleScriptExecutions } from '../../jobs/staleCommandReaper';
import { commandsRoutes } from '../../routes/devices/commands';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { deliveryTtlMs } from '../../services/commandOfflinePolicy';
import { dispatchDeviceCommand } from '../../services/dispatchDeviceCommand';
import { createAccessToken } from '../../services/jwt';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * #5128 W1 — real-Postgres proof of the offline work queue's core contract.
 *
 * Every case here is one a mocked unit test cannot decide, because the thing
 * under test IS the SQL: which rows the reaper's two-clock WHERE selects, which
 * rows the claim's `deliver_by` predicate and eligibility filter exclude, and
 * whether a cancel/CAS actually matched a row in the database.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const AGENT_CAPS = {
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  pamLifetimeProtocolVersion: 2,
} as const;

/**
 * These services are always invoked from inside a DB access context in the
 * running API (a request context, or the reaper worker's own system wrap).
 * Calling them bare here would hit the contextless-access guard, which DENIES
 * rather than bypasses — every query would return zero rows and the assertions
 * below would pass for entirely the wrong reason.
 */
function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemDbAccessContext(fn);
}

function claim(deviceId: string) {
  return asSystem(() => claimPendingCommandsForDevice(deviceId, 10, 'agent', undefined, { ...AGENT_CAPS }));
}

type DeviceStatus = (typeof devices.$inferInsert)['status'];

async function makeDevice(orgId: string, siteId: string, status: DeviceStatus) {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `offline-queue-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: '0.0.0-test',
      status,
    })
    .returning();
  if (!device) throw new Error('device fixture insert failed');
  return device;
}

async function commandRow(id: string) {
  const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id)).limit(1);
  return row;
}

async function countCommandsFor(deviceId: string) {
  const rows = await getTestDb()
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(eq(deviceCommands.deviceId, deviceId));
  return rows.length;
}

describe('device command offline queue — real PostgreSQL (#5128 W1)', () => {
  let env: Awaited<ReturnType<typeof setupTestEnvironment>>;

  beforeEach(async () => {
    env = await setupTestEnvironment({ scope: 'organization' });
    // The generic device-command routes queue regardless of this flag, but the
    // seam's `previouslyRejected` callers are gated on it; turn it on so the
    // queue arm is exercised end to end.
    process.env.DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED = 'true';
  });

  it('queues against an offline device with a deliver_by and submitted_org_id', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');

    const before = Date.now();
    const res = await asSystem(() =>
      dispatchDeviceCommand({ deviceId: device.id, type: 'refresh_inventory', userId: env.user.id }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivery).toBe('queued_offline');

    const row = await commandRow(res.command.id);
    expect(row?.status).toBe('pending');
    expect(row?.submittedOrgId).toBe(env.organization.id);
    expect(row?.deliverBy).toBeInstanceOf(Date);
    // refresh_inventory is a `short` (24 h) TTL class.
    const ttl = row!.deliverBy!.getTime() - before;
    expect(ttl).toBeGreaterThan(deliveryTtlMs('short') - 60_000);
    expect(ttl).toBeLessThan(deliveryTtlMs('short') + 60_000);
  });

  it('a reject-policy dispatch against an offline device creates NO row', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');

    const res = await asSystem(() =>
      dispatchDeviceCommand({ deviceId: device.id, type: 'list_processes', userId: env.user.id }),
    );

    expect(res).toMatchObject({ ok: false, code: 'device_offline' });
    expect(await countCommandsFor(device.id)).toBe(0);
  });

  it('a queued row survives long past its EXECUTION timeout while deliver_by is in the future', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');

    // A script with a 300 s execution timeout, created two hours ago. Under the
    // pre-#5128 rule this was reaped as "agent never received the command".
    const [row] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'script',
        payload: { timeoutSeconds: 300 },
        status: 'pending',
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
        deliverBy: new Date(Date.now() + 6 * DAY_MS),
        submittedOrgId: env.organization.id,
      })
      .returning();

    expect(await asSystem(() => reapStaleDeviceCommands())).toBe(0);
    expect((await commandRow(row!.id))?.status).toBe('pending');
  });

  it('expires exactly at deliver_by with expired / not_delivered_before_deadline', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');

    const [row] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'script',
        payload: { timeoutSeconds: 300 },
        status: 'pending',
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
        deliverBy: new Date(Date.now() - 1000),
        submittedOrgId: env.organization.id,
      })
      .returning();

    expect(await asSystem(() => reapStaleDeviceCommands())).toBeGreaterThanOrEqual(1);

    const after = await commandRow(row!.id);
    expect(after?.status).toBe('failed');
    expect(after?.result).toMatchObject({
      status: 'expired',
      reason: 'not_delivered_before_deadline',
      timedOutBy: 'server',
    });
  });

  it('the script execution is failed only by propagation, never by its own reaper', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');
    const [script] = await getTestDb()
      .insert(scripts)
      .values({
        orgId: env.organization.id,
        name: 'Offline Queue Script',
        osTypes: ['linux'],
        language: 'bash',
        content: 'true',
        timeoutSeconds: 300,
      })
      .returning();

    async function seed(deliverBy: Date) {
      const [execution] = await getTestDb()
        .insert(scriptExecutions)
        .values({
          scriptId: script!.id,
          deviceId: device.id,
          orgId: env.organization.id,
          status: 'queued',
          createdAt: new Date(Date.now() - 2 * HOUR_MS),
        })
        .returning();
      const [command] = await getTestDb()
        .insert(deviceCommands)
        .values({
          deviceId: device.id,
          type: 'script',
          payload: { timeoutSeconds: 300, executionId: execution!.id },
          status: 'pending',
          createdAt: new Date(Date.now() - 2 * HOUR_MS),
          deliverBy,
          submittedOrgId: env.organization.id,
        })
        .returning();
      return { execution: execution!, command: command! };
    }

    // 1. Still waiting for the device: the SCRIPT reaper must not touch it. Its
    //    own 300 s execution timeout lapsed 2 h ago, so before #5128 this
    //    execution was failed under a command that was legitimately waiting.
    const waiting = await seed(new Date(Date.now() + 6 * DAY_MS));
    expect(await asSystem(() => reapStaleScriptExecutions())).toBe(0);
    const [waitingExec] = await getTestDb()
      .select()
      .from(scriptExecutions)
      .where(eq(scriptExecutions.id, waiting.execution.id))
      .limit(1);
    expect(waitingExec?.status).toBe('queued');

    // 2. Past its deadline: the COMMAND reaper expires it and propagates.
    const expired = await seed(new Date(Date.now() - 1000));
    await asSystem(() => reapStaleDeviceCommands());
    const [expiredExec] = await getTestDb()
      .select()
      .from(scriptExecutions)
      .where(eq(scriptExecutions.id, expired.execution.id))
      .limit(1);
    expect(expiredExec?.status).toBe('failed');
    expect(expiredExec?.errorMessage).toContain('did not reconnect');
  });

  it('a heartbeat claim after the device comes online delivers the row exactly once', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');
    const res = await asSystem(() =>
      dispatchDeviceCommand({ deviceId: device.id, type: 'refresh_inventory', userId: env.user.id }),
    );
    expect(res.ok).toBe(true);

    await getTestDb().update(devices).set({ status: 'online' }).where(eq(devices.id, device.id));

    const first = await claim(device.id);
    expect(first.map((c) => c.type)).toEqual(['refresh_inventory']);
    expect(first[0]?.status).toBe('sent');

    expect(await claim(device.id)).toEqual([]);
  });

  it('a row past its deliver_by is NOT claimed — the reaper owns it', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    await getTestDb().insert(deviceCommands).values({
      deviceId: device.id,
      type: 'refresh_inventory',
      payload: {},
      status: 'pending',
      deliverBy: new Date(Date.now() - 1000),
      submittedOrgId: env.organization.id,
    });

    expect(await claim(device.id)).toEqual([]);
  });

  it('a device that moved org has its queued rows cancelled at claim, never delivered', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    const res = await asSystem(() =>
      dispatchDeviceCommand({
        deviceId: device.id,
        type: 'refresh_inventory',
        userId: env.user.id,
        preferHeartbeat: true,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const otherPartner = await createPartner({ name: `Other Partner ${randomUUID().slice(0, 8)}` });
    const otherOrg = await createOrganization({
      partnerId: otherPartner.id,
      name: `Other Org ${randomUUID().slice(0, 8)}`,
    });
    const otherSite = await createSite({ orgId: otherOrg.id });
    await getTestDb()
      .update(devices)
      .set({ orgId: otherOrg.id, siteId: otherSite.id })
      .where(eq(devices.id, device.id));

    expect(await claim(device.id)).toEqual([]);

    const after = await commandRow(res.command.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.result).toMatchObject({ reason: 'device_moved_org' });
  });

  it('a reboot is held while other work is claimable, then claimed once the queue drains', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');

    const [inventory] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'refresh_inventory',
        payload: {},
        status: 'pending',
        createdAt: new Date(Date.now() - 60_000),
        deliverBy: new Date(Date.now() + HOUR_MS),
        submittedOrgId: env.organization.id,
      })
      .returning();
    const [reboot] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'reboot',
        payload: {},
        status: 'pending',
        createdAt: new Date(Date.now() - 30_000),
        deliverBy: new Date(Date.now() + HOUR_MS),
        submittedOrgId: env.organization.id,
      })
      .returning();

    const first = await claim(device.id);
    expect(first.map((c) => c.id)).toEqual([inventory!.id]);
    expect((await commandRow(reboot!.id))?.status).toBe('pending');

    // While the inventory command is still in flight (`sent`), the barrier holds.
    expect(await claim(device.id)).toEqual([]);

    await getTestDb()
      .update(deviceCommands)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(deviceCommands.id, inventory!.id));

    const third = await claim(device.id);
    expect(third.map((c) => c.id)).toEqual([reboot!.id]);
  });

  it('POST /devices/:id/commands/:commandId/cancel cancels once, then 409s', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');
    const res = await asSystem(() =>
      dispatchDeviceCommand({ deviceId: device.id, type: 'refresh_inventory', userId: env.user.id }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const app = new Hono();
    app.route('/devices', commandsRoutes);
    const token = await createAccessToken({
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
    });

    const url = `/devices/${device.id}/commands/${res.command.id}/cancel`;
    const first = await app.request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'cancelled' });

    const after = await commandRow(res.command.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.result).toMatchObject({ reason: 'user_cancelled' });

    const second = await app.request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(second.status).toBe(409);
  });

  it('a cancelled row is never claimed afterwards', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    const [row] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'refresh_inventory',
        payload: {},
        status: 'cancelled',
        completedAt: new Date(),
        deliverBy: new Date(Date.now() + HOUR_MS),
        submittedOrgId: env.organization.id,
      })
      .returning();

    expect(await claim(device.id)).toEqual([]);
    expect((await commandRow(row!.id))?.status).toBe('cancelled');
  });

  it('legacy pending rows (deliver_by NULL) keep the old created_at + execution-timeout rule', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'offline');
    const [row] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'script',
        payload: { timeoutSeconds: 300 },
        status: 'pending',
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
        deliverBy: null,
        submittedOrgId: null,
      })
      .returning();

    expect(await asSystem(() => reapStaleDeviceCommands())).toBeGreaterThanOrEqual(1);
    const after = await commandRow(row!.id);
    expect(after?.status).toBe('failed');
    expect(after?.result).toMatchObject({ status: 'timeout' });
  });

  it('a legacy row with a NULL submitted_org_id is still claimable (no false org-drift cancel)', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    await getTestDb().insert(deviceCommands).values({
      deviceId: device.id,
      type: 'refresh_inventory',
      payload: {},
      status: 'pending',
      deliverBy: null,
      submittedOrgId: null,
    });

    const claimed = await claim(device.id);
    expect(claimed.map((c) => c.type)).toEqual(['refresh_inventory']);
  });

  it('a decommissioned device gets no new commands and its pending work is not delivered', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    const res = await asSystem(() =>
      dispatchDeviceCommand({
        deviceId: device.id,
        type: 'refresh_inventory',
        userId: env.user.id,
        preferHeartbeat: true,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    await getTestDb().update(devices).set({ status: 'decommissioned' }).where(eq(devices.id, device.id));

    const refused = await asSystem(() =>
      dispatchDeviceCommand({ deviceId: device.id, type: 'refresh_inventory', userId: env.user.id }),
    );
    expect(refused).toMatchObject({ ok: false, code: 'device_decommissioned' });

    expect(await claim(device.id)).toEqual([]);
    const after = await commandRow(res.command.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.result).toMatchObject({ reason: 'device_lifecycle' });
  });

  it('the partial deliver_by index exists, so the reaper scan never seq-scans device_commands', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'device_commands' AND indexname = 'idx_device_commands_deliver_by'
    `);
    const list = rows as unknown as Array<{ indexdef: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.indexdef).toContain('deliver_by');
    // Partial: a full index over every row would defeat the point of keeping
    // 7-day rows out of the two-minute rescan.
    expect(list[0]!.indexdef).toContain('WHERE');
    expect(list[0]!.indexdef).toContain('pending');
  });

  it('device_commands still has NO org_id column — submitted_org_id must not reclassify the table', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'device_commands' AND column_name = 'org_id'
    `);
    expect(rows as unknown as unknown[]).toHaveLength(0);
  });

  it('the seam refuses an unregistered command type before touching the database', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    await expect(
      asSystem(() =>
        dispatchDeviceCommand({ deviceId: device.id, type: 'not_a_real_command_type', userId: env.user.id }),
      ),
    ).rejects.toThrow(/COMMAND_OFFLINE_POLICY_REGISTRY/);
    expect(await countCommandsFor(device.id)).toBe(0);
  });

  it('an inactive requester has their queued work cancelled at claim', async () => {
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    const res = await asSystem(() =>
      dispatchDeviceCommand({
        deviceId: device.id,
        type: 'refresh_inventory',
        userId: env.user.id,
        preferHeartbeat: true,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Positive control: without a recorded requester this test would pass for
    // the wrong reason (eligibility skips rows whose created_by is NULL).
    expect((await commandRow(res.command.id))?.createdBy).toBe(env.user.id);

    await getTestDb().update(users).set({ status: 'disabled' }).where(eq(users.id, env.user.id));

    expect(await claim(device.id)).toEqual([]);
    const after = await commandRow(res.command.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.result).toMatchObject({ reason: 'requester_inactive' });
  });

  it('the cancel-on-event predicate spares in-flight work', async () => {
    // Mirrors the org-move / decommission cancel the routes write, exercised
    // directly so the SQL predicate (status='pending' only) is proven against a
    // real table rather than a chainable mock.
    const device = await makeDevice(env.organization.id, env.site.id, 'online');
    const [pending] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'refresh_inventory',
        payload: {},
        status: 'pending',
        deliverBy: new Date(Date.now() + HOUR_MS),
        submittedOrgId: env.organization.id,
      })
      .returning();
    const [alreadySent] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'script',
        payload: {},
        status: 'sent',
        executedAt: new Date(),
        deliverBy: new Date(Date.now() + HOUR_MS),
        submittedOrgId: env.organization.id,
      })
      .returning();

    await getTestDb()
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        result: { status: 'cancelled', reason: 'device_moved_org' },
      })
      .where(and(eq(deviceCommands.deviceId, device.id), eq(deviceCommands.status, 'pending')));

    expect((await commandRow(pending!.id))?.status).toBe('cancelled');
    // An in-flight command is NOT cancelled — it is already on the machine.
    expect((await commandRow(alreadySent!.id))?.status).toBe('sent');
  });
});
