import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createPartner, createOrganization } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
import { pgErrorCode } from '../../utils/pgErrors';

const MIGRATION = '2026-12-17-120100-workload-inventory-config-feature.sql';

async function fixture() {
  const p = (await createPartner())!;
  const q = (await createPartner())!;
  const a = (await createOrganization({ partnerId: p.id }))!;
  const b = (await createOrganization({ partnerId: q.id }))!;
  const own: DbAccessContext = { scope: 'organization', orgId: a.id, accessibleOrgIds: [a.id], accessiblePartnerIds: [], currentPartnerId: p.id };
  const foreign: DbAccessContext = { scope: 'organization', orgId: b.id, accessibleOrgIds: [b.id], accessiblePartnerIds: [], currentPartnerId: q.id };
  const owner: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [a.id], accessiblePartnerIds: [p.id], currentPartnerId: p.id };
  const [policy] = await getTestDb().execute(sql`
    INSERT INTO configuration_policies(partner_id, name)
    VALUES (${p.id}, ${'Workload policy ' + randomUUID()}) RETURNING id`);
  const [link] = await getTestDb().execute(sql`
    INSERT INTO config_policy_feature_links(config_policy_id, feature_type)
    VALUES (${String(policy!.id)}, 'workload_inventory') RETURNING id`);
  await withDbAccessContext(owner, () =>
    db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id) VALUES (${String(link!.id)})`),
  );
  return { own, foreign, owner, linkId: String(link!.id) };
}

it('accepts the new feature type and applies the documented defaults', async () => {
  const f = await fixture();
  const [row] = await getTestDb().execute(sql`
    SELECT enabled, docker_enabled, podman_enabled, hyperv_enabled, proxmox_enabled, interval_minutes
      FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`);
  expect(row).toMatchObject({
    enabled: false,
    docker_enabled: true,
    podman_enabled: true,
    hyperv_enabled: true,
    proxmox_enabled: true,
    interval_minutes: 60,
  });
});

it('bounds the interval at 15..1440 and keeps one settings row per feature link', async () => {
  const f = await fixture();
  for (const bad of [14, 1441]) {
    await expect(
      withDbAccessContext(f.owner, () =>
        db.execute(sql`UPDATE config_policy_workload_inventory_settings SET interval_minutes = ${bad} WHERE feature_link_id = ${f.linkId}`),
      ),
    ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  }
  await expect(
    withDbAccessContext(f.owner, () =>
      db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id) VALUES (${f.linkId})`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
});

it('lets the owning partner write, shows partner-wide settings to its orgs read-only, and hides them from other tenants', async () => {
  const f = await fixture();
  const read = () => db.execute(sql`SELECT * FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`);
  expect(await withDbAccessContext(f.owner, read)).toHaveLength(1);
  // org-scoped session of the owning partner's org: SELECT-only partner-wide branch.
  expect(await withDbAccessContext(f.own, read)).toHaveLength(1);
  expect(await withDbAccessContext(f.foreign, read)).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`UPDATE config_policy_workload_inventory_settings SET enabled = true WHERE feature_link_id = ${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`DELETE FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  await expect(
    withDbAccessContext(f.foreign, () =>
      db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id) VALUES (${f.linkId})`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
});

it('cascades the settings row when its feature link is deleted', async () => {
  const f = await fixture();
  await getTestDb().execute(sql`DELETE FROM config_policy_feature_links WHERE id = ${f.linkId}`);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`),
  ).toHaveLength(0);
});

it('replaying the migration is a no-op that preserves rows', async () => {
  const f = await fixture();
  await replayMigration(MIGRATION);
  await replayMigration(MIGRATION);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`),
  ).toHaveLength(1);
});
