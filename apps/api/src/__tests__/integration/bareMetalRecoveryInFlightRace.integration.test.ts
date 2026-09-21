// Regression coverage for #6322: `createBareMetalRecovery` used SELECT-then-
// INSERT to enforce "one non-terminal bare-metal recovery per device", which
// two concurrent creators could both pass. The fix added a partial unique
// index (`bare_metal_recoveries_device_in_flight_idx`, migration
// 2026-10-25-120000-bare-metal-recoveries-in-flight-unique.sql) that the
// database enforces as the real arbiter, with the loser's 23505 mapped to
// `BareMetalRecoveryError('recovery_in_progress', 409, ...)`.
import './setup';

import { and, eq, notInArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import {
  BARE_METAL_RECOVERY_TERMINAL,
  backupConfigs,
  backupJobs,
  backupSnapshots,
  bareMetalRecoveries,
  devices,
} from '../../db/schema';
import {
  BareMetalRecoveryError,
  createBareMetalRecovery,
} from '../../services/bareMetalRecoveryService';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('createBareMetalRecovery in-flight race against real PostgreSQL (#6322)', () => {
  async function seedRestorableDevice(orgId: string, siteId: string, sfx: string) {
    const testDb = getTestDb();
    const [device] = await testDb.insert(devices).values({
      orgId,
      siteId,
      agentId: `bmr-race-${sfx}`,
      hostname: `bmr-race-${sfx}`,
      osType: 'linux',
      osVersion: '24.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
    }).returning({ id: devices.id });
    if (!device) throw new Error('device fixture insert failed');

    const [cfg] = await testDb.insert(backupConfigs).values({
      orgId,
      name: `bmr-race-${sfx}`,
      type: 'file',
      provider: 'local',
      providerConfig: {},
    }).returning({ id: backupConfigs.id });
    if (!cfg) throw new Error('backupConfigs fixture insert failed');

    const [job] = await testDb.insert(backupJobs).values({
      orgId,
      configId: cfg.id,
      deviceId: device.id,
      status: 'completed',
    }).returning({ id: backupJobs.id });
    if (!job) throw new Error('backupJobs fixture insert failed');

    const [snapshot] = await testDb.insert(backupSnapshots).values({
      orgId,
      jobId: job.id,
      deviceId: device.id,
      snapshotId: `snap-${sfx}`,
      timestamp: new Date(),
      bareMetalRestorable: true,
    }).returning({ id: backupSnapshots.id });
    if (!snapshot) throw new Error('backupSnapshots fixture insert failed');

    return { deviceId: device.id, snapshotId: snapshot.id };
  }

  async function countNonTerminalRecoveries(orgId: string, deviceId: string): Promise<number> {
    const testDb = getTestDb();
    const rows = await testDb
      .select({ id: bareMetalRecoveries.id })
      .from(bareMetalRecoveries)
      .where(
        and(
          eq(bareMetalRecoveries.orgId, orgId),
          eq(bareMetalRecoveries.deviceId, deviceId),
          notInArray(bareMetalRecoveries.status, [...BARE_METAL_RECOVERY_TERMINAL]),
        ),
      );
    return rows.length;
  }

  runDb('two concurrent creates for one device yield exactly one recovery and one recovery_in_progress 409', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const sfx = crypto.randomUUID().slice(0, 8);
    const { deviceId, snapshotId } = await seedRestorableDevice(org.id, site.id, sfx);

    const create = () => withSystemDbAccessContext(() => createBareMetalRecovery({
      orgId: org.id,
      snapshotId,
      identity: 'original',
      createdBy: null,
      source: 'route',
    }));

    const outcomes = await Promise.allSettled([create(), create()]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0];
    if (rejection?.status !== 'rejected') throw new Error('expected a rejected outcome');
    const error = rejection.reason;
    expect(error).toBeInstanceOf(BareMetalRecoveryError);
    expect((error as BareMetalRecoveryError).code).toBe('recovery_in_progress');
    expect((error as BareMetalRecoveryError).status).toBe(409);

    const nonTerminalCount = await countNonTerminalRecoveries(org.id, deviceId);
    expect(nonTerminalCount).toBe(1);
  });

  runDb('a new recovery is allowed once the previous one is terminal', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const sfx = crypto.randomUUID().slice(0, 8);
    const { deviceId, snapshotId } = await seedRestorableDevice(org.id, site.id, sfx);

    const { row: first } = await withSystemDbAccessContext(() => createBareMetalRecovery({
      orgId: org.id,
      snapshotId,
      identity: 'original',
      createdBy: null,
      source: 'route',
    }));

    const testDb = getTestDb();
    await testDb
      .update(bareMetalRecoveries)
      .set({ status: 'completed' })
      .where(and(eq(bareMetalRecoveries.id, first.id), eq(bareMetalRecoveries.orgId, org.id)));

    const { row: second } = await withSystemDbAccessContext(() => createBareMetalRecovery({
      orgId: org.id,
      snapshotId,
      identity: 'original',
      createdBy: null,
      source: 'route',
    }));

    expect(second.id).not.toBe(first.id);
    expect(second.deviceId).toBe(deviceId);

    const nonTerminalCount = await countNonTerminalRecoveries(org.id, deviceId);
    expect(nonTerminalCount).toBe(1);
  });

  runDb('a second device in the same org is unaffected by another device\'s in-flight recovery', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const sfxA = crypto.randomUUID().slice(0, 8);
    const sfxB = crypto.randomUUID().slice(0, 8);
    const deviceA = await seedRestorableDevice(org.id, site.id, sfxA);
    const deviceB = await seedRestorableDevice(org.id, site.id, sfxB);

    await withSystemDbAccessContext(() => createBareMetalRecovery({
      orgId: org.id,
      snapshotId: deviceA.snapshotId,
      identity: 'original',
      createdBy: null,
      source: 'route',
    }));

    const { row: recoveryB } = await withSystemDbAccessContext(() => createBareMetalRecovery({
      orgId: org.id,
      snapshotId: deviceB.snapshotId,
      identity: 'original',
      createdBy: null,
      source: 'route',
    }));

    expect(recoveryB.deviceId).toBe(deviceB.deviceId);

    const testDb = getTestDb();
    const rows = await testDb.execute(sql`
      select device_id from bare_metal_recoveries
      where org_id = ${org.id}
        and device_id in (${deviceA.deviceId}, ${deviceB.deviceId})
        and status not in ('checked_in', 'completed', 'failed', 'refused')
    `);
    expect(rows).toHaveLength(2);
  });
});
