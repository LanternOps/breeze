import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { listFleetTimeStatus } from './fleet';
import { exportCurrentTimeCsv, exportHistoryTimeCsv } from './exports';
import {
  db,
  withDbAccessContext,
  withDbTransaction,
  type DbAccessContext,
} from '../../db';
import { devices, deviceTimeStatus } from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { timeStatusSnapshotSchema } from '@breeze/shared';
import { ingestTimeStatusSnapshot } from './ingest';
import { getDeviceTimeStatusView } from './view';

it('accepts reports, audits once, rolls back atomically, and re-resolves policy timezone', async () => {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  await getTestDb().execute(
    sql`UPDATE sites SET timezone='America/Chicago' WHERE id=${site.id}`,
  );
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'time-fixture',
      osType: 'windows',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  const ctx: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const [policy] = await getTestDb().execute(
    sql`INSERT INTO configuration_policies(org_id,name) VALUES(${org.id},'Time policy') RETURNING id`,
  );
  const [link] = await getTestDb().execute(
    sql`INSERT INTO config_policy_feature_links(config_policy_id,feature_type) VALUES(${String(policy!.id)},'time_sync') RETURNING id`,
  );
  await getTestDb()
    .execute(sql`INSERT INTO config_policy_time_sync_settings(feature_link_id,enforce_ntp,ntp_servers,timezone_expected,pinned_timezone)
    VALUES(${String(link!.id)},true,ARRAY['pool.ntp.org'],'pinned','UTC')`);
  await getTestDb().execute(
    sql`INSERT INTO config_policy_assignments(config_policy_id,level,target_id) VALUES(${String(policy!.id)},'device',${device!.id})`,
  );
  const report = {
    resultId: randomUUID(),
    fingerprint: 'sha256:test',
    at: '2026-09-28T12:00:00Z',
    outcome: 'failed',
    reason: 'readback_mismatch',
    before: { type: 'NoSync' },
    after: { type: 'NoSync' },
    error: 'readback failed',
  };
  const snapshot = timeStatusSnapshotSchema.parse({
    schemaVersion: 1,
    sequence: 1,
    collectedAt: '2026-09-28T12:00:00Z',
    config: {
      type: 'NTP',
      ntpServer: 'pool.ntp.org',
      specialPollIntervalSeconds: 3600,
      policyManaged: false,
      policyManagedValues: [],
      serviceState: 'running',
      serviceStartType: 'auto',
      hostTimeProviderEnabled: null,
    },
    status: {
      method: 'events',
      source: 'pool.ntp.org',
      sourceKind: 'ntp_peer',
      lastSuccessfulSyncAt: '2026-09-28T12:00:00Z',
      lastSyncError: null,
      stratum: null,
      pollIntervalSeconds: 3600,
    },
    domain: {
      joinType: 'none',
      role: 'workgroup',
      domainDns: null,
      forestDns: null,
      pdcName: null,
    },
    timezone: {
      windowsId: 'Eastern Standard Time',
      biasMinutes: 300,
      dynamicDstDisabled: false,
      autoUpdate: 'off',
    },
    events: [],
    enforcement: { ntp: report, timezone: null },
  });
  const ingest = (sequence: number) =>
    ingestTimeStatusSnapshot({
      deviceId: device!.id,
      orgId: org.id,
      agentVersion: null,
      snapshot: { ...snapshot, sequence },
      receivedAt: new Date('2026-09-28T12:00:00Z'),
    });
  await withDbAccessContext(ctx, () => ingest(1));
  await Promise.all([
    withDbAccessContext(ctx, () => ingest(2)),
    withDbAccessContext(ctx, () => ingest(3)),
  ]);
  const audits = () =>
    db.execute(
      sql`SELECT * FROM audit_logs WHERE resource_id=${device!.id} AND action='time_sync.enforced'`,
    );
  expect(await withDbAccessContext(ctx, audits)).toHaveLength(1);
  expect((await withDbAccessContext(ctx, () => ingest(1))).accepted).toBe(
    false,
  );
  await expect(
    withDbAccessContext(ctx, () =>
      withDbTransaction(async () => {
        await ingestTimeStatusSnapshot({
          deviceId: device!.id,
          orgId: org.id,
          agentVersion: null,
          snapshot: {
            ...snapshot,
            sequence: 4,
            enforcement: {
              ntp: { ...snapshot.enforcement!.ntp!, resultId: randomUUID() },
              timezone: null,
            },
          },
          receivedAt: new Date('2026-09-28T12:01:00Z'),
        });
        throw new Error('rollback proof');
      }),
    ),
  ).rejects.toThrow('rollback proof');
  expect(await withDbAccessContext(ctx, audits)).toHaveLength(1);
  const [stored] = await withDbAccessContext(ctx, () =>
    db
      .select()
      .from(deviceTimeStatus)
      .where(eq(deviceTimeStatus.deviceId, device!.id)),
  );
  expect(Number(stored!.lastSequence)).toBe(3);
  // A null report retains the last failed result for storage AND ingest reduction.
  await withDbAccessContext(ctx, () =>
    ingestTimeStatusSnapshot({
      deviceId: device!.id,
      orgId: org.id,
      agentVersion: null,
      snapshot: { ...snapshot, sequence: 4, enforcement: null },
      receivedAt: new Date('2026-09-28T12:02:00Z'),
    }),
  );
  const [retained] = await withDbAccessContext(ctx, () =>
    db
      .select()
      .from(deviceTimeStatus)
      .where(eq(deviceTimeStatus.deviceId, device!.id)),
  );
  expect(retained!.enforcement).toEqual(stored!.enforcement);
  expect(retained!.findings).toContain('policy_not_applied');
  expect(retained!.findingStreaks.policy_not_applied).toEqual({
    present: stored!.findingStreaks.policy_not_applied!.present + 1,
    absent: 0,
  });
  expect(await withDbAccessContext(ctx, audits)).toHaveLength(1);
  const view = await withDbAccessContext(ctx, () =>
    getDeviceTimeStatusView(device!.id),
  );
  expect(view!.enforcement?.ntp?.resultId).toBe(report.resultId);
  expect(view!.timezone?.expected).toMatchObject({
    source: 'policy',
    windowsId: 'UTC',
  });
  expect(view!.findings.map((f) => f.code)).toContain('policy_not_applied');
  const auth = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    orgCondition: (column) => eq(column, org.id),
    canAccessOrg: (id: string) => id === org.id,
  } as AuthContext;
  const assertParity = async (mismatch: boolean, failure: boolean) =>
    withDbAccessContext(ctx, async () => {
      const current = (await getDeviceTimeStatusView(device!.id))!;
      const fleet = await listFleetTimeStatus({ deviceId: device!.id }, auth);
      expect(fleet.total).toBe(1);
      expect(fleet.data[0]!.view).toEqual(current);
      for (const [finding, present] of [
        ['timezone_mismatch', mismatch],
        ['policy_not_applied', failure],
      ] as const) {
        const filters = { deviceId: device!.id, finding, limit: 1 };
        const filtered = await listFleetTimeStatus(filters, auth);
        expect(filtered.total).toBe(present ? 1 : 0);
        expect(filtered.data.map((row) => row.deviceId)).toEqual(
          present ? [device!.id] : [],
        );
        const second = await listFleetTimeStatus({ ...filters, page: 2 }, auth);
        expect(second.total).toBe(filtered.total);
        expect(second.data).toEqual([]);
        let currentCsv = '';
        for await (const chunk of exportCurrentTimeCsv(filters, auth))
          currentCsv += chunk;
        expect(currentCsv.includes(device!.id)).toBe(present);
        const day = new Date().toISOString().slice(0, 10);
        let historyCsv = '';
        for await (const chunk of exportHistoryTimeCsv(
          filters,
          { from: day, to: day },
          auth,
        ))
          historyCsv += chunk;
        expect(historyCsv.includes(device!.id)).toBe(present);
      }
      expect(
        (
          await listFleetTimeStatus(
            { deviceId: device!.id, health: current.health },
            auth,
          )
        ).total,
      ).toBe(1);
    });
  await assertParity(true, true); // UTC pin beats the Central site; retained failure stays active.
  await getTestDb().execute(
    sql`UPDATE config_policy_time_sync_settings SET pinned_timezone='America/New_York' WHERE feature_link_id=${String(link!.id)}`,
  );
  await assertParity(false, true); // Pin change takes effect without another snapshot or cache expiry.
  await getTestDb().execute(
    sql`UPDATE config_policy_time_sync_settings SET enforce_ntp=false WHERE feature_link_id=${String(link!.id)}`,
  );
  await assertParity(false, false); // Stored failure must disappear from live views AND filter/count paths.
  const disabled = await withDbAccessContext(ctx, () =>
    getDeviceTimeStatusView(device!.id),
  );
  expect(disabled!.enforcement?.ntp?.resultId).toBe(report.resultId);
  await getTestDb().execute(
    sql`DELETE FROM config_policy_assignments WHERE config_policy_id=${String(policy!.id)}`,
  );
  await assertParity(true, false); // Removing policy restores the Central site expectation immediately.
  const removed = await withDbAccessContext(ctx, () =>
    getDeviceTimeStatusView(device!.id),
  );
  expect(removed!.timezone?.expected).toMatchObject({
    source: 'site',
    windowsId: 'Central Standard Time',
  });
});
