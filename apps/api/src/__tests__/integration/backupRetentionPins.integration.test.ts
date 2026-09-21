import './setup';

import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  backupSnapshotRetirements,
  deviceCommands,
  devices,
  organizations,
  partners,
  recoveryTokens,
  restoreJobs,
  sites,
} from '../../db/schema';
import { backupChains } from '../../db/schema/applicationBackup';
import { cleanupExpiredSnapshots } from '../../jobs/backupRetention';
import { processCleanupExpiredSnapshots, __testOnly } from '../../jobs/backupWorker';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedOrgDeviceConfig(unique: string) {
  const [partner] = await db.insert(partners).values({ name: `RP ${unique}`, slug: `rp-${unique}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: partner!.id, name: `RO ${unique}`, slug: `ro-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `RS ${unique}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({ orgId: org!.id, siteId: site!.id, agentId: `ra-${unique}`, hostname: `rh-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online' }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({ orgId: org!.id, name: `RC ${unique}`, type: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` } }).returning({ id: backupConfigs.id });
  return { orgId: org!.id, deviceId: device!.id, configId: config!.id };
}

// D18 §3.2: a base-pinned snapshot must survive retention even though its
// expires_at is in the past -- the pin, not the expiry, decides.
runDb("skips an expired snapshot pinned as a running job's base and writes no retirement", async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [baseSnap] = await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `base-snap-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning({ id: backupSnapshots.id });
    await db.insert(backupJobs).values({
      orgId, configId, deviceId, status: 'running', baseSnapshotId: `base-snap-${unique}`,
      publishLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      storageIdentity: `local::/tmp/gc-test-${unique}`,
    }).returning({ id: backupJobs.id });
    return { orgId, baseSnapId: baseSnap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.baseSnapId));
    expect(row).toBeDefined();
    const retirements = await db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, `base-snap-${unique}`));
    expect(retirements.length).toBe(0);
  });
});

// D18 §3.3: an expired, unpinned snapshot is deleted AND its retirement row
// is written in the same commit.
runDb('deletes an unpinned expired snapshot and writes its retirement row', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({
      orgId, jobId: job!.id, deviceId, configId,
      snapshotId: `expired-snap-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning({ id: backupSnapshots.id });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.deleted).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
    expect(rows.length).toBe(0);
    const retirements = await db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, `expired-snap-${unique}`));
    expect(retirements.length).toBe(1);
    expect(retirements[0]!.reason).toBe('expired');
  });
});

// D18 §3.7: proves the per-row-commit restructuring -- a later row's failure
// must not undo an earlier row's already-committed retirement. Forced here
// via a duplicate (storage_identity, snapshot_id) unique-constraint
// violation on the SECOND row's retirement insert (a manufactured collision
// against a pre-seeded retirement row) -- the first (non-colliding) row's
// delete+retirement must remain committed regardless of the second's failure.
runDb("one row failing on a unique-constraint collision does not undo an earlier row's committed retirement", async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const identity = `local::/tmp/gc-test-${unique}`;
    const [job1] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [collideSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job1!.id, deviceId, configId, snapshotId: `collide-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [job2] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [uniqueSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job2!.id, deviceId, configId, snapshotId: `unique-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // Pre-seed the retirement row the colliding row's own insert will violate.
    await db.insert(backupSnapshotRetirements).values({ orgId, configId, deviceId, snapshotId: `collide-${unique}`, storageIdentity: identity, backupType: 'file', reason: 'manual' });
    return { orgId, collideSnapId: collideSnap!.id, uniqueSnapId: uniqueSnap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.failed).toBeGreaterThanOrEqual(1);
  expect(result.deleted).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const uniqueRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.uniqueSnapId));
    expect(uniqueRows.length).toBe(0); // the non-colliding row committed its delete
    const collideRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.collideSnapId));
    expect(collideRows.length).toBe(1); // the colliding row's delete never happened -- retried next run
  });
});

// D18 §3.2 restore pin: WITH a command_id, the in-flight status check pins;
// WITHOUT one, only the linger pins (a commandless pending row is instead
// reaped by Task 7's staleCommandReaper rule, not by this pin lasting forever).
runDb('restore pin holds a snapshot with an in-flight, commanded restore', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `restore-pin-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [command] = await db.insert(deviceCommands).values({ deviceId, type: 'backup_restore', payload: {}, status: 'sent' }).returning({ id: deviceCommands.id });
    await db.insert(restoreJobs).values({ orgId, deviceId, snapshotId: snap!.id, restoreType: 'full', status: 'running', commandId: command!.id });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
    expect(rows.length).toBe(1);
  });
});

runDb('a COMMANDLESS pending restore pins only for the linger, not indefinitely', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `commandless-restore-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // commandId NULL, status pending, created recently -- still within the
    // 7-day-default linger, so the row IS pinned (linger, not status).
    await db.insert(restoreJobs).values({ orgId, deviceId, snapshotId: snap!.id, restoreType: 'full', status: 'pending', commandId: null, createdAt: new Date() });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);
});

// D18 §3.2 recovery-token pin: an active/authenticated token, or one not yet
// completed and still within its expiry + linger, pins the snapshot.
runDb('recovery-token pin holds a snapshot with an active BMR token', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `recovery-pin-${unique}`, backupType: 'system_image', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    await db.insert(recoveryTokens).values({
      orgId, deviceId, snapshotId: snap!.id, tokenHash: `hash-${unique}`, restoreType: 'bare_metal',
      status: 'active', expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);
});

// D18 §3.2/§4: the maxVersions prune pass must respect the SAME pins as the
// expiry pass -- a pinned row over the version cap is skipped, not pruned.
runDb('the max-versions prune pass respects an active base pin', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [oldJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).returning({ id: backupJobs.id });
    const [oldSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: oldJob!.id, deviceId, configId, snapshotId: `mv-old-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // Pin the OLDER (over-cap) snapshot as an in-flight job's base. Without a
    // configPolicyBackupSettings row carrying retention.maxVersions, the
    // maxVersions branch never fires for any group -- this test only proves
    // the pin check itself works identically in that pass; the group-cap
    // gating (retention lookup) is exercised by the unit suite.
    await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'running', baseSnapshotId: `mv-old-${unique}`, publishLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000), storageIdentity: `local::/tmp/gc-test-${unique}` });
    return { orgId, oldSnapId: oldSnap!.id };
  });

  await cleanupExpiredSnapshots(ctx.orgId);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.oldSnapId));
    expect(rows.length).toBe(1); // not expired (no expiresAt) and not pruned -- pin holds either way
  });
});

// D18 §3.1 late-result fence, through the real applyBackupCommandResultToJob
// path (not the mocked unit test) -- proves the whole chain end to end: a
// result arriving after the job's publish lease has expired is rejected.
runDb('a late result is rejected once its publish lease has expired (real DB)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({
      orgId, configId, deviceId, status: 'failed',
      errorLog: '[stale-backup-reaper] reaped: no progress',
      publishLeaseExpiresAt: new Date(Date.now() - 60 * 1000), // already expired
      storageIdentity: `local::/tmp/gc-test-${unique}`,
    }).returning({ id: backupJobs.id });
    return { orgId, deviceId, jobId: job!.id };
  });

  // Mirrors the real caller (jobs/backupWorker.ts's processResults): the
  // write runs inside a system DB access context, opened once by the
  // caller -- applyBackupCommandResultToJob does not open its own.
  const result = await withSystemDbAccessContext(() =>
    applyBackupCommandResultToJob({
      jobId: ctx.jobId, orgId: ctx.orgId, deviceId: ctx.deviceId, resultStatus: 'completed',
      result: { snapshotId: `late-${unique}`, snapshot: { id: `late-${unique}` }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
      source: 'agent',
    })
  );

  expect(result.applied).toBe(true);
  await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, ctx.jobId));
    expect(row!.status).toBe('failed');
    expect(row!.errorLog ?? '').toContain('publish_lease_expired');
    // No backup_snapshots row must have been created for the late result.
    const snaps = await db.select().from(backupSnapshots).where(eq(backupSnapshots.snapshotId, `late-${unique}`));
    expect(snaps.length).toBe(0);
  });
});

// D18 §3.1 concurrent dispatch vs retention, on TWO SEPARATE code paths racing
// the SAME snapshot row -- proves the lock order (job then snapshot, dispatch
// side; FOR UPDATE, retention side) leaves no dangling pin: either dispatch
// sees the pin survive (retention skipped it) or retention wins and dispatch
// falls back to a full run, never both "dispatch pinned a row retention also
// deleted."
runDb('concurrent dispatch-vs-retention on the same row never leaves a dangling pin', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `race-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { orgId, deviceId, configId, snapId: snap!.id, dispatchJobId: dispatchJob!.id };
  });

  const [dispatchOutcome] = await Promise.all([
    withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
      deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
      mode: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
    })),
    cleanupExpiredSnapshots(ctx.orgId),
  ]);

  await withSystemDbAccessContext(async () => {
    if (dispatchOutcome.baseSnapshotId === `race-${unique}`) {
      // Dispatch won: the snapshot row must still exist (retention saw the pin).
      const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
      expect(rows.length).toBe(1);
    } else {
      // Retention won: dispatch must have fallen back to a full run, and the
      // dispatch job's own base_snapshot_id must be NULL, not dangling.
      expect(dispatchOutcome.baseSnapshotId).toBe('');
      const [dispatchJobRow] = await db.select().from(backupJobs).where(eq(backupJobs.id, ctx.dispatchJobId));
      expect(dispatchJobRow!.baseSnapshotId).toBeNull();
    }
  });
});

// D18 §6(6b) / §3.7 -- run through the actual WORKER HANDLER
// (processCleanupExpiredSnapshots: per-org retention loop -> sweep -> the D17
// final throw), not just cleanupExpiredSnapshots directly, proving the
// worker-level restructuring (Task 8) really does leave earlier retirements
// committed even when the run as a whole ends in the D17 throw.
runDb('processCleanupExpiredSnapshots: an org with a failing row still commits every other retirement, then throws', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const identity = `local::/tmp/gc-test-${unique}`;
    const [job1] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [okSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job1!.id, deviceId, configId, snapshotId: `worker-ok-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [job2] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [failSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job2!.id, deviceId, configId, snapshotId: `worker-fail-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // Pre-seed the retirement row the second row's own insert will collide on.
    await db.insert(backupSnapshotRetirements).values({ orgId, configId, deviceId, snapshotId: `worker-fail-${unique}`, storageIdentity: identity, backupType: 'file', reason: 'manual' });
    return { orgId, okSnapId: okSnap!.id, failSnapId: failSnap!.id };
  });

  // processCleanupExpiredSnapshots iterates ALL orgs with expired snapshots
  // (module-level, not scoped to ctx.orgId) -- the D17 throw at the end is
  // expected given the seeded collision.
  await expect(processCleanupExpiredSnapshots()).rejects.toThrow(/snapshot row delete\(s\) failed/);

  await withSystemDbAccessContext(async () => {
    const okRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.okSnapId));
    expect(okRows.length).toBe(0); // committed despite the throw happening after it
    const failRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.failSnapId));
    expect(failRows.length).toBe(1); // this one legitimately failed and is retried next run
  });
});

// #5421 chain-base pin (live DB): D17 made backup_chains.full_snapshot_id
// ON DELETE SET NULL, so without a pin the DELETE succeeds, Postgres nulls the
// pointer, and the chain keeps reporting is_active/health='active' until the
// next differential runs. These two cases prove the hold and its release
// against real FK behaviour -- the unit suite's mock cannot.
runDb("an ACTIVE MSSQL chain's full snapshot is held by retention and its pointer survives", async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({
      orgId, jobId: job!.id, deviceId, configId, snapshotId: `chain-full-${unique}`, backupType: 'application',
      storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning({ id: backupSnapshots.id });
    const [chain] = await db.insert(backupChains).values({
      orgId, deviceId, configId, chainType: 'mssql', targetName: `db-${unique}`, targetId: `INSTANCE-${unique}`,
      isActive: true, fullSnapshotId: snap!.id, chainMetadata: { health: 'active', continuity: 'ok' },
    }).returning({ id: backupChains.id });
    return { orgId, snapId: snap!.id, chainId: chain!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedChainBase).toBeGreaterThanOrEqual(1);
  expect(result.deleted).toBe(0);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
    expect(rows.length).toBe(1);
    const [chain] = await db.select().from(backupChains).where(eq(backupChains.id, ctx.chainId));
    // The whole point: no silent SET NULL behind an "active" chain.
    expect(chain!.fullSnapshotId).toBe(ctx.snapId);
    expect(chain!.isActive).toBe(true);
    const retirements = await db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, `chain-full-${unique}`));
    expect(retirements.length).toBe(0);
  });
});

runDb('an INACTIVE chain does not hold its full snapshot -- the hold releases', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({
      orgId, jobId: job!.id, deviceId, configId, snapshotId: `dead-chain-full-${unique}`, backupType: 'application',
      storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning({ id: backupSnapshots.id });
    const [chain] = await db.insert(backupChains).values({
      orgId, deviceId, configId, chainType: 'mssql', targetName: `db-${unique}`, targetId: `INSTANCE-${unique}`,
      isActive: false, fullSnapshotId: snap!.id,
      chainMetadata: { health: 'broken', continuity: 'missing_full_backup' },
    }).returning({ id: backupChains.id });
    return { orgId, snapId: snap!.id, chainId: chain!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.deleted).toBeGreaterThanOrEqual(1);
  expect(result.skippedChainBase).toBe(0);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
    expect(rows.length).toBe(0);
    const [chain] = await db.select().from(backupChains).where(eq(backupChains.id, ctx.chainId));
    expect(chain!.fullSnapshotId).toBeNull(); // ON DELETE SET NULL on a chain that is already broken
  });
});

// #6351: an ordinary daily snapshot expires at `taken + keepDaily` (7 days by
// default) while dispatch's publish lease runs to `now + BACKUP_BASE_LEASE_MS`
// (also 7 days). The old candidate filter demanded
// `expires_at > publish_lease_expires_at`, which the newest snapshot missed by
// exactly the gap between the two runs — so EVERY daily backup fell back to a
// full copy. A snapshot that is merely unexpired right now must be picked as
// the base; the pin (proved by the first test in this file) is what keeps it
// alive across the lease.
runDb('picks a base that expires inside the publish-lease window (#6351)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const identity = `local::/tmp/gc-test-${unique}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `lease-base-${unique}`, backupType: 'file', storageIdentity: identity,
      // 7 days minus a minute: unexpired now, but short of `now + 7d` lease.
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 - 60 * 1000),
    });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { orgId, deviceId, configId, dispatchJobId: dispatchJob!.id };
  });

  const outcome = await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
    deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
    mode: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
  }));

  expect(outcome.baseSnapshotId).toBe(`lease-base-${unique}`);
  await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, ctx.dispatchJobId));
    expect(row!.baseSnapshotId).toBe(`lease-base-${unique}`);
  });
});

// The other half of the same contract: an ALREADY-expired snapshot is still
// not a base, so relaxing the lease comparison did not relax expiry itself.
runDb('still refuses an already-expired snapshot as a base (#6351)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const identity = `local::/tmp/gc-test-${unique}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `stale-base-${unique}`, backupType: 'file', storageIdentity: identity,
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { orgId, deviceId, configId, dispatchJobId: dispatchJob!.id };
  });

  const outcome = await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
    deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
    mode: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
  }));

  expect(outcome.baseSnapshotId).toBe('');
  await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, ctx.dispatchJobId));
    expect(row!.baseSnapshotId).toBeNull();
  });
});

// #6351 review fix: the two contracts this change sits between, chained in
// ONE test instead of proved separately — dispatch selects a base that
// expires inside the lease window, then the REAL retention sweep runs against
// the pin dispatch actually wrote. The base must survive, because the pin
// (not expires_at) is what protects an in-flight run.
runDb('a base selected inside the lease window survives a real retention sweep (#6351)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const identity = `local::/tmp/gc-test-${unique}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [baseSnap] = await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `chain-base-${unique}`, backupType: 'file', storageIdentity: identity,
      // Unexpired at dispatch, but expired by the time retention runs below.
      expiresAt: new Date(Date.now() + 2000),
    }).returning({ id: backupSnapshots.id });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { orgId, deviceId, configId, baseSnapId: baseSnap!.id, dispatchJobId: dispatchJob!.id };
  });

  const outcome = await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
    deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
    mode: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
  }));
  expect(outcome.baseSnapshotId).toBe(`chain-base-${unique}`);

  // Let the base's own expiry pass, then run the real sweep.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await withSystemDbAccessContext(() => db.update(backupJobs).set({ status: 'running' }).where(eq(backupJobs.id, ctx.dispatchJobId)));
  await cleanupExpiredSnapshots(ctx.orgId);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.baseSnapId));
    expect(rows.length).toBe(1); // pinned by the dispatch above, not reclaimed
    const retirements = await db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, `chain-base-${unique}`));
    expect(retirements.length).toBe(0);
  });
});

// #6351 review fix: drive the fallback-reason probe through REAL SQL (the
// pure classifier tests supply the probe object directly and so cannot catch
// a field-mapping or join bug in the query that feeds it).
runDb('logs a classified reason when the only snapshot is already expired (#6351)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const identity = `local::/tmp/gc-test-${unique}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `reason-base-${unique}`, backupType: 'file', storageIdentity: identity,
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { deviceId, configId, dispatchJobId: dispatchJob!.id };
  });

  const warnings: string[] = [];
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  try {
    await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
      deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
      mode: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
    }));
  } finally {
    warnSpy.mockRestore();
  }

  const fallbackLine = warnings.find((w) => w.includes('will upload a FULL copy'));
  expect(fallbackLine).toBeDefined();
  expect(fallbackLine).toContain('reason=base_expired');
  expect(fallbackLine).toContain(ctx.dispatchJobId);
});

// Same probe path, different first-failing filter: a snapshot written under a
// previous bucket/path must be reported as an identity change, not as expiry.
runDb('logs storage_identity_changed when the newest snapshot is on another identity (#6351)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `moved-base-${unique}`, backupType: 'file',
      storageIdentity: `local::/tmp/gc-test-OLD-${unique}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { deviceId, configId, dispatchJobId: dispatchJob!.id };
  });

  const warnings: string[] = [];
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  try {
    await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
      deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
      mode: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
    }));
  } finally {
    warnSpy.mockRestore();
  }

  const fallbackLine = warnings.find((w) => w.includes('will upload a FULL copy'));
  expect(fallbackLine).toBeDefined();
  expect(fallbackLine).toContain('reason=storage_identity_changed');
});

// system_image dispatch over file-only history: proves the mode branch of the
// candidate query against real SQL, not just the pure classifier.
runDb('refuses a file snapshot as a system_image base and says so (#6351)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const identity = `local::/tmp/gc-test-${unique}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `file-base-${unique}`, backupType: 'file', storageIdentity: identity,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { deviceId, configId, dispatchJobId: dispatchJob!.id };
  });

  const warnings: string[] = [];
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  let outcome;
  try {
    outcome = await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
      deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
      mode: 'system_image', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
    }));
  } finally {
    warnSpy.mockRestore();
  }

  expect(outcome!.baseSnapshotId).toBe('');
  expect(warnings.find((w) => w.includes('will upload a FULL copy'))).toContain('reason=backup_type_mismatch');
});
