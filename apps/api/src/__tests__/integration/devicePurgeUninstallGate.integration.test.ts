/**
 * #11153 — the confirmed-uninstall gate against REAL Postgres.
 *
 * The unit suites script the state string, so they prove what each door does
 * WITH a state and nothing about how the state is computed. That computation
 * is one SQL expression (`purgeUninstallStateSql`) over `device_commands`,
 * `device_reattachments` and the `devices` row, with `now()`, `@>` and a
 * correlated `ORDER BY ... LIMIT 1` — all of it database behaviour. Each case
 * here writes the row shape the real writers produce and reads the state back
 * through the real purge.
 *
 * Deliberately NOT `it.runIf(...)`: a skipped guard is indistinguishable from
 * a passing one in a CI log.
 *
 * Run (NO `--` before the path):
 *   pnpm test-stack up
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/devicePurgeUninstallGate.integration.test.ts
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  deviceReattachments,
  devices,
} from '../../db/schema';
import { DeviceLifecycleError, purgeRemovedDevice } from '../../services/deviceLifecycle';
import { queueDeviceUninstall, releaseDeviceRemoveReason } from '../../services/deviceUninstallDrain';
import { readPurgeUninstallState } from '../../services/devicePurgeUninstallGate';
import { processDeviceBulkPurgeJob, type DeviceBulkPurgeResult } from '../../jobs/deviceBulkPurge';
import { runRemovedDevicePurgeOnce } from '../../jobs/removedDevicePurge';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

async function seedTenant() {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner!.id, status: 'active' });
  const site = await createSite({ orgId: org!.id });
  const user = await createUser({ partnerId: partner!.id, orgId: org!.id });
  return { partnerId: partner!.id, orgId: org!.id, siteId: site!.id, userId: user!.id };
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

async function seedRemovedDevice(
  tenant: Tenant,
  overrides: Partial<typeof devices.$inferInsert> = {},
): Promise<{ id: string; agentId: string; hostname: string }> {
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const agentId = `gate-agent-${unique}`;
  const hostname = `gate-host-${unique}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId: tenant.orgId,
      siteId: tenant.siteId,
      agentId,
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'decommissioned',
      decommissionedAt: new Date(),
      agentTokenHash: createHash('sha256').update(`brz_gate_${unique}`).digest('hex'),
      enrolledAt: new Date(),
      ...overrides,
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedRemovedDevice: insert returned no row');
  return { id: row.id, agentId, hostname };
}

async function seedUninstall(
  deviceId: string,
  overrides: Partial<typeof deviceCommands.$inferInsert> = {},
): Promise<void> {
  await getTestDb().insert(deviceCommands).values({
    deviceId,
    type: 'self_uninstall',
    payload: { removeConfig: true },
    status: 'completed',
    targetRole: 'agent',
    uninstallReasons: ['device_remove'],
    deviceRemoveExpiresAt: new Date(Date.now() + 72 * HOUR_MS),
    completedAt: new Date(),
    ...overrides,
  });
}

const stateOf = (deviceId: string) =>
  withSystemDbAccessContext(() => db.transaction((tx) => readPurgeUninstallState(tx, deviceId)));

const purge = (deviceId: string, force?: boolean) =>
  withSystemDbAccessContext(() =>
    db.transaction((tx) => purgeRemovedDevice(tx, deviceId, undefined, force === undefined ? {} : { force })),
  );

async function deviceExists(deviceId: string): Promise<boolean> {
  const rows = await getTestDb().select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  return rows.length > 0;
}

describe('purge uninstall state (#11153)', () => {
  it('completed: a completed device_remove uninstall purges', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedUninstall(device.id);

    const result = await purge(device.id);

    expect(result).toMatchObject({ uninstallState: 'completed', forced: false });
    expect(await deviceExists(device.id)).toBe(false);
  });

  it.each([
    ['failed', { status: 'failed', result: { status: 'failed', error: 'boom' } }],
    // staleCommandReaper lands a drain-window expiry as failed + timeout.
    ['expired', { status: 'failed', result: { status: 'timeout' } }],
    ['cancelled', { status: 'cancelled', result: { status: 'cancelled' } }],
    // An unrecognised status is the reading that does not claim the agent came off.
    ['failed', { status: 'mystery', result: null }],
  ] as const)('%s: refuses with UNINSTALL_NOT_CONFIRMED and the device survives', async (state, row) => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedUninstall(device.id, { ...row, completedAt: null } as never);

    const err = await purge(device.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeviceLifecycleError);
    expect(err).toMatchObject({ code: 'UNINSTALL_NOT_CONFIRMED', status: 409, details: { uninstallState: state } });
    expect(await deviceExists(device.id)).toBe(true);
  });

  it('expired: a pending row past its deadline (not yet reaped) reads as expired on the DB clock', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedUninstall(device.id, {
      status: 'pending',
      completedAt: null,
      deviceRemoveExpiresAt: new Date(Date.now() - HOUR_MS),
    });

    await expect(purge(device.id)).rejects.toMatchObject({
      code: 'UNINSTALL_NOT_CONFIRMED',
      details: { uninstallState: 'expired' },
    });
  });

  it('none: no uninstall row at all ("leave the agent installed") is refused', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);

    await expect(purge(device.id)).rejects.toMatchObject({
      code: 'UNINSTALL_NOT_CONFIRMED',
      details: { uninstallState: 'none' },
    });
    expect(await deviceExists(device.id)).toBe(true);
  });

  it('none: another owner\'s pending row is not this removal, and does not read as pending', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedUninstall(device.id, {
      status: 'pending',
      completedAt: null,
      uninstallReasons: ['tenant_offboarding'],
    });

    await expect(purge(device.id)).rejects.toMatchObject({
      code: 'UNINSTALL_NOT_CONFIRMED',
      details: { uninstallState: 'none' },
    });
  });

  it('none: a restore releases the row, so a later "leave installed" Remove starts clean', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        await queueDeviceUninstall(tx, device.id, tenant.userId);
        await releaseDeviceRemoveReason(tx, device.id, 'device_restored');
      }),
    );

    expect(await stateOf(device.id)).toBe('none');
  });

  it('UNINSTALL_PENDING still wins, and force does not override it', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await withSystemDbAccessContext(() =>
      db.transaction((tx) => queueDeviceUninstall(tx, device.id, tenant.userId)),
    );

    await expect(purge(device.id, true)).rejects.toMatchObject({ code: 'UNINSTALL_PENDING' });
    expect(await deviceExists(device.id)).toBe(true);
  });

  it('latest wins: a newer failed uninstall outranks an older completed one', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedUninstall(device.id, { createdAt: new Date(Date.now() - 2 * DAY_MS) });
    await seedUninstall(device.id, { status: 'failed', completedAt: null, createdAt: new Date(Date.now() - DAY_MS) });

    expect(await stateOf(device.id)).toBe('failed');
  });

  it('latest wins: a newer completed uninstall outranks an older failed one', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedUninstall(device.id, { status: 'failed', completedAt: null, createdAt: new Date(Date.now() - 2 * DAY_MS) });
    await seedUninstall(device.id, { createdAt: new Date(Date.now() - DAY_MS) });

    expect(await stateOf(device.id)).toBe('completed');
  });

  it('completed: another owner\'s completed uninstall still counts — the agent tore down', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedUninstall(device.id, { uninstallReasons: ['tenant_offboarding'] });

    expect(await stateOf(device.id)).toBe('completed');
  });

  it('agent_returned: an agent seen well after the completed uninstall is not confirmed gone', async () => {
    const tenant = await seedTenant();
    const completedAt = new Date(Date.now() - 2 * DAY_MS);
    const device = await seedRemovedDevice(tenant, { lastSeenAt: new Date(Date.now() - DAY_MS) });
    await seedUninstall(device.id, { completedAt });

    await expect(purge(device.id)).rejects.toMatchObject({
      code: 'UNINSTALL_NOT_CONFIRMED',
      details: { uninstallState: 'agent_returned' },
    });
  });

  it('completed: a beat just after the ack (inside the grace) is the same agent, not a reinstall', async () => {
    const tenant = await seedTenant();
    const completedAt = new Date(Date.now() - DAY_MS);
    const device = await seedRemovedDevice(tenant, { lastSeenAt: new Date(completedAt.getTime() + 60_000) });
    await seedUninstall(device.id, { completedAt });

    expect(await stateOf(device.id)).toBe('completed');
  });

  it('agent_returned: a completion with no timestamp fails closed once the agent has been seen', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant, { lastSeenAt: new Date(Date.now() - DAY_MS) });
    await seedUninstall(device.id, { completedAt: null });

    expect(await stateOf(device.id)).toBe('agent_returned');
  });

  it('ephemeral outranks a failed uninstall row (the carve-out comes first)', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant, { isEphemeral: true });
    await seedUninstall(device.id, { status: 'failed', completedAt: null });

    expect(await stateOf(device.id)).toBe('ephemeral');
  });

  it('agent_reported_uninstall: the installer told us and the agent has been silent since', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant, {
      lastSeenAt: new Date(Date.now() - 2 * DAY_MS),
      uninstallIntentAt: new Date(Date.now() - DAY_MS),
    });

    const result = await purge(device.id);

    expect(result).toMatchObject({ uninstallState: 'agent_reported_uninstall', forced: false });
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('agent_reported_uninstall outranks the queued uninstall that could never be collected', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant, {
      lastSeenAt: new Date(Date.now() - 3 * DAY_MS),
      uninstallIntentAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await seedUninstall(device.id, { status: 'failed', completedAt: null, result: { status: 'timeout' } });

    expect(await stateOf(device.id)).toBe('agent_reported_uninstall');
  });

  it('none: an uninstall intent followed by more check-ins is not an uninstall', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant, {
      uninstallIntentAt: new Date(Date.now() - 2 * DAY_MS),
      lastSeenAt: new Date(Date.now() - DAY_MS),
    });

    expect(await stateOf(device.id)).toBe('none');
  });

  async function seedReattachLedger(tenant: Tenant, sourceDeviceId: string, sourceAgentId: string) {
    const unique = randomUUID();
    await getTestDb().insert(deviceReattachments).values({
      partnerId: tenant.partnerId,
      intentId: randomUUID(),
      sourceDeviceId,
      sourceAgentId,
      sourceOrgId: tenant.orgId,
      sourceParked: false,
      targetDeviceId: randomUUID(),
      targetOrgId: tenant.orgId,
      targetSiteId: tenant.siteId,
      targetPreviousAgentId: `prev-${unique.slice(0, 8)}`,
      stagedAgentId: `staged-${unique.slice(0, 8)}`,
      targetPreviousIncarnation: 1,
      targetNewIncarnation: 2,
      actorUserId: tenant.userId,
      evidenceLevel: 'hint',
      confirmationTokenHash: createHash('sha256').update(unique).digest('hex'),
    });
  }

  it('reattached: the source of a confirmed reattach purges with no uninstall row', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant, { agentTokenHash: null });
    await seedReattachLedger(tenant, device.id, device.agentId);

    const result = await purge(device.id);

    expect(result).toMatchObject({ uninstallState: 'reattached', forced: false });
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('none: a record later re-targeted has a new agent id, so the old ledger row does not apply', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant);
    await seedReattachLedger(tenant, device.id, 'the-agent-that-moved-away');

    expect(await stateOf(device.id)).toBe('none');
  });

  it('ephemeral: a Quick Support device purges with no uninstall row', async () => {
    const tenant = await seedTenant();
    const device = await seedRemovedDevice(tenant, { isEphemeral: true });

    expect(await purge(device.id)).toMatchObject({ uninstallState: 'ephemeral', forced: false });
  });

  it('force purges each unconfirmed state and reports it', async () => {
    const tenant = await seedTenant();
    const failed = await seedRemovedDevice(tenant);
    await seedUninstall(failed.id, { status: 'failed', completedAt: null });
    const none = await seedRemovedDevice(tenant);

    expect(await purge(failed.id, true)).toMatchObject({ uninstallState: 'failed', forced: true });
    expect(await purge(none.id, true)).toMatchObject({ uninstallState: 'none', forced: true });
    expect(await deviceExists(failed.id)).toBe(false);
    expect(await deviceExists(none.id)).toBe(false);
  });

  it('a read for a missing device is none, never confirmed', async () => {
    expect(await stateOf('11111111-1111-4111-8111-111111111111')).toBe('none');
  });
});

describe('bulk purge worker door (#11153)', () => {
  it('skips an unconfirmed device, purges the confirmed one, and audits the state', async () => {
    const tenant = await seedTenant();
    const unconfirmed = await seedRemovedDevice(tenant);
    const confirmed = await seedRemovedDevice(tenant);
    await seedUninstall(confirmed.id);
    const jobId = randomUUID();

    const result = (await processDeviceBulkPurgeJob({
      name: 'device-bulk-purge-v2',
      id: `device-bulk-purge-v2-${jobId}`,
      data: {
        jobId,
        targets: [unconfirmed, confirmed].map((d) => ({ deviceId: d.id, orgId: tenant.orgId, hostname: d.hostname })),
        authorization: { version: 1, siteAccess: { mode: 'unrestricted' } },
        actorUserId: tenant.userId,
        partnerId: tenant.partnerId,
      },
      updateProgress: async () => undefined,
    } as never)) as DeviceBulkPurgeResult;

    expect(result.purged).toEqual([confirmed.id]);
    expect(result.skipped).toEqual([{ deviceId: unconfirmed.id, code: 'UNINSTALL_NOT_CONFIRMED' }]);
    expect(await deviceExists(unconfirmed.id)).toBe(true);

    const [audit] = await getTestDb()
      .select({ details: auditLogs.details })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, confirmed.id));
    expect(audit?.details).toMatchObject({ bulk: true, force: false, uninstallState: 'completed' });
  });
});

describe('retention purge door (#11153)', () => {
  /** A device_lifecycle policy assigned to the org, with a 7-day window. */
  async function seedPolicy(tenant: Tenant): Promise<string> {
    const [policy] = await getTestDb()
      .insert(configurationPolicies)
      .values({ orgId: tenant.orgId, name: `gate-${randomUUID().slice(0, 8)}`, status: 'active' })
      .returning({ id: configurationPolicies.id });
    if (!policy) throw new Error('seedPolicy: no policy row');
    await getTestDb().insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id,
      featureType: 'device_lifecycle',
      inlineSettings: { purgeRemovedAfterDays: 7 },
    } as never);
    await getTestDb().insert(configPolicyAssignments).values({
      configPolicyId: policy.id,
      level: 'organization',
      targetId: tenant.orgId,
      priority: 0,
    } as never);
    return policy.id;
  }

  /** Other tests' orgs have no policy, so the global sweep leaves them alone. */
  async function cleanup(policyId: string, deviceIds: string[]) {
    await withSystemDbAccessContext(async () => {
      for (const id of deviceIds) {
        await db.delete(deviceCommands).where(eq(deviceCommands.deviceId, id));
        await db.delete(devices).where(eq(devices.id, id));
      }
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, policyId));
    });
  }

  it('skips and counts an unconfirmed device WITHOUT blocking the newer confirmed one behind it', async () => {
    const tenant = await seedTenant();
    const policyId = await seedPolicy(tenant);
    // Older, so an oldest-first capped list would reach it first every night.
    const unconfirmed = await seedRemovedDevice(tenant, {
      decommissionedAt: new Date(Date.now() - 60 * DAY_MS),
    });
    const expired = await seedRemovedDevice(tenant, {
      decommissionedAt: new Date(Date.now() - 50 * DAY_MS),
    });
    await seedUninstall(expired.id, { status: 'failed', completedAt: null, result: { status: 'timeout' } });
    const confirmed = await seedRemovedDevice(tenant, {
      decommissionedAt: new Date(Date.now() - 30 * DAY_MS),
    });
    await seedUninstall(confirmed.id);
    const insideWindow = await seedRemovedDevice(tenant, {
      decommissionedAt: new Date(Date.now() - DAY_MS),
    });

    try {
      const summary = await runRemovedDevicePurgeOnce();

      expect(await deviceExists(confirmed.id)).toBe(false);
      expect(await deviceExists(unconfirmed.id)).toBe(true);
      expect(await deviceExists(expired.id)).toBe(true);
      expect(await deviceExists(insideWindow.id)).toBe(true);
      expect(summary.purged).toBeGreaterThanOrEqual(1);
      // Inside-window devices are not part of this count: it is past-window only.
      expect(summary.skippedUninstallNotConfirmed).toBe(2);

      const [audit] = await getTestDb()
        .select({ details: auditLogs.details })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, confirmed.id));
      expect(audit?.details).toMatchObject({ retentionPolicy: true, force: false, uninstallState: 'completed' });
    } finally {
      await cleanup(policyId, [unconfirmed.id, expired.id, insideWindow.id]);
    }
  });
});
