/**
 * #2787 — device restore / permanent delete against REAL Postgres.
 *
 * The unit suite (`services/deviceLifecycle.test.ts`) drives a fake tx and can
 * therefore prove the STATEMENT ORDER but not what the database does with it.
 * Three properties live entirely in Postgres's evaluation rules and, before
 * this file, were argued in comments rather than executed:
 *
 *   - `uninstall_reasons @> ARRAY['device_remove']::text[]` against a row the
 *     Remove path actually wrote, with `device_remove_expires_at > now()`
 *     evaluated by the DATABASE clock. A refusal that misses a live uninstall
 *     is a purge that destroys the only command that will ever clean the
 *     endpoint.
 *   - the status re-check under `SELECT ... FOR UPDATE`, which is what makes
 *     a purge lose to a Restore that committed after the route's pre-flight
 *     check (the TOCTOU this wave closes).
 *   - the cascade actually completing over the ~40 real child tables, so
 *     "purge succeeded" means the row is gone rather than "no statement threw
 *     in a mock".
 *
 * Deliberately NOT `it.runIf(...)`: a skipped guard is indistinguishable from
 * a passing one in a CI log. If the database is missing these fail loudly.
 *
 * Run (note: NO `--` before the path — `pnpm ... test:integration -- <path>`
 * silently runs the whole integration suite instead of filtering):
 *   pnpm test-stack up
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceLifecycle.integration.test.ts
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { queueDeviceUninstall } from '../../services/deviceUninstallDrain';
import { purgeRemovedDevice, restoreRemovedDevice } from '../../services/deviceLifecycle';
import {
  processDeviceBulkPurgeJob,
  type DeviceBulkPurgeJobPayload,
  type DeviceBulkPurgeResult,
} from '../../jobs/deviceBulkPurge';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let deviceCounter = 0;

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  userId: string;
  userEmail: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner.id, status: 'active' });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    userId: user.id,
    userEmail: user.email,
  };
}

async function seedDevice(
  orgId: string,
  siteId: string,
  status: 'online' | 'offline' | 'decommissioned' = 'decommissioned',
): Promise<{ id: string; hostname: string }> {
  deviceCounter += 1;
  const suffix = `${Date.now()}-${deviceCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const hostname = `host-2787-${suffix}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-2787-${suffix}`,
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status,
      agentTokenHash: createHash('sha256').update(`brz_2787_${suffix}`).digest('hex'),
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: insert returned no row');
  return { id: row.id, hostname };
}

async function deviceExists(deviceId: string): Promise<boolean> {
  const rows = await getTestDb().select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  return rows.length > 0;
}

async function deviceStatus(deviceId: string): Promise<string | undefined> {
  const [row] = await getTestDb()
    .select({ status: devices.status })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row?.status;
}

/** Queue the durable `device_remove` uninstall exactly the Remove route does. */
async function queueRemoveUninstall(deviceId: string, actorUserId: string): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      const result = await queueDeviceUninstall(tx, deviceId, actorUserId);
      if (!result.queued && !result.mergedIntoExisting) {
        throw new Error('queueRemoveUninstall: nothing was queued — fixture is not exercising the guard');
      }
    }),
  );
}

// ---------------------------------------------------------------------------

describe('deviceLifecycle (integration)', () => {
  it('purge refuses while a device_remove uninstall is pending, and the device row survives', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    // Positive control on the fixture: the refusal must be caused by a row the
    // real Remove path wrote, not by an empty table making every arm vacuous.
    const queued = await getTestDb()
      .select({ id: deviceCommands.id, reasons: deviceCommands.uninstallReasons })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reasons).toContain('device_remove');

    await expect(
      withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id))),
    ).rejects.toMatchObject({ code: 'UNINSTALL_PENDING' });

    // The whole point: `device_commands` is IN the device cascade, so a purge
    // that ran here would have destroyed the uninstall as well as the device.
    expect(await deviceExists(device.id)).toBe(true);
    const stillQueued = await getTestDb()
      .select({ id: deviceCommands.id, status: deviceCommands.status })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device.id));
    expect(stillQueued).toHaveLength(1);
    expect(stillQueued[0]!.status).toBe('pending');
  });

  it('purge proceeds once the pending uninstall has been cancelled by a restore + re-remove', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    // Restore cancels the device_remove row (and clears its deadline)...
    const restored = await withSystemDbAccessContext(() =>
      db.transaction((tx) => restoreRemovedDevice(tx, device.id)),
    );
    expect(restored.uninstallAlreadyDispatched).toBe(false);
    expect(await deviceStatus(device.id)).toBe('offline');

    // ...so a Remove that leaves the agent installed, then a purge, is allowed.
    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE devices SET status = 'decommissioned' WHERE id = ${device.id}`),
    );
    await withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id)));
    expect(await deviceExists(device.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROLS on the refusal predicate.
  //
  // The refusal above only earns its keep if it is NARROW. A predicate that
  // fired on "any pending self_uninstall" would wedge permanent delete forever
  // behind an expired row, and — the incident `deviceUninstallDrain.ts`'s
  // module doc exists to prevent — behind an abuse-suspension or
  // tenant-offboarding row that this feature does not own.
  //
  // Each case differs from a genuinely-draining row in EXACTLY ONE arm, so a
  // pass here pins that arm specifically rather than "some row shape".
  // -------------------------------------------------------------------------

  it('purge PROCEEDS when the device_remove uninstall deadline has already passed', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    // Backdate ONLY the deadline. Reason, type and status still match a
    // draining row, so this isolates the `device_remove_expires_at > now()`
    // arm — and `now()` is the DATABASE clock, which is why this case cannot
    // be argued on compiled SQL.
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        UPDATE device_commands
           SET device_remove_expires_at = now() - interval '1 hour'
         WHERE device_id = ${device.id} AND type = 'self_uninstall'
      `),
    );

    // Control: the row is still pending and still carries the reason, so the
    // only thing standing between this and a refusal is the deadline.
    const [row] = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT status, uninstall_reasons FROM device_commands
         WHERE device_id = ${device.id} AND type = 'self_uninstall'
      `),
    )) as unknown as Array<{ status: string; uninstall_reasons: string[] }>;
    expect(row!.status).toBe('pending');
    expect(row!.uninstall_reasons).toContain('device_remove');

    await withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id)));
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('purge PROCEEDS when the only pending uninstall belongs to tenant offboarding', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);

    // A row that is draining in every respect EXCEPT the reason: pending, the
    // right type, and an UNEXPIRED deadline. That isolates the
    // `uninstall_reasons @> ARRAY['device_remove']` arm. A predicate keyed on
    // bare presence of a pending self_uninstall would refuse here — and would
    // also sweep up abuse-suspension rows, which is the incident
    // deviceUninstallDrain.ts was written to prevent.
    await withSystemDbAccessContext(() =>
      db.insert(deviceCommands).values({
        deviceId: device.id,
        type: 'self_uninstall',
        payload: { removeConfig: true },
        status: 'pending',
        targetRole: 'agent',
        uninstallReasons: ['tenant_offboarding'],
        deviceRemoveExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      }),
    );

    await withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id)));
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('purge racing restore: the purge that commits second loses cleanly (NOT_REMOVED)', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);

    // Restore commits first. Before #2787 the permanent-delete route had
    // already read `status = 'decommissioned'` outside its transaction and
    // never re-checked, so this device was purged anyway.
    await withSystemDbAccessContext(() => db.transaction((tx) => restoreRemovedDevice(tx, device.id)));

    await expect(
      withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id))),
    ).rejects.toMatchObject({ code: 'NOT_REMOVED' });

    expect(await deviceExists(device.id)).toBe(true);
    expect(await deviceStatus(device.id)).toBe('offline');
  });

  it('purge succeeds on a removed device with no pending uninstall and removes the row', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);

    const result = await withSystemDbAccessContext(() =>
      db.transaction((tx) => purgeRemovedDevice(tx, device.id)),
    );

    expect(result.linkGroupDissolved).toBe(false);
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('purge reports NOT_FOUND for a device id that does not exist', async () => {
    await expect(
      withSystemDbAccessContext(() =>
        db.transaction((tx) => purgeRemovedDevice(tx, '11111111-1111-4111-8111-111111111111')),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // Bulk purge worker (#2787 Task 5) — authorisation is re-derived per device
  // under the lock, so a device that MOVED ORG between the operator's confirm
  // and the worker's execution must never be deleted under the stale
  // authorisation the payload carries.
  // -------------------------------------------------------------------------
  it('bulk purge worker skips a device whose org changed after enqueue (ORG_CHANGED)', async () => {
    const tenant = await seedTenant();
    const otherOrg = await createOrganization({ partnerId: tenant.partnerId, status: 'active' });
    const moved = await seedDevice(tenant.orgId, tenant.siteId);
    const stayed = await seedDevice(tenant.orgId, tenant.siteId);

    const payload: DeviceBulkPurgeJobPayload = {
      jobId: '22222222-2222-4222-8222-222222222222',
      targets: [
        { deviceId: moved.id, orgId: tenant.orgId, hostname: moved.hostname },
        { deviceId: stayed.id, orgId: tenant.orgId, hostname: stayed.hostname },
      ],
      actorUserId: tenant.userId,
      actorEmail: tenant.userEmail,
      partnerId: tenant.partnerId,
    };

    // The move happens AFTER the payload was built — exactly the window the
    // re-check exists for. site_id goes with it: sites are org-scoped.
    const otherSite = await createSite({ orgId: otherOrg.id });
    await withSystemDbAccessContext(() =>
      db.execute(
        sql`UPDATE devices SET org_id = ${otherOrg.id}::uuid, site_id = ${otherSite.id}::uuid WHERE id = ${moved.id}`,
      ),
    );

    const progress: Array<{ done: number; total: number }> = [];
    const result = (await processDeviceBulkPurgeJob({
      name: 'device-bulk-purge',
      id: `device-bulk-purge-${payload.jobId}`,
      data: payload,
      updateProgress: async (p: unknown) => {
        progress.push(p as { done: number; total: number });
      },
    } as never)) as DeviceBulkPurgeResult;

    expect(result.skipped).toContainEqual({ deviceId: moved.id, code: 'ORG_CHANGED' });
    expect(result.purged).toEqual([stayed.id]);
    // Skipped means SKIPPED, not "deleted with a warning".
    expect(await deviceExists(moved.id)).toBe(true);
    expect(await deviceExists(stayed.id)).toBe(false);
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it('bulk purge worker skips a device whose uninstall is still pending', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    const result = (await processDeviceBulkPurgeJob({
      name: 'device-bulk-purge',
      id: 'device-bulk-purge-33333333-3333-4333-8333-333333333333',
      data: {
        jobId: '33333333-3333-4333-8333-333333333333',
        targets: [{ deviceId: device.id, orgId: tenant.orgId, hostname: device.hostname }],
        actorUserId: tenant.userId,
        actorEmail: tenant.userEmail,
        partnerId: tenant.partnerId,
      } satisfies DeviceBulkPurgeJobPayload,
      updateProgress: async () => {},
    } as never)) as DeviceBulkPurgeResult;

    expect(result.purged).toEqual([]);
    expect(result.skipped).toEqual([{ deviceId: device.id, code: 'UNINSTALL_PENDING' }]);
    expect(await deviceExists(device.id)).toBe(true);
  });
});
