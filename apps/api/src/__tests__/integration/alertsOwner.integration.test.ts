import './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

// Keep the insert, ON CONFLICT and RLS real; observe external effects only.
const { publishEventMock, correlationMock, captureExceptionMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn(async () => 'event-id'),
  correlationMock: vi.fn(async () => 'correlation-job'),
  captureExceptionMock: vi.fn(),
}));
vi.mock('../../services/eventBus', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/eventBus')>(),
  publishEvent: publishEventMock,
}));
vi.mock('../../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: correlationMock }));
vi.mock('../../services/sentry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/sentry')>(),
  captureException: captureExceptionMock,
}));
import { createSourcedAlert } from '../../services/alertService';

const migrationFile = join(__dirname, '../../../migrations/2027-01-17-120000-alerts-owner-kind.sql');
afterAll(() => closeDb());

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function fixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: orgA.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: orgA.id, siteId: site.id, agentId: randomUUID(), hostname: 'owner-test',
    osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }).returning({ id: devices.id });
  if (!device) throw new Error('Device fixture was not inserted');
  return { orgAId: orgA.id as string, orgBId: orgB.id as string, siteId: site.id as string, deviceId: device.id };
}

const workloadInsert = (orgId: string, ref: string, status = 'active') => sql`
  INSERT INTO alerts (org_id, owner_kind, owner_ref, device_id, severity, title, status)
  VALUES (${orgId}::uuid, 'backup_workload', ${ref}, NULL, 'high', 'Workload backup failed', ${status}::alert_status)
  RETURNING id`;

async function expectSqlState(operation: PromiseLike<unknown>, code: string) {
  await expect(operation).rejects.toMatchObject({ cause: { code } });
}

describe('alert owner database contract', () => {
  it('rejects a backup_workload owner with a device (23514)', async () => {
    const f = await fixture();
    await expectSqlState(getTestDb().execute(sql`
      INSERT INTO alerts (org_id, owner_kind, owner_ref, device_id, severity, title)
      VALUES (${f.orgAId}::uuid, 'backup_workload', 'r1', ${f.deviceId}::uuid, 'high', 'Invalid owner')`), '23514');
  });

  it('rejects a device owner without a device (23514)', async () => {
    const f = await fixture();
    await expectSqlState(getTestDb().execute(sql`
      INSERT INTO alerts (org_id, owner_kind, device_id, severity, title)
      VALUES (${f.orgAId}::uuid, 'device', NULL, 'high', 'Invalid owner')`), '23514');
  });

  it('rejects a backup_workload owner without a reference (23514)', async () => {
    const f = await fixture();
    await expectSqlState(getTestDb().execute(sql`
      INSERT INTO alerts (org_id, owner_kind, device_id, severity, title)
      VALUES (${f.orgAId}::uuid, 'backup_workload', NULL, 'high', 'Invalid owner')`), '23514');
  });

  it.each(['active', 'acknowledged', 'suppressed'])('rejects a second open owner when the first is %s (23505)', async (status) => {
    const f = await fixture();
    await getTestDb().execute(workloadInsert(f.orgAId, 'r1', status));
    await expectSqlState(getTestDb().execute(workloadInsert(f.orgAId, 'r1')), '23505');
  });

  it('allows a new owner alert after resolution and keeps owner identity org-scoped', async () => {
    const f = await fixture();
    await getTestDb().execute(workloadInsert(f.orgAId, 'r1'));
    await getTestDb().execute(sql`UPDATE alerts SET status = 'resolved' WHERE org_id = ${f.orgAId}::uuid`);
    const next = await getTestDb().execute(workloadInsert(f.orgAId, 'r1'));
    const otherOrg = await getTestDb().execute(workloadInsert(f.orgBId, 'r1'));
    expect(next).toHaveLength(1);
    expect(otherOrg).toHaveLength(1);
  });

  it('backfills an existing topology alert and replays idempotently', async () => {
    const f = await fixture();
    // Transactional exception to replayMigration: that helper opens its own
    // connection and cannot see the legacy schema below. This migration has
    // no function definitions, and rollback restores all DDL even on failure.
    const migration = readFileSync(migrationFile, 'utf8');
    const rollback = new Error('rollback migration replay');
    await expect(getTestDb().transaction(async (tx) => {
      // This is the pre-migration shape: device is mandatory and ownership is
      // encoded only by topology_site_id/topology_source_key. Restore it only
      // within this rolled-back transaction; no shared schema can be left old.
      await tx.execute(sql`ALTER TABLE alerts DROP COLUMN owner_kind, DROP COLUMN owner_ref`);
      await tx.execute(sql`ALTER TABLE alerts ALTER COLUMN device_id SET NOT NULL`);
      await tx.execute(sql`
        INSERT INTO alerts (org_id, device_id, topology_site_id, topology_source_key, severity, title)
        VALUES (${f.orgAId}::uuid, ${f.deviceId}::uuid, ${f.siteId}::uuid, ${'topology:' + 'a'.repeat(64)}, 'high', 'Legacy topology')`);
      await tx.execute(sql.raw(migration));
      const before = await tx.execute(sql`SELECT id, owner_kind, owner_ref, device_id FROM alerts`);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ owner_kind: 'topology_site', owner_ref: null, device_id: f.deviceId });
      await tx.execute(sql.raw(migration));
      const after = await tx.execute(sql`SELECT id, owner_kind, owner_ref, device_id FROM alerts`);
      expect(after).toEqual(before);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it('hides org-A workload alerts from org B and rejects forged cross-org inserts', async () => {
    const f = await fixture();
    const [inserted] = await getTestDb().execute(workloadInsert(f.orgAId, 'r1'));
    if (!inserted) throw new Error('Workload fixture was not inserted');
    const read = () => db.execute(sql`SELECT id FROM alerts WHERE id = ${inserted.id}::uuid`);
    expect(await withDbAccessContext(orgContext(f.orgAId), read)).toHaveLength(1);
    expect(await withDbAccessContext(orgContext(f.orgBId), read)).toHaveLength(0);
    await expectSqlState(withDbAccessContext(orgContext(f.orgBId), () => db.execute(workloadInsert(f.orgAId, 'forged'))), '42501');
  });
});

describe('sourced workload alert concurrency', () => {
  it('second open backup_workload alert for the same owner is rejected', async () => {
    const f = await fixture();
    publishEventMock.mockClear();
    correlationMock.mockClear();
    captureExceptionMock.mockClear();
    const input = {
      orgId: f.orgAId, deviceId: null, owner: { kind: 'backup_workload' as const, ref: 'concurrent-workload' },
      severity: 'high' as const, title: 'Workload backup failed', message: 'Backup failed',
      context: { source: 'backup_provider' }, publisher: 'backup-provider-test',
    };
    // Two independent request transactions contend on the same unique index.
    // Neither read nor insert is mocked; the loser must wait for the winner's
    // commit, observe the conflict, and return null without publishing.
    const result = await Promise.all([
      withDbAccessContext(orgContext(f.orgAId), () => createSourcedAlert(input)),
      withDbAccessContext(orgContext(f.orgAId), () => createSourcedAlert(input)),
    ]);
    expect(result.filter((id) => id === null)).toHaveLength(1);
    const ids = result.filter((id): id is string => typeof id === 'string');
    expect(ids).toHaveLength(1);
    const rows = await getTestDb().execute(sql`
      SELECT id, device_id, owner_kind, owner_ref FROM alerts WHERE org_id = ${f.orgAId}::uuid`);
    expect(rows).toEqual([{ id: ids[0], device_id: null, owner_kind: 'backup_workload', owner_ref: 'concurrent-workload' }]);
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).toHaveBeenCalledWith('alert.triggered', f.orgAId, expect.objectContaining({
      alertId: ids[0], deviceId: null, owner: input.owner, ownerKey: 'backup_workload:concurrent-workload',
    }), 'backup-provider-test', { siteId: null });
    expect(correlationMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
