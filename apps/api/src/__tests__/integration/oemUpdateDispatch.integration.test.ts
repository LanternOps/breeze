/**
 * The vendor update seam end to end against real PostgreSQL (#11065 W03): the
 * row the seam writes, the claim-time recheck on both sides of a `sent` flip,
 * the one-run-per-device lock, result handling, verification and the
 * not-returned monitor, all as `breeze_app` under the real RLS and CHECKs.
 *
 * Gates are closed in code at this wave, so the lab override opens them for the
 * seeded device: that is the same path a lab wave uses.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  devices,
} from '../../db/schema';
import { claimPendingCommandForDelivery } from '../../services/commandDispatch';
import { dispatchOemUpdateRun, type OemDispatchInput } from '../../services/oemUpdates/dispatch';
import { applyOemUpdateResult, applyOemUpdateVerification } from '../../services/oemUpdates/results';
import { runOemUpdatesTick } from '../../jobs/oemUpdatesWorker';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const HOUR = 60 * 60 * 1000;

async function seed(overrides: Partial<typeof devices.$inferInsert> = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `oem-${randomUUID()}`,
    hostname: 'oem-host',
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '0.127.0',
    status: 'online',
    ...overrides,
  }).returning({ id: devices.id });
  await getTestDb().insert(deviceHardware).values({
    deviceId: device!.id,
    orgId: org.id,
    manufacturer: 'Dell Inc.',
    model: 'Latitude 7420',
    biosVersion: '1.20.0',
  });
  vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', device!.id);
  return { partner, org, deviceId: device!.id };
}

function runInput(deviceId: string, orgId: string, overrides: Partial<OemDispatchInput> = {}): OemDispatchInput {
  return {
    deviceId,
    expectedOrgId: orgId,
    trigger: 'on_demand',
    requestedCategories: ['driver'],
    blockedUpdateIds: [],
    rebootControlled: true,
    notAfter: new Date(Date.now() + HOUR),
    occurrenceKey: null,
    actorUserId: null,
    ...overrides,
  };
}

async function commandRows(deviceId: string) {
  return withSystemDbAccessContext(() => db.select().from(deviceCommands).where(and(
    eq(deviceCommands.deviceId, deviceId),
    eq(deviceCommands.type, 'oem_update_run'),
  )));
}

async function statusRow(deviceId: string) {
  const [row] = await withSystemDbAccessContext(() => db.select().from(deviceOemUpdateStatus)
    .where(eq(deviceOemUpdateStatus.deviceId, deviceId)));
  return row;
}

const goodResult = {
  lane: 'dell',
  outcome: 'success',
  toolVersion: '5.7.2',
  rawExitCode: 0,
  errorCode: null,
  rebootRequired: false,
  shutdownRequired: false,
  items: [{ title: 'Driver A', category: 'driver', version: '1.0', result: 'installed' }],
  skippedCategories: [],
  takeover: 'not_attempted',
};

describe('vendor update seam against real PostgreSQL', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  runDb('queues one row with submitted_org_id and deliver_by, and writes the status row', async () => {
    const { org, deviceId } = await seed();
    const notAfter = new Date(Date.now() + HOUR);

    const res = await dispatchOemUpdateRun(runInput(deviceId, org.id, { notAfter, occurrenceKey: '2027-01' }));

    expect(res).toMatchObject({ ok: true, categories: ['driver'] });
    const [row] = await commandRows(deviceId);
    expect(row!.submittedOrgId).toBe(org.id);
    expect(Math.abs(row!.deliverBy!.getTime() - notAfter.getTime())).toBeLessThan(5000);
    expect(row!.payload).toMatchObject({ lane: 'dell', categories: ['driver'], tool: null, occurrenceKey: '2027-01' });

    const status = await statusRow(deviceId);
    expect(status).toMatchObject({
      orgId: org.id,
      lane: 'dell',
      applicability: 'applicable',
      lastCommandId: row!.id,
      occurrenceKey: '2027-01',
      returnDeadlineAt: null,
    });
  });

  runDb('refuses at the seam with the flag off, and queues nothing', async () => {
    const { org, deviceId } = await seed();
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    await expect(dispatchOemUpdateRun(runInput(deviceId, org.id))).resolves.toEqual({ ok: false, refusal: 'flag_off' });
    expect(await commandRows(deviceId)).toEqual([]);
  });

  runDb('closed gates reach nothing without the lab override', async () => {
    const { org, deviceId } = await seed();
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', '');
    await expect(dispatchOemUpdateRun(runInput(deviceId, org.id))).resolves.toEqual({ ok: false, refusal: 'lane_closed' });
    expect(await commandRows(deviceId)).toEqual([]);
  });

  runDb('a device that moved since the decision receives nothing', async () => {
    const { deviceId } = await seed();
    const other = await createOrganization({ partnerId: (await createPartner()).id });
    await expect(dispatchOemUpdateRun(runInput(deviceId, other.id))).resolves.toEqual({ ok: false, refusal: 'device_not_found' });
    expect(await commandRows(deviceId)).toEqual([]);
  });

  runDb('concurrent dispatches leave exactly one run', async () => {
    const { org, deviceId } = await seed();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => dispatchOemUpdateRun(runInput(deviceId, org.id))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.refusal === 'run_in_flight')).toBe(true);
    expect(await commandRows(deviceId)).toHaveLength(1);
  });

  describe('the claim', () => {
    runDb('an unclaimed run is cancelled when its lane kill switch comes on', async () => {
      const { org, deviceId } = await seed();
      const res = await dispatchOemUpdateRun(runInput(deviceId, org.id));
      const commandId = res.ok ? res.commandId : '';

      vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell');
      await expect(claimPendingCommandForDelivery(commandId)).resolves.toMatchObject({
        status: 'cancelled',
        reason: 'scope_changed',
      });
      const [row] = await commandRows(deviceId);
      expect(row!.status).toBe('cancelled');
    });

    runDb('an unclaimed run is cancelled when its gate has closed', async () => {
      const { org, deviceId } = await seed();
      const res = await dispatchOemUpdateRun(runInput(deviceId, org.id));
      const commandId = res.ok ? res.commandId : '';

      vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', '');
      await expect(claimPendingCommandForDelivery(commandId)).resolves.toMatchObject({
        status: 'cancelled',
        reason: 'scope_changed',
      });
    });

    runDb('a running one is untouched', async () => {
      const { org, deviceId } = await seed();
      const res = await dispatchOemUpdateRun(runInput(deviceId, org.id));
      const commandId = res.ok ? res.commandId : '';
      await expect(claimPendingCommandForDelivery(commandId)).resolves.toMatchObject({ status: 'claimed' });

      vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell');
      await expect(claimPendingCommandForDelivery(commandId)).resolves.toMatchObject({ status: 'not_claimable' });
      const [row] = await commandRows(deviceId);
      expect(row!.status).toBe('sent');
    });

    runDb('reads the partner on the claim transaction when an allowlist is set', async () => {
      const { org, partner, deviceId } = await seed();
      vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', partner.id);
      const res = await dispatchOemUpdateRun(runInput(deviceId, org.id));
      const commandId = res.ok ? res.commandId : '';
      expect(res.ok).toBe(true);

      vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', randomUUID());
      await expect(claimPendingCommandForDelivery(commandId)).resolves.toMatchObject({
        status: 'cancelled',
        reason: 'scope_changed',
      });
    });

    runDb('stays deliverable for an allowlisted partner', async () => {
      const { org, partner, deviceId } = await seed();
      vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', partner.id);
      const res = await dispatchOemUpdateRun(runInput(deviceId, org.id));
      await expect(claimPendingCommandForDelivery(res.ok ? res.commandId : '')).resolves.toMatchObject({ status: 'claimed' });
    });

    runDb('an open run is delivered', async () => {
      const { org, deviceId } = await seed();
      const res = await dispatchOemUpdateRun(runInput(deviceId, org.id));
      await expect(claimPendingCommandForDelivery(res.ok ? res.commandId : '')).resolves.toMatchObject({ status: 'claimed' });
    });
  });

  runDb('a result lands on the status row under real CHECKs, a malformed one as result_unparseable', async () => {
    const { org, deviceId } = await seed();
    const res = await dispatchOemUpdateRun(runInput(deviceId, org.id));
    const commandId = res.ok ? res.commandId : '';

    await applyOemUpdateResult({ commandId, deviceId, result: goodResult });
    const first = await statusRow(deviceId);
    expect(first).toMatchObject({ lastOutcome: 'success', installedCount: 1, toolVersion: '5.7.2' });
    const completedAt = first!.firstCompletedAt;
    expect(completedAt).toBeInstanceOf(Date);

    await applyOemUpdateResult({ commandId, deviceId, result: { nonsense: true } });
    const second = await statusRow(deviceId);
    expect(second).toMatchObject({ lastOutcome: 'failed', lastErrorCode: 'result_unparseable' });
    expect(second!.firstCompletedAt).toEqual(completedAt);
  });

  runDb('a BIOS run arms the monitor; no check-in raises one alert in the current org; a check-in resolves it', async () => {
    const { org, partner, deviceId } = await seed();
    const res = await dispatchOemUpdateRun(runInput(deviceId, org.id, { requestedCategories: ['bios', 'driver'] }));
    const commandId = res.ok ? res.commandId : '';
    await expect(claimPendingCommandForDelivery(commandId)).resolves.toMatchObject({ status: 'claimed' });

    const armed = await statusRow(deviceId);
    expect(armed!.biosVersionBefore).toBe('1.20.0');
    expect(armed!.returnDeadlineAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);

    // The device stops checking in and is moved to another org mid-monitor.
    const startedAt = new Date(Date.now() - 25 * HOUR);
    const movedTo = await createOrganization({ partnerId: partner.id });
    const movedSite = await createSite({ orgId: movedTo.id });
    await getTestDb().update(devices).set({
      orgId: movedTo.id,
      siteId: movedSite.id,
      status: 'offline',
      lastSeenAt: new Date(startedAt.getTime() + 60_000),
    }).where(eq(devices.id, deviceId));
    await getTestDb().update(deviceCommands).set({ executedAt: startedAt }).where(eq(deviceCommands.id, commandId));
    await getTestDb().update(deviceOemUpdateStatus).set({ returnDeadlineAt: new Date(Date.now() - HOUR) })
      .where(eq(deviceOemUpdateStatus.deviceId, deviceId));

    await runOemUpdatesTick(new Date());
    await runOemUpdatesTick(new Date());

    const raised = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, deviceId));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ orgId: movedTo.id, status: 'active', severity: 'critical' });
    const alerted = await statusRow(deviceId);
    expect(alerted!.notReturnedAlertedAt).toBeInstanceOf(Date);
    expect(alerted!.orgId).toBe(movedTo.id);

    // A check-in: the last_seen moves past the alert.
    await getTestDb().update(devices).set({ status: 'online', lastSeenAt: new Date(Date.now() + 60_000) })
      .where(eq(devices.id, deviceId));
    await runOemUpdatesTick(new Date(Date.now() + 120_000));

    const [resolved] = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, deviceId));
    expect(resolved!.status).toBe('resolved');
    const cleared = await statusRow(deviceId);
    expect(cleared).toMatchObject({ returnDeadlineAt: null, notReturnedAlertedAt: null });
  });

  runDb('a driver-only run never arms', async () => {
    const { org, deviceId } = await seed();
    await dispatchOemUpdateRun(runInput(deviceId, org.id));
    const status = await statusRow(deviceId);
    expect(status).toMatchObject({ returnDeadlineAt: null, biosVersionBefore: null });
  });

  runDb('verification: suspended raises the protection alert; on resolves it', async () => {
    const { org, deviceId } = await seed();
    const res = await dispatchOemUpdateRun(runInput(deviceId, org.id, { requestedCategories: ['bios'] }));
    const commandId = res.ok ? res.commandId : '';

    await expect(applyOemUpdateVerification({
      deviceId,
      verification: { commandId, bitlockerAfter: 'suspended', biosVersionAfter: '1.21.0' },
    })).resolves.toBe(true);
    const after = await statusRow(deviceId);
    expect(after).toMatchObject({
      bitlockerAfter: 'suspended',
      biosVersionBefore: '1.20.0',
      biosVersionAfter: '1.21.0',
      returnDeadlineAt: null,
    });
    const [raised] = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, deviceId));
    expect(raised!.title).toContain('BitLocker');

    await applyOemUpdateVerification({ deviceId, verification: { commandId, bitlockerAfter: 'on', biosVersionAfter: '1.21.0' } });
    const [resolved] = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, deviceId));
    expect(resolved!.status).toBe('resolved');
  });

  runDb('concurrent first fire of a vendor update alert leaves one rule', async () => {
    const { org, deviceId } = await seed();
    const res = await dispatchOemUpdateRun(runInput(deviceId, org.id, { requestedCategories: ['bios'] }));
    const commandId = res.ok ? res.commandId : '';
    await Promise.all(Array.from({ length: 4 }, () => applyOemUpdateVerification({
      deviceId,
      verification: { commandId, bitlockerAfter: 'suspended', biosVersionAfter: null },
    })));
    const rules = await getTestDb().execute(sql`
      SELECT id FROM alert_rules WHERE org_id = ${org.id}::uuid AND override_settings->>'source' = 'oem-updates'
    `);
    expect(rules).toHaveLength(1);
  });
});
