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
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const other = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
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
  const context: DbAccessContext = {
    scope: 'organization',
    orgId: other.id,
    accessibleOrgIds: [other.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  return { org, other, device: device!, context };
}
const insert = (deviceId: string, orgId: string) =>
  db.execute(sql`
  INSERT INTO device_time_status(device_id, org_id, collected_at, received_at)
  VALUES (${deviceId}, ${orgId}, now(), now())`);
it('forces RLS, four policies, three indexes and deferrable immediate ownership', async () => {
  const rows = await getTestDb().execute(sql`
    SELECT c.relrowsecurity, c.relforcerowsecurity, f.condeferrable, f.condeferred
    FROM pg_class c JOIN pg_constraint f ON f.conrelid=c.oid
    WHERE c.oid=to_regclass('device_time_status')
      AND f.conname='device_time_status_device_org_fkey'`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    relrowsecurity: true,
    relforcerowsecurity: true,
    condeferrable: true,
    condeferred: false,
  });
  const policies = await getTestDb().execute(sql`
    SELECT cmd FROM pg_policies WHERE tablename='device_time_status' ORDER BY cmd`);
  expect(policies.map((p) => p.cmd)).toEqual([
    'DELETE',
    'INSERT',
    'SELECT',
    'UPDATE',
  ]);
  const indexes = await getTestDb().execute(sql`
    SELECT indexname FROM pg_indexes WHERE tablename='device_time_status'`);
  expect(indexes.map((i) => i.indexname)).toEqual(
    expect.arrayContaining([
      'device_time_status_org_health_idx',
      'device_time_status_org_domain_idx',
      'device_time_status_findings_gin',
    ]),
  );
});
it('denies forged ownership and cross-org CRUD under the app role', async () => {
  const f = await fixture();
  const [role] = await withDbAccessContext(f.context, () =>
    db.execute(sql`SELECT current_user AS name`),
  );
  expect(role!.name).toBe('breeze_app');
  await expect(
    withDbAccessContext(f.context, () => insert(f.device.id, f.org.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
  await expect(
    withDbAccessContext(system, () => insert(f.device.id, f.other.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
  await withDbAccessContext(system, () => insert(f.device.id, f.org.id));
  for (const query of [
    sql`SELECT * FROM device_time_status WHERE device_id=${f.device.id}`,
    sql`UPDATE device_time_status SET health='critical' WHERE device_id=${f.device.id} RETURNING *`,
    sql`DELETE FROM device_time_status WHERE device_id=${f.device.id} RETURNING *`,
  ])
    expect(
      await withDbAccessContext(f.context, () => db.execute(query)),
    ).toHaveLength(0);
  await expect(
    withDbAccessContext(system, () =>
      db.execute(sql`
    UPDATE device_time_status SET health='bad' WHERE device_id=${f.device.id}`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
});
it('replaying the migration preserves observations and FK properties', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insert(f.device.id, f.org.id));
  await replayMigration('2026-11-10-100000-time-sync-status.sql');
  await replayMigration('2026-11-10-100000-time-sync-status.sql');
  expect(
    await getTestDb().execute(sql`
    SELECT * FROM device_time_status WHERE device_id=${f.device.id}`),
  ).toHaveLength(1);
});
