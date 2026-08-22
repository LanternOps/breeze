import './setup';

import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { backupChains } from '../../db/schema/applicationBackup';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// #3036 — real-Postgres proof for the tenant scoping of the backup-result job
// UPDATE.
//
// This has to be an integration test, and specifically a SYSTEM-scoped one.
// The dominant production path is agent WS -> BullMQ -> jobs/backupWorker.ts,
// which runs this write inside `withSystemDbAccessContext`, where
// `breeze_has_org_access` short-circuits to TRUE and RLS provides no tenant
// scoping whatsoever. The app-layer predicate is the only control on that leg —
// so a mocked unit suite (whose chainable Drizzle mock swallows `.where()`)
// cannot prove any of it, and an org-scoped test would prove the wrong thing by
// letting RLS do the work.
//
// Three properties, in the order they matter:
//   1. the LEGITIMATE write still lands (the regression risk of narrowing a
//      WHERE clause is a silent 0-row no-op, which here would strand a real
//      restorable snapshot with no backup_snapshots row);
//   2. a result reported for the wrong device is rejected and changes nothing;
//   3. an org that drifted under the caller (moveOrg mid-flight) does NOT
//      produce a cross-tenant backup_snapshots row.

async function seedTenant(label: string) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [partner] = await db
    .insert(partners)
    .values({
      name: `${label} Partner ${unique}`,
      slug: `${label}-partner-${unique}`.toLowerCase(),
      type: 'msp',
      plan: 'pro',
      status: 'active',
    })
    .returning({ id: partners.id });
  const [org] = await db
    .insert(organizations)
    .values({
      currencyCode: 'USD',
      partnerId: partner!.id,
      name: `${label} Org ${unique}`,
      slug: `${label}-org-${unique}`.toLowerCase(),
      type: 'customer',
      status: 'active',
    })
    .returning({ id: organizations.id });
  const [site] = await db
    .insert(sites)
    .values({ orgId: org!.id, name: `${label} Site ${unique}` })
    .returning({ id: sites.id });
  const [device] = await db
    .insert(devices)
    .values({
      orgId: org!.id,
      siteId: site!.id,
      agentId: `${label}-agent-${unique}`,
      hostname: `${label}-host-${unique}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  const [config] = await db
    .insert(backupConfigs)
    .values({
      orgId: org!.id,
      name: `${label} Config ${unique}`,
      type: 'file',
      provider: 'local',
      providerConfig: {},
    })
    .returning({ id: backupConfigs.id });

  return { orgId: org!.id, siteId: site!.id, deviceId: device!.id, configId: config!.id };
}

async function seedRunningJob(tenant: { orgId: string; deviceId: string; configId: string }) {
  const [job] = await db
    .insert(backupJobs)
    .values({
      orgId: tenant.orgId,
      configId: tenant.configId,
      deviceId: tenant.deviceId,
      status: 'running',
      startedAt: new Date(),
      lastProgressAt: new Date(),
    })
    .returning({ id: backupJobs.id });
  createdJobIds.push(job!.id);
  return job!.id;
}

beforeEach(() => {
  // The success path escalates a WORM-downgrade to Sentry via console.error and
  // logs the org-drift warning; keep the run readable without hiding failures.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// setup.ts TRUNCATEs core tenant tables beforeEach, so residue only survives
// past this file's LAST test — but rls-coverage runs on its own config with the
// truncate hooks deliberately detached, and it asserts that no device-child
// table has an org_id differing from its device (#750). This file is the one
// place that deliberately drives a device org move, so clean up behind it
// rather than leaving a suite-ordering landmine.
const createdJobIds: string[] = [];
const createdChainIds: string[] = [];
afterAll(async () => {
  if (!process.env.DATABASE_URL || createdJobIds.length === 0) return;
  await withSystemDbAccessContext(async () => {
    // backup_chains FKs backup_snapshots.full_snapshot_id, so it goes first.
    if (createdChainIds.length > 0) {
      await db.delete(backupChains).where(inArray(backupChains.id, createdChainIds));
    }
    await db.delete(backupSnapshots).where(inArray(backupSnapshots.jobId, createdJobIds));
    await db.delete(backupJobs).where(inArray(backupJobs.id, createdJobIds));
  });
});

runDb('records a legitimate backup result under a system context (no silent 0-row no-op)', async () => {
  const tenant = await withSystemDbAccessContext(() => seedTenant('legit'));
  const jobId = await withSystemDbAccessContext(() => seedRunningJob(tenant));

  const applied = await withSystemDbAccessContext(() =>
    applyBackupCommandResultToJob({
      jobId,
      orgId: tenant.orgId,
      deviceId: tenant.deviceId,
      resultStatus: 'completed',
      result: { snapshotId: `snap-${jobId}`, filesBackedUp: 7, bytesBackedUp: 1234 },
    })
  );

  expect(applied.applied).toBe(true);
  expect(applied.snapshotDbId).not.toBeNull();

  await withSystemDbAccessContext(async () => {
    const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
    expect(job!.status).toBe('completed');
    expect(job!.fileCount).toBe(7);

    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(eq(backupSnapshots.jobId, jobId));
    expect(snapshot).toBeDefined();
    expect(snapshot!.orgId).toBe(tenant.orgId);
    expect(snapshot!.deviceId).toBe(tenant.deviceId);
  });
});

runDb('rejects a result reported for a device that does not own the job', async () => {
  const victim = await withSystemDbAccessContext(() => seedTenant('victim'));
  const attacker = await withSystemDbAccessContext(() => seedTenant('attacker'));
  const jobId = await withSystemDbAccessContext(() => seedRunningJob(victim));

  // System scope on purpose: this is exactly the worker's context, where RLS
  // would happily allow the cross-tenant UPDATE. If the device predicate were
  // dropped, this call would flip the victim's job and mint a snapshot row.
  const applied = await withSystemDbAccessContext(() =>
    applyBackupCommandResultToJob({
      jobId,
      orgId: attacker.orgId,
      deviceId: attacker.deviceId,
      resultStatus: 'completed',
      result: { snapshotId: `forged-${jobId}`, filesBackedUp: 999 },
    })
  );

  expect(applied.applied).toBe(false);
  expect(applied.snapshotDbId).toBeNull();

  await withSystemDbAccessContext(async () => {
    const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
    expect(job!.status).toBe('running');
    expect(job!.completedAt).toBeNull();
    expect(job!.fileCount).toBeNull();

    const snapshots = await db
      .select()
      .from(backupSnapshots)
      .where(eq(backupSnapshots.jobId, jobId));
    expect(snapshots).toHaveLength(0);
  });
});

runDb('the caller transaction survives the 0-row diagnostic re-read and keeps working', async () => {
  // SCOPE, stated honestly: this drives the real 0-row + diagnostic path
  // against Postgres and proves the caller's transaction is still usable
  // afterwards and commits cleanly. It does NOT force the re-read to fail, so
  // it is not by itself proof that the SAVEPOINT isolates an error — the
  // mechanism is proved by dbSavepointErrorIsolation.integration.test.ts
  // (#2189), which has both the savepoint case and the poisoning control, and
  // the "query goes through `tx`, not the ambient proxy" half is enforced in
  // the unit suite.
  //
  // What it does buy: the nested transaction is a real extra statement pair
  // (SAVEPOINT / RELEASE) issued mid-context, and this asserts that adding it
  // did not break the callers that keep using the context afterwards. On the
  // hyperv/mssql routes the very next statement is the
  // `markBackupJobFailedIfInFlight` in their catch, so a broken context there
  // leaves the job stuck `running` and 500s the route.
  const victim = await withSystemDbAccessContext(() => seedTenant('healthy'));
  const other = await withSystemDbAccessContext(() => seedTenant('healthyb'));
  const jobId = await withSystemDbAccessContext(() => seedRunningJob(victim));

  const followUp = await withSystemDbAccessContext(async () => {
    const applied = await applyBackupCommandResultToJob({
      jobId,
      orgId: other.orgId,
      deviceId: other.deviceId,
      resultStatus: 'failed',
      result: { error: 'boom' },
    });
    expect(applied.applied).toBe(false);

    // Raises 25P02 ("current transaction is aborted") if the diagnostic left
    // this transaction in a bad state.
    const rows = await db
      .update(backupJobs)
      .set({ lastProgressAt: new Date() })
      .where(eq(backupJobs.id, jobId))
      .returning({ id: backupJobs.id });
    return rows.length;
  });
  // Reaching here at all also proves the context COMMITTED cleanly: postgres.js
  // rethrows a recorded error at commit even when the callback resolved.
  expect(followUp).toBe(1);
});

runDb('attributes the snapshot to the job row org when the device moved orgs mid-flight', async () => {
  const origin = await withSystemDbAccessContext(() => seedTenant('origin'));
  const destination = await withSystemDbAccessContext(() => seedTenant('dest'));
  const jobId = await withSystemDbAccessContext(() => seedRunningJob(origin));

  // Reproduce what moveOrg does to an in-flight job: backup_jobs is in
  // CORE_DEVICE_ORG_DENORMALIZED_TABLES, so the row's org_id is rewritten in
  // place while the queued result still carries the ORIGIN org.
  await withSystemDbAccessContext(async () => {
    await db
      .update(backupJobs)
      .set({ orgId: destination.orgId })
      .where(eq(backupJobs.id, jobId));
    await db
      .update(devices)
      .set({ orgId: destination.orgId, siteId: destination.siteId })
      .where(eq(devices.id, origin.deviceId));
  });

  const applied = await withSystemDbAccessContext(() =>
    applyBackupCommandResultToJob({
      jobId,
      // STALE — the org the device belonged to when the result was enqueued.
      orgId: origin.orgId,
      deviceId: origin.deviceId,
      resultStatus: 'completed',
      result: { snapshotId: `moved-${jobId}`, filesBackedUp: 3 },
    })
  );

  // The backup really happened and its objects are already in storage, so the
  // write must still land — dropping it would orphan a restorable snapshot.
  expect(applied.applied).toBe(true);
  expect(applied.snapshotDbId).not.toBeNull();

  await withSystemDbAccessContext(async () => {
    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(eq(backupSnapshots.jobId, jobId));
    expect(snapshot).toBeDefined();
    // The whole point: BEFORE this fix the caller's stale origin org was written
    // straight through, producing a restore point owned by a tenant the device
    // had already left.
    expect(snapshot!.orgId).toBe(destination.orgId);
    expect(snapshot!.orgId).not.toBe(origin.orgId);

    const strays = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.jobId, jobId), eq(backupSnapshots.orgId, origin.orgId)));
    expect(strays).toHaveLength(0);

    // Same invariant the rls-coverage contract enforces globally (#750): a
    // device-child row's org_id must equal its device's. Asserted here so this
    // path fails in THIS file rather than as a confusing cross-suite failure.
    const [device] = await db.select().from(devices).where(eq(devices.id, origin.deviceId));
    expect(snapshot!.orgId).toBe(device!.orgId);
  });
});

runDb('creates the MSSQL chain under the job row org, not the stale caller org', async () => {
  // backup_snapshots is not the only row the stale org reached:
  // reconcileMssqlBackupChain looks up the chain by (orgId, deviceId, configId,
  // …) and inserts one when it misses. Fed a stale org it would both miss the
  // device's real chain and fork a duplicate under the org the device left.
  // This drives a genuinely MSSQL-shaped result so that function actually runs
  // — a file-type result early-returns and leaves the line uncovered.
  const origin = await withSystemDbAccessContext(() => seedTenant('chainorig'));
  const destination = await withSystemDbAccessContext(() => seedTenant('chaindest'));
  const jobId = await withSystemDbAccessContext(() => seedRunningJob(origin));

  await withSystemDbAccessContext(async () => {
    await db.update(backupJobs).set({ orgId: destination.orgId }).where(eq(backupJobs.id, jobId));
    await db
      .update(devices)
      .set({ orgId: destination.orgId, siteId: destination.siteId })
      .where(eq(devices.id, origin.deviceId));
  });

  const applied = await withSystemDbAccessContext(() =>
    applyBackupCommandResultToJob({
      jobId,
      orgId: origin.orgId, // stale
      deviceId: origin.deviceId,
      resultStatus: 'completed',
      result: {
        snapshotId: `mssql-${jobId}`,
        filesBackedUp: 1,
        metadata: {
          backupKind: 'mssql_database',
          instance: 'MSSQLSERVER',
          database: 'payroll',
          backupSubtype: 'full',
        },
      },
    })
  );
  expect(applied.applied).toBe(true);

  await withSystemDbAccessContext(async () => {
    const chains = await db
      .select()
      .from(backupChains)
      .where(eq(backupChains.deviceId, origin.deviceId));
    // Register for teardown BEFORE asserting: backup_chains FKs
    // backup_snapshots.full_snapshot_id, so an unregistered chain row turns a
    // real assertion failure into a confusing FK violation in afterAll.
    for (const chain of chains) createdChainIds.push(chain.id);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.orgId).toBe(destination.orgId);
    expect(chains[0]!.orgId).not.toBe(origin.orgId);
  });
});
