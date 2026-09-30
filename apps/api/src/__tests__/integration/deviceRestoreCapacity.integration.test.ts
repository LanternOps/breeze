/**
 * Restoring a decommissioned device respects the partner device limit, the
 * same admission enrollment and provisioning use — proved against real
 * Postgres.
 *
 * The HTTP cases run the real auth middleware as an organization-scoped user
 * (`breeze_app`, forced RLS). That matters: the partner row and the
 * partner-wide device count are invisible under tenant RLS, so these cases
 * fail if the restore ever runs its admission in the caller's context.
 *
 * Run (private per-worktree stack):
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceRestoreCapacity.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import { devices, organizationUsers, partners } from '../../db/schema';
import { deviceRoutes } from '../../routes/devices';
import { DeviceLifecycleError, restoreRemovedDevice } from '../../services/deviceLifecycle';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const LIMIT_REFUSAL = { error: 'Device limit reached', code: 'DEVICE_LIMIT_REACHED' };

function app(): Hono {
  const instance = new Hono();
  instance.route('/devices', deviceRoutes);
  return instance;
}

async function mfaToken(env: TestEnvironment): Promise<string> {
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
  return createAccessToken(payload);
}

async function setDeviceLimit(partnerId: string, maxDevices: number | null): Promise<void> {
  await getTestDb().update(partners).set({ maxDevices }).where(eq(partners.id, partnerId));
}

async function seedDevice(
  orgId: string,
  siteId: string,
  status: 'online' | 'decommissioned',
  opts: { isEphemeral?: boolean } = {},
): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `restore-cap-${suffix}-${randomUUID()}`.slice(0, 64),
    hostname: `restore-cap-${suffix}`,
    osType: 'linux',
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: '0.0.0-test',
    status,
    isEphemeral: opts.isEphemeral ?? false,
    decommissionedAt: status === 'decommissioned' ? new Date() : null,
  }).returning({ id: devices.id });
  return row!.id;
}

async function statusOf(deviceId: string): Promise<string | undefined> {
  const [row] = await getTestDb()
    .select({ status: devices.status })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row?.status;
}

function restoreRequest(token: string, deviceId: string): Response | Promise<Response> {
  return app().request(`/devices/${deviceId}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function waitForBlockedBackend(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ blocked: boolean }>(sql`
      select cardinality(pg_catalog.pg_blocking_pids(${pid})) > 0 as blocked
    `);
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`restore contender backend ${pid} did not block on the partner admission lock`);
}

describe('restoring a decommissioned device respects the partner device limit — real PostgreSQL', () => {
  runDb('refuses a restore at the limit with the enrollment refusal, and restores once there is room', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    await seedDevice(env.organization.id, env.site.id, 'online');
    const removed = await seedDevice(env.organization.id, env.site.id, 'decommissioned');
    await setDeviceLimit(env.partner.id, 1);

    const refused = await restoreRequest(token, removed);
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({
      ...LIMIT_REFUSAL,
      currentDevices: 1,
      maxDevices: 1,
    });
    expect(await statusOf(removed)).toBe('decommissioned');

    await setDeviceLimit(env.partner.id, 2);
    const restored = await restoreRequest(token, removed);
    expect(restored.status).toBe(200);
    expect(await statusOf(removed)).toBe('offline');
  });

  // The restore write now runs in a system-scoped transaction, so the
  // tenant-scoped check in front of it is the only thing keeping a caller
  // away from a device it cannot see. Both refusals must leave the row alone.
  runDb('refuses a device in another tenant (404) or a hidden site (403) before any write', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    const other = await setupTestEnvironment({ scope: 'organization' });
    const foreign = await seedDevice(other.organization.id, other.site.id, 'decommissioned');

    const crossTenant = await restoreRequest(token, foreign);
    expect(crossTenant.status).toBe(404);
    await expect(crossTenant.json()).resolves.toEqual({ error: 'Device not found' });
    expect(await statusOf(foreign)).toBe('decommissioned');

    const hiddenSite = await createSite({ orgId: env.organization.id, name: `hidden ${randomUUID()}` });
    const hidden = await seedDevice(env.organization.id, hiddenSite.id, 'decommissioned');
    await getTestDb().update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(and(
        eq(organizationUsers.userId, env.user.id),
        eq(organizationUsers.orgId, env.organization.id),
      ));
    await clearPermissionCache(env.user.id);

    const siteDenied = await restoreRequest(token, hidden);
    expect(siteDenied.status).toBe(403);
    await expect(siteDenied.json()).resolves.toEqual({ error: 'Access to this site denied' });
    expect(await statusOf(hidden)).toBe('decommissioned');
  });

  runDb('bulk restore admits each device on its own and reports the ones over the limit', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    await seedDevice(env.organization.id, env.site.id, 'online');
    const first = await seedDevice(env.organization.id, env.site.id, 'decommissioned');
    const second = await seedDevice(env.organization.id, env.site.id, 'decommissioned');
    await setDeviceLimit(env.partner.id, 2);

    const res = await app().request('/devices/bulk/restore', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: [first, second] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      succeeded: Array<{ deviceId: string }>;
      failed: Array<{ deviceId: string; code: string; message: string }>;
    };
    expect(body.succeeded.map((r) => r.deviceId)).toEqual([first]);
    expect(body.failed).toEqual([
      { deviceId: second, code: 'DEVICE_LIMIT_REACHED', message: 'Device limit reached' },
    ]);
    expect(await statusOf(first)).toBe('offline');
    expect(await statusOf(second)).toBe('decommissioned');
  });

  runDb('restores an ephemeral device at the limit: it never takes a licensed slot', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    await seedDevice(env.organization.id, env.site.id, 'online');
    const ephemeral = await seedDevice(env.organization.id, env.site.id, 'decommissioned', { isEphemeral: true });
    await setDeviceLimit(env.partner.id, 1);

    const res = await restoreRequest(token, ephemeral);
    expect(res.status).toBe(200);
    expect(await statusOf(ephemeral)).toBe('offline');
  });

  runDb('restores a parked device at the limit: the holding org never counts', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedDevice(env.organization.id, env.site.id, 'online');
    await setDeviceLimit(env.partner.id, 1);
    const holding = await seedHoldingOrg(env.partner.id);
    const parked = await seedParkedDevice(holding.orgId, holding.siteId);
    await getTestDb().update(devices)
      .set({ status: 'decommissioned', decommissionedAt: new Date() })
      .where(eq(devices.id, parked.id));

    const result = await withSystemDbAccessContext(() => db.transaction((tx) =>
      restoreRemovedDevice(tx, parked.id, { orgId: holding.orgId, siteId: holding.siteId }),
    ));
    expect(result.device?.status).toBe('offline');
  });

  runDb('two restores racing for the last slot: exactly one wins, the other waits on the partner lock', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedDevice(env.organization.id, env.site.id, 'online');
    const a = await seedDevice(env.organization.id, env.site.id, 'decommissioned');
    const b = await seedDevice(env.organization.id, env.site.id, 'decommissioned');
    await setDeviceLimit(env.partner.id, 2);
    const pin = { orgId: env.organization.id, siteId: env.site.id };

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstRestored!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => { firstRestored = resolve; });
    let secondPid: number | undefined;

    const first = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const result = await restoreRemovedDevice(tx, a, pin);
      firstRestored();
      await holdFirst;
      return result;
    }));
    await firstHoldsLock;

    const second = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const [pidRow] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
      secondPid = pidRow!.pid;
      return restoreRemovedDevice(tx, b, pin);
    })).then(
      () => 'restored' as const,
      (err: unknown) => err,
    );
    while (secondPid === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await waitForBlockedBackend(secondPid);
    releaseFirst();

    await expect(first).resolves.toMatchObject({ device: { status: 'offline' } });
    const secondOutcome = await second;
    expect(secondOutcome).toBeInstanceOf(DeviceLifecycleError);
    expect(secondOutcome).toMatchObject({
      code: 'DEVICE_LIMIT_REACHED',
      details: { currentDevices: 2, maxDevices: 2 },
    });
    expect(await statusOf(a)).toBe('offline');
    expect(await statusOf(b)).toBe('decommissioned');
  });

  runDb('two restores of the SAME device: the loser is told it is no longer removed, not "limit reached"', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedDevice(env.organization.id, env.site.id, 'online');
    const device = await seedDevice(env.organization.id, env.site.id, 'decommissioned');
    await setDeviceLimit(env.partner.id, 2);
    const pin = { orgId: env.organization.id, siteId: env.site.id };

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstRestored!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => { firstRestored = resolve; });
    let secondPid: number | undefined;

    const first = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const result = await restoreRemovedDevice(tx, device, pin);
      firstRestored();
      await holdFirst;
      return result;
    }));
    await firstHoldsLock;

    const second = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const [pidRow] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
      secondPid = pidRow!.pid;
      return restoreRemovedDevice(tx, device, pin);
    })).then(
      () => 'restored' as const,
      (err: unknown) => err,
    );
    while (secondPid === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await waitForBlockedBackend(secondPid);
    releaseFirst();

    await expect(first).resolves.toMatchObject({ device: { status: 'offline' } });
    const secondOutcome = await second;
    expect(secondOutcome).toBeInstanceOf(DeviceLifecycleError);
    expect(secondOutcome).toMatchObject({ code: 'NOT_REMOVED' });
    expect(await statusOf(device)).toBe('offline');
  });
});
