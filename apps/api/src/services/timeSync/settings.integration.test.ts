import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
import { pgErrorCode } from '../../utils/pgErrors';
import { resolveDeviceTimeSyncSettings } from './settings';

async function fixture() {
  const p = (await createPartner())!;
  const q = (await createPartner())!;
  const a = (await createOrganization({ partnerId: p.id }))!;
  const b = (await createOrganization({ partnerId: q.id }))!;
  const own: DbAccessContext = {
    scope: 'organization',
    orgId: a.id,
    accessibleOrgIds: [a.id],
    accessiblePartnerIds: [],
    currentPartnerId: p.id,
  };
  const foreign: DbAccessContext = {
    scope: 'organization',
    orgId: b.id,
    accessibleOrgIds: [b.id],
    accessiblePartnerIds: [],
    currentPartnerId: q.id,
  };
  const owner: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [a.id],
    accessiblePartnerIds: [p.id],
    currentPartnerId: p.id,
  };
  const [policy] = await getTestDb().execute(sql`
    INSERT INTO configuration_policies(partner_id, name)
    VALUES (${p.id}, ${'Time policy ' + randomUUID()}) RETURNING id`);
  const [link] = await getTestDb().execute(sql`
    INSERT INTO config_policy_feature_links(config_policy_id, feature_type)
    VALUES (${String(policy!.id)}, 'time_sync') RETURNING id`);
  await withDbAccessContext(owner, () =>
    db.execute(sql`
    INSERT INTO config_policy_time_sync_settings(feature_link_id)
    VALUES (${String(link!.id)})`),
  );
  return {
    own,
    foreign,
    owner,
    linkId: String(link!.id),
    policyId: String(policy!.id),
    orgId: a.id,
  };
}

it('allows own-partner SELECT without granting org writes', async () => {
  const f = await fixture();
  const read = () =>
    db.execute(
      sql`SELECT * FROM config_policy_time_sync_settings WHERE feature_link_id=${f.linkId}`,
    );
  expect(await withDbAccessContext(f.own, read)).toHaveLength(1);
  expect(await withDbAccessContext(f.foreign, read)).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`
    UPDATE config_policy_time_sync_settings SET poll_interval_minutes=120
    WHERE feature_link_id=${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`
    DELETE FROM config_policy_time_sync_settings WHERE feature_link_id=${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  await expect(
    withDbAccessContext(f.foreign, () =>
      db.execute(sql`
    INSERT INTO config_policy_time_sync_settings(feature_link_id) VALUES (${f.linkId})`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
});
it('allows own-org CRUD but rejects sibling-org reads and reparenting', async () => {
  const f = await fixture();
  const sibling = (await createOrganization({
    partnerId: f.own.currentPartnerId!,
  }))!;
  const seed = async (orgId: string) => {
    const [policy] = await getTestDb().execute(
      sql`INSERT INTO configuration_policies(org_id,name) VALUES(${orgId},'Org time policy') RETURNING id`,
    );
    const [link] = await getTestDb().execute(
      sql`INSERT INTO config_policy_feature_links(config_policy_id,feature_type) VALUES(${String(policy!.id)},'time_sync') RETURNING id`,
    );
    return { policyId: String(policy!.id), linkId: String(link!.id) };
  };
  const own = await seed(f.own.orgId!);
  const foreign = await seed(sibling.id);
  const siblingContext: DbAccessContext = {
    ...f.own,
    orgId: sibling.id,
    accessibleOrgIds: [sibling.id],
  };
  await withDbAccessContext(f.own, () =>
    db.execute(
      sql`INSERT INTO config_policy_time_sync_settings(feature_link_id) VALUES(${own.linkId})`,
    ),
  );
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(
        sql`UPDATE config_policy_time_sync_settings SET poll_interval_minutes=120 WHERE feature_link_id=${own.linkId} RETURNING id`,
      ),
    ),
  ).toHaveLength(1);
  expect(
    await withDbAccessContext(siblingContext, () =>
      db.execute(
        sql`SELECT id FROM config_policy_time_sync_settings WHERE feature_link_id=${own.linkId}`,
      ),
    ),
  ).toHaveLength(0);
  await expect(
    withDbAccessContext(f.own, () =>
      db.execute(
        sql`UPDATE config_policy_time_sync_settings SET feature_link_id=${foreign.linkId} WHERE feature_link_id=${own.linkId}`,
      ),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(
        sql`DELETE FROM config_policy_time_sync_settings WHERE feature_link_id=${own.linkId} RETURNING id`,
      ),
    ),
  ).toHaveLength(1);
  await withDbAccessContext(f.own, () =>
    db.execute(
      sql`INSERT INTO config_policy_time_sync_settings(feature_link_id) VALUES(${own.linkId})`,
    ),
  );
  await getTestDb().execute(
    sql`DELETE FROM configuration_policies WHERE id=${own.policyId}`,
  );
  expect(
    await getTestDb().execute(
      sql`SELECT id FROM config_policy_time_sync_settings WHERE feature_link_id=${own.linkId}`,
    ),
  ).toHaveLength(0);
});
it('enforces every typed CHECK and permits boundaries', async () => {
  const f = await fixture();
  const bad = [
    sql`poll_interval_minutes=14`,
    sql`poll_interval_minutes=1441`,
    sql`timezone_expected='other'`,
    sql`timezone_expected='pinned', pinned_timezone=NULL`,
    sql`enforce_ntp=true, ntp_servers='{}'::text[]`,
    sql`ntp_servers=ARRAY['a','b','c','d','e','f']::text[]`,
  ];
  for (const assignment of bad) {
    await expect(
      withDbAccessContext(f.owner, () =>
        db.execute(sql`
      UPDATE config_policy_time_sync_settings SET ${assignment} WHERE feature_link_id=${f.linkId}`),
      ),
    ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  }
  for (const minutes of [15, 1440]) {
    await withDbAccessContext(f.owner, () =>
      db.execute(sql`
      UPDATE config_policy_time_sync_settings SET poll_interval_minutes=${minutes},
      timezone_expected='pinned', pinned_timezone='UTC', enforce_ntp=true,
      ntp_servers=ARRAY['pool.ntp.org'] WHERE feature_link_id=${f.linkId}`),
    );
  }
});
it('is forced, has five policies, and replays without erasing settings', async () => {
  const f = await fixture();
  const rows = await getTestDb().execute(sql`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE oid=to_regclass('config_policy_time_sync_settings')`);
  expect(rows[0]).toMatchObject({
    relrowsecurity: true,
    relforcerowsecurity: true,
  });
  const policies = await getTestDb().execute(sql`
    SELECT polcmd FROM pg_policy WHERE polrelid=to_regclass('config_policy_time_sync_settings')`);
  expect(policies.map((p) => p.polcmd).sort()).toEqual([
    'a',
    'd',
    'r',
    'r',
    'w',
  ]);
  await replayMigration('2026-11-10-120000-time-sync-config-feature.sql');
  await replayMigration('2026-11-10-120000-time-sync-config-feature.sql');
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`
    SELECT id FROM config_policy_time_sync_settings WHERE feature_link_id=${f.linkId}`),
    ),
  ).toHaveLength(1);
});
it('resolves a partner assignment through an org agent context without escalation', async () => {
  const f = await fixture();
  const site = (await createSite({ orgId: f.orgId }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: f.orgId,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'time-fixture',
      osType: 'windows',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  await getTestDb().execute(sql`
    INSERT INTO config_policy_assignments(config_policy_id, level, target_id)
    VALUES (${f.policyId}, 'partner', ${f.own.currentPartnerId})`);
  const own = await withDbAccessContext(f.own, () =>
    resolveDeviceTimeSyncSettings(device!.id),
  );
  expect(own.policy?.policyId).toBe(f.policyId);
  await expect(
    withDbAccessContext(f.foreign, () =>
      resolveDeviceTimeSyncSettings(device!.id),
    ),
  ).rejects.toThrow('Time sync device not visible');
});
