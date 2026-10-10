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

const MIGRATION = '2026-12-20-230000-device-workloads.sql';
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
  const otherSite = (await createSite({ orgId: other.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'workload-fixture',
      osType: 'linux',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  // An org-scoped session of the SIBLING org: it must see and forge nothing here.
  const foreign: DbAccessContext = {
    scope: 'organization',
    orgId: other.id,
    accessibleOrgIds: [other.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const own: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  return { partner, org, other, site, otherSite, device: device!, foreign, own };
}

const insertWorkload = (deviceId: string, orgId: string, over: { runtime?: string; kind?: string; workloadId?: string } = {}) =>
  db.execute(sql`
    INSERT INTO device_workloads(device_id, org_id, runtime, kind, workload_id, name, state)
    VALUES (${deviceId}, ${orgId}, ${over.runtime ?? 'docker'}, ${over.kind ?? 'container'},
            ${over.workloadId ?? randomUUID()}, 'web', 'running')`);
const insertRuntime = (deviceId: string, orgId: string, runtime = 'docker', detection = 'present') =>
  db.execute(sql`
    INSERT INTO device_workload_runtimes(device_id, org_id, runtime, detection, collection, complete, collected_at, last_attempt_at)
    VALUES (${deviceId}, ${orgId}, ${runtime}, ${detection}, 'ok', true, now(), now())`);

it('adds the host-axis and capability columns with safe defaults', async () => {
  const f = await fixture();
  const [row] = await getTestDb().execute(sql`
    SELECT hosts_workloads, workload_runtimes, workload_inventory_protocol_version
      FROM devices WHERE id = ${f.device.id}`);
  expect(row).toMatchObject({
    hosts_workloads: false,
    workload_runtimes: [],
    workload_inventory_protocol_version: 0,
  });
});

it('forces RLS with four org policies, deferrable-immediate owner FKs and the indexes on both tables', async () => {
  for (const table of ['device_workloads', 'device_workload_runtimes']) {
    const [flags] = await getTestDb().execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = ${`public.${table}`}::regclass`);
    expect(flags).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await getTestDb().execute(sql`
      SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table} ORDER BY cmd`);
    expect(policies.map((p) => p.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    const [fk] = await getTestDb().execute(sql`
      SELECT condeferrable, condeferred, confupdtype, confdeltype FROM pg_constraint
       WHERE conname = ${`${table}_device_org_fk`}`);
    expect(fk).toMatchObject({ condeferrable: true, condeferred: false, confupdtype: 'c', confdeltype: 'c' });
  }
  const indexes = await getTestDb().execute(sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename IN ('device_workloads', 'device_workload_runtimes')`);
  expect(indexes.map((i) => i.indexname)).toEqual(
    expect.arrayContaining([
      'device_workloads_device_runtime_workload_uniq',
      'device_workloads_org_id_idx',
      'device_workloads_org_image_idx',
      'device_workload_runtimes_device_runtime_uniq',
      'device_workload_runtimes_org_id_idx',
    ]),
  );
});

it('has no partner-export material triggers on either table (D12)', async () => {
  const triggers = await getTestDb().execute(sql`
    SELECT tgname FROM pg_trigger
     WHERE tgrelid IN ('public.device_workloads'::regclass, 'public.device_workload_runtimes'::regclass)
       AND NOT tgisinternal`);
  expect(triggers).toHaveLength(0);
});

it('denies a forged cross-tenant insert as breeze_app (42501) and a wrong composite owner (23503)', async () => {
  const f = await fixture();
  const [role] = await withDbAccessContext(f.foreign, () => db.execute(sql`SELECT current_user AS name`));
  expect(role!.name).toBe('breeze_app');
  for (const insert of [
    () => insertWorkload(f.device.id, f.org.id),
    () => insertRuntime(f.device.id, f.org.id),
  ]) {
    await expect(withDbAccessContext(f.foreign, insert)).rejects.toSatisfy(
      (e: unknown) => pgErrorCode(e) === '42501',
    );
  }
  // system scope passes RLS, so only the composite (device_id, org_id) FK can refuse a wrong owner.
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.other.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.other.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
});

it('isolates reads, updates and deletes by org', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id));
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id));
  for (const query of [
    sql`SELECT * FROM device_workloads WHERE device_id = ${f.device.id}`,
    sql`UPDATE device_workloads SET name = 'x' WHERE device_id = ${f.device.id} RETURNING *`,
    sql`DELETE FROM device_workloads WHERE device_id = ${f.device.id} RETURNING *`,
    sql`SELECT * FROM device_workload_runtimes WHERE device_id = ${f.device.id}`,
    sql`DELETE FROM device_workload_runtimes WHERE device_id = ${f.device.id} RETURNING *`,
  ]) {
    expect(await withDbAccessContext(f.foreign, () => db.execute(query))).toHaveLength(0);
  }
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`SELECT * FROM device_workloads WHERE device_id = ${f.device.id}`),
    ),
  ).toHaveLength(1);
});

it('enforces the runtime, kind, detection and collection vocabularies and the unique keys', async () => {
  const f = await fixture();
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { runtime: 'containerd' })),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { kind: 'pod' })),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'lxd')),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'docker', 'maybe')),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  // containerd IS allowed on the runtime table (detect-only).
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'containerd'));
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { workloadId: 'dup' }));
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { workloadId: 'dup' })),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'containerd')),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
});

it('carries org_id onto both tables when the device moves org', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id));
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id));
  await withDbAccessContext(system, () =>
    db.execute(sql`
      UPDATE devices SET org_id = ${f.other.id}::uuid, site_id = ${f.otherSite.id}::uuid
       WHERE id = ${f.device.id}`),
  );
  for (const table of ['device_workloads', 'device_workload_runtimes']) {
    const rows = await getTestDb().execute(
      sql`SELECT org_id FROM ${sql.raw(table)} WHERE device_id = ${f.device.id}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(f.other.id);
  }
});

it('replaying the migration is a no-op that preserves rows', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id));
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id));
  await replayMigration(MIGRATION);
  await replayMigration(MIGRATION);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM device_workloads WHERE device_id = ${f.device.id}`),
  ).toHaveLength(1);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM device_workload_runtimes WHERE device_id = ${f.device.id}`),
  ).toHaveLength(1);
});
