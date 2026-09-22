import './setup';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  drExecutions,
  drPlanGroups,
  drPlans,
} from '../../db/schema';
import { persistDrAuthorizationDenial, reconcileDrExecution } from '../../services/drExecutionService';
import { resolveLatestRestorableSnapshotId } from '../../services/drBareMetalRebuildStep';
import { handleDrCommandResult } from '../../routes/backup/drResultHandler';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('DR reconciliation authorization against real PostgreSQL', () => {
  // #6322 removed the no-op `SELECT ... FOR UPDATE` this case was named for
  // (it auto-committed outside a transaction and locked nothing). What it
  // actually proves — concurrent ticks converge on one quarantined outcome
  // and dispatch nothing — still holds, now via the guarded write-back.
  runDb('converges concurrent ticks on the legacy-authority quarantine with zero commands', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR authorization integration ${crypto.randomUUID()}`,
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');

    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan.id,
      orgId: org.id,
      executionType: 'rehearsal',
      status: 'pending',
      authorizationPrincipalKind: 'unknown',
      authorizationState: 'quarantined_authorization_unknown',
      authorizationDenialCode: 'authorization_subject_unknown',
    }).returning({ id: drExecutions.id });
    if (!execution) throw new Error('DR execution fixture insert failed');

    const reconcile = () => withSystemDbAccessContext(() => reconcileDrExecution(execution.id));
    const outcomes = await Promise.all([reconcile(), reconcile()]);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.nextDelayMs).toBeNull();
      expect(outcome.execution).toMatchObject({
        id: execution.id,
        status: 'pending',
        authorizationState: 'quarantined_authorization_unknown',
        authorizationDenialCode: 'authorization_subject_unknown',
      });
    }

    const commands = await testDb.execute(sql`
      select id
      from device_commands
      where payload ->> 'drExecutionId' = ${execution.id}
    `);
    expect(commands).toHaveLength(0);
  });

  // #6457: happy path — when the row is genuinely still non-terminal, the
  // guarded CAS write must still succeed. The drizzle-mock unit suite stubs
  // db.update to unconditionally return a row regardless of the WHERE
  // predicate, so it cannot catch a CAS clause that (say) inverted
  // notInArray and blocked every write — only a real-Postgres assertion can.
  runDb('persists the denial when the row is still non-terminal', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR denial CAS happy-path integration ${crypto.randomUUID()}`,
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');

    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan.id,
      orgId: org.id,
      executionType: 'rehearsal',
      status: 'pending',
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: crypto.randomUUID(),
      authorizationGrantRevision: 'grant',
      authorizationState: 'authorized',
      authorizationCheckedAt: new Date(),
    }).returning();
    if (!execution) throw new Error('DR execution fixture insert failed');

    const result = await withSystemDbAccessContext(() => persistDrAuthorizationDenial(
      execution,
      'authorization_denied_test',
      new Date(),
    ));

    expect(result).toMatchObject({
      id: execution.id,
      status: 'failed',
      authorizationState: 'denied',
      authorizationDenialCode: 'authorization_denied_test',
    });

    const [current] = await testDb.select().from(drExecutions).where(eq(drExecutions.id, execution.id));
    expect(current).toMatchObject({ status: 'failed', authorizationState: 'denied' });
  });

  // #6457: an operator abort landing between the denial check and the write
  // must win — persistDrAuthorizationDenial must not resurrect a row another
  // writer has already made terminal back to 'failed'.
  runDb('does not clobber a concurrent operator abort with a denial write', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR denial CAS integration ${crypto.randomUUID()}`,
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');

    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan.id,
      orgId: org.id,
      executionType: 'rehearsal',
      status: 'pending',
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: crypto.randomUUID(),
      authorizationGrantRevision: 'grant',
      authorizationState: 'authorized',
      authorizationCheckedAt: new Date(),
    }).returning();
    if (!execution) throw new Error('DR execution fixture insert failed');

    // Simulate the race: an operator abort lands between the point the
    // reconcile tick read `execution` (status: 'pending', captured above) and
    // the denial write below.
    await withSystemDbAccessContext(() => testDb
      .update(drExecutions)
      .set({ status: 'aborted', completedAt: new Date() })
      .where(eq(drExecutions.id, execution.id)));

    const result = await withSystemDbAccessContext(() => persistDrAuthorizationDenial(
      execution,
      'authorization_denied_test',
      new Date(),
    ));

    // The abort must win: status stays 'aborted', never regressed to 'failed'.
    expect(result?.status).toBe('aborted');

    const [current] = await testDb.select().from(drExecutions).where(eq(drExecutions.id, execution.id));
    expect(current).toMatchObject({ status: 'aborted' });
    expect(current?.authorizationState).not.toBe('denied');
  });

  runDb('preserves the durable subject when an agent result wakes reconciliation', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR result subject integration ${crypto.randomUUID()}`,
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');

    const principalId = crypto.randomUUID();
    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan.id,
      orgId: org.id,
      executionType: 'rehearsal',
      status: 'pending',
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: principalId,
      authorizationGrantRevision: 'durable-grant-revision',
      authorizationState: 'authorized',
      authorizationCheckedAt: new Date('2026-08-24T12:00:00.000Z'),
      results: {
        plannedGroups: [{ groupId: 'group-1', deviceCount: 1 }],
        groupResults: [],
      },
    }).returning({ id: drExecutions.id });
    if (!execution) throw new Error('DR execution fixture insert failed');

    await withSystemDbAccessContext(() => handleDrCommandResult({
      commandId: crypto.randomUUID(),
      commandType: 'vm_restore_from_backup',
      deviceId: crypto.randomUUID(),
      status: 'completed',
      result: { ok: true },
      payload: { drExecutionId: execution.id, drGroupId: 'group-1' },
    }));

    const [after] = await testDb.select().from(drExecutions).where(eq(drExecutions.id, execution.id));
    expect(after).toMatchObject({
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: principalId,
      authorizationGrantRevision: 'durable-grant-revision',
      authorizationState: 'authorized',
    });
  });
});

// ── W05b Task 7: BARE_METAL_REBUILD source resolution ────────────────────────
describe('BARE_METAL_REBUILD step against real PostgreSQL', () => {
  async function seedDeviceWithSnapshots(orgId: string, siteId: string, sfx: string) {
    const testDb = getTestDb();
    const [device] = await testDb.insert(devices).values({
      orgId, siteId, agentId: `bmr-${sfx}`, hostname: `bmr-${sfx}`, osType: 'linux', osVersion: '24.04',
      architecture: 'x86_64', agentVersion: '0.0.0-test',
    }).returning({ id: devices.id });
    const [cfg] = await testDb.insert(backupConfigs).values({
      orgId, name: `bmr-${sfx}`, type: 'file', provider: 'local', providerConfig: {},
    }).returning({ id: backupConfigs.id });
    const [job] = await testDb.insert(backupJobs).values({
      orgId, configId: cfg!.id, deviceId: device!.id, status: 'completed',
    }).returning({ id: backupJobs.id });
    const insertSnapshot = async (label: string, timestamp: Date, restorable: boolean | null) => {
      const [row] = await testDb.insert(backupSnapshots).values({
        orgId, jobId: job!.id, deviceId: device!.id, snapshotId: `${label}-${sfx}`, timestamp,
        bareMetalRestorable: restorable,
      }).returning({ id: backupSnapshots.id });
      return row!.id;
    };
    return { deviceId: device!.id, insertSnapshot };
  }

  runDb('resolves the NEWEST restorable snapshot, skipping newer non-restorable ones', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const sfx = crypto.randomUUID().slice(0, 8);
    const { deviceId, insertSnapshot } = await seedDeviceWithSnapshots(org.id, site.id, sfx);

    await insertSnapshot('old-ok', new Date('2026-09-01T00:00:00Z'), true);
    const newestRestorable = await insertSnapshot('new-ok', new Date('2026-09-02T00:00:00Z'), true);
    await insertSnapshot('newest-bad', new Date('2026-09-03T00:00:00Z'), false);
    await insertSnapshot('newest-unassessed', new Date('2026-09-04T00:00:00Z'), null);

    await expect(
      withSystemDbAccessContext(() => resolveLatestRestorableSnapshotId(org.id, deviceId)),
    ).resolves.toBe(newestRestorable);
  });

  runDb('denies (no_restorable_snapshot) and creates no recovery when a group device has no restorable snapshot', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const sfx = crypto.randomUUID().slice(0, 8);
    const { deviceId, insertSnapshot } = await seedDeviceWithSnapshots(org.id, site.id, sfx);
    await insertSnapshot('bad', new Date('2026-09-01T00:00:00Z'), false);

    const [plan] = await testDb.insert(drPlans).values({ orgId: org.id, name: `BMR plan ${sfx}` }).returning({ id: drPlans.id });
    await testDb.insert(drPlanGroups).values({
      planId: plan!.id, orgId: org.id, name: 'Tier 1', sequence: 1, devices: [deviceId],
      restoreConfig: { commandType: 'BARE_METAL_REBUILD', snapshotSelection: 'latest_restorable', outputDir: '/var/lib/breeze/rebuild/out', waitTimeoutMinutes: 60 },
    });
    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan!.id, orgId: org.id, executionType: 'failover', status: 'pending',
      authorizationPrincipalKind: 'api_key', authorizationPrincipalId: crypto.randomUUID(),
      authorizationGrantRevision: 'grant', authorizationState: 'authorized', authorizationCheckedAt: new Date(),
    }).returning({ id: drExecutions.id });

    const outcome = await withSystemDbAccessContext(() => reconcileDrExecution(execution!.id));

    expect(outcome.nextDelayMs).toBeNull();
    expect(outcome.execution).toMatchObject({ status: 'failed', authorizationState: 'denied', authorizationDenialCode: 'no_restorable_snapshot' });
    const recoveries = await testDb.execute(sql`select id from bare_metal_recoveries where dr_execution_id = ${execution!.id}`);
    expect(recoveries).toHaveLength(0);
  });
});
