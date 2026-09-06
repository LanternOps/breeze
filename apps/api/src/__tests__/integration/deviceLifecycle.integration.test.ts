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

});
