import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
const system: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const other = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org!.id,
      siteId: site!.id,
      agentId: randomUUID(),
      hostname: 'Device A',
      osType: 'windows',
      osVersion: 'Server',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  return {
    org: org!.id,
    other: other!.id,
    partner: partner!.id,
    device: device!.id,
  };
}
const insert = (deviceId: string, orgId: string) =>
  db.execute(sql`
  INSERT INTO device_time_daily(device_id,org_id,day,snapshot_count) VALUES(${deviceId},${orgId},'2026-09-28',2)`);
it('forces four organization policies and the immediate deferrable composite FK', async () => {
  const rows = await getTestDb()
    .execute(sql`SELECT c.relrowsecurity,c.relforcerowsecurity,f.condeferrable,f.condeferred,f.confupdtype,f.confdeltype
    FROM pg_class c JOIN pg_constraint f ON f.conrelid=c.oid
    WHERE c.oid=to_regclass('device_time_daily') AND f.conname='device_time_daily_device_org_fkey'`);
  expect(rows[0]).toMatchObject({
    relrowsecurity: true,
    relforcerowsecurity: true,
    condeferrable: true,
    condeferred: false,
    confupdtype: 'c',
    confdeltype: 'c',
  });
  const policies = await getTestDb().execute(
    sql`SELECT cmd FROM pg_policies WHERE tablename='device_time_daily'`,
  );
  expect(policies.map((p) => p.cmd).sort()).toEqual([
    'DELETE',
    'INSERT',
    'SELECT',
    'UPDATE',
  ]);
});
it('denies forged ownership and cross-organization reads as breeze_app', async () => {
  const f = await fixture();
  const other: DbAccessContext = {
    scope: 'organization',
    orgId: f.other,
    accessibleOrgIds: [f.other],
    accessiblePartnerIds: [],
    currentPartnerId: f.partner,
  };
  await expect(
    withDbAccessContext(other, () => insert(f.device, f.org)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
  await expect(
    withDbAccessContext(system, () => insert(f.device, f.other)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
  await withDbAccessContext(system, () => insert(f.device, f.org));
  expect(
    await withDbAccessContext(other, () =>
      db.execute(sql`SELECT * FROM device_time_daily`),
    ),
  ).toHaveLength(0);
});
it('replays without deleting observations', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insert(f.device, f.org));
  await replayMigration('2026-11-10-110000-time-sync-daily.sql');
  const rows = await getTestDb().execute(
    sql`SELECT snapshot_count FROM device_time_daily WHERE device_id=${f.device}`,
  );
  expect(rows[0]!.snapshot_count).toBe(2);
});
