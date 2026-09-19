import './setup';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { splitSqlStatements } from '../../db/autoMigrate';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { createSite } from './db-utils';
import { createTopologyTenant, createTopologyGraph, orgContext, TOPOLOGY_TABLES } from './topology-fixtures';

const indexFile = '2026-10-20-150000-topology-inventory-fk-targets.sql';
const foundationFile = '2026-10-20-150100-topology-foundation.sql';
const migration = (name: string) => readFile(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext(orgContext(orgId), action);
const rejected = (work: Promise<unknown>, code: string) => expect(work).rejects.toMatchObject({ cause: { code } });

describe('topology foundation', () => {
  it('allows same-scope state and rejects cross-org insertion as breeze_app', async () => {
    const a = await createTopologyTenant();
    const b = await createTopologyTenant();
    const role = await db.execute(sql`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role[0]).toMatchObject({ current_user: 'breeze_app', rolsuper: false, rolbypassrls: false });
    await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid)`));
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${b.orgId}::uuid, ${b.siteId}::uuid)`)), '42501');
  });

  it.each(TOPOLOGY_TABLES)('%s enforces all four RLS policies with positive row controls', async (name) => {
    const a = await createTopologyGraph();
    const b = await createTopologyTenant();
    const table = sql.identifier(name);
    const own = sql`org_id = ${a.orgId}::uuid`;
    expect((await scoped(a.orgId, () => db.execute(sql`SELECT * FROM ${table} WHERE ${own}`))).length).toBeGreaterThan(0);
    expect(await scoped(b.orgId, () => db.execute(sql`SELECT * FROM ${table} WHERE ${own}`))).toHaveLength(0);
    expect(await scoped(b.orgId, () => db.execute(sql`UPDATE ${table} SET updated_at = now() WHERE ${own} RETURNING *`))).toHaveLength(0);
    expect(await scoped(b.orgId, () => db.execute(sql`DELETE FROM ${table} WHERE ${own} RETURNING *`))).toHaveLength(0);
    expect((await withSystemDbAccessContext(() => db.execute(sql`SELECT * FROM ${table} WHERE ${own}`))).length).toBeGreaterThan(0);
    // Owner update succeeds; changing ownership to an inaccessible org fails WITH CHECK.
    expect((await scoped(a.orgId, () => db.execute(sql`UPDATE ${table} SET updated_at = now() WHERE ${own} RETURNING *`))).length).toBeGreaterThan(0);
    await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE ${table} SET org_id = ${b.orgId}::uuid WHERE ${own}`)), '42501');
    const [row] = await scoped(a.orgId, () => db.execute(sql`SELECT * FROM ${table} WHERE ${own} LIMIT 1`));
    // Insert the hidden complete record: RLS must reject before PK/FK validation.
    await rejected(scoped(b.orgId, () => db.execute(sql`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, ${JSON.stringify(row)}::jsonb)`)), '42501');
    expect((await scoped(a.orgId, () => db.execute(sql`DELETE FROM ${table} WHERE ${own} RETURNING *`))).length).toBeGreaterThan(0);
  });

  it('requires inventory XOR and same-org same-site binding, with partial uniqueness', async () => {
    const a = await createTopologyGraph();
    const site = await createSite({ orgId: a.orgId });
    await scoped(a.orgId, () => db.execute(sql`DELETE FROM topology_node_bindings WHERE device_id = ${a.deviceId}::uuid`));
    for (const [column, id] of [['device_id', a.deviceId], ['discovered_asset_id', a.assetId], ['manual_node_id', a.manualId]] as const) {
      await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, ${sql.identifier(column)}) VALUES (${a.orgId}::uuid, ${site.id}::uuid, ${a.nodeId}::uuid, ${id}::uuid)`)), '23503');
      // Same node scope, wrong inventory site cannot be masked by node FK rejection.
      await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind)
        VALUES (gen_random_uuid(), ${a.orgId}::uuid, ${site.id}::uuid, ${column}, '{"version":1,"kind":"endpoint","sourceKey":"fixture"}', 'endpoint')`));
      await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, ${sql.identifier(column)})
        SELECT ${a.orgId}::uuid, ${site.id}::uuid, id, ${id}::uuid FROM topology_nodes WHERE site_id = ${site.id}::uuid AND identity_key = ${column}`)), '23503');
    }
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, ${a.nodeId}::uuid)`)), '23514');
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, device_id, manual_node_id) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, ${a.nodeId}::uuid, ${a.deviceId}::uuid, ${a.manualId}::uuid)`)), '23514');
    await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, manual_node_id) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, ${a.nodeId}::uuid, ${a.manualId}::uuid)`));
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, manual_node_id) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, ${a.targetNodeId}::uuid, ${a.manualId}::uuid)`)), '23505');
    await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, device_id) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, ${a.nodeId}::uuid, ${a.deviceId}::uuid)`));
    // The FK itself remains NO ACTION. The subsequently installed lifecycle
    // BEFORE trigger removes current bindings before an inventory deletion;
    // topology-lifecycle.integration.test.ts proves history survives it.
    expect((await db.execute(sql`SELECT confdeltype FROM pg_constraint WHERE conname='topology_binding_device_scope_fk'`))[0]!.confdeltype).toBe('a');
  });

  it('rejects forged site owners, mixed relationship endpoints, aliases and positions', async () => {
    const a = await createTopologyGraph();
    const b = await createTopologyGraph();
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${a.orgId}::uuid, ${b.siteId}::uuid)`)), '23503');
    await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_relationships SET target_node_id = ${b.nodeId}::uuid WHERE org_id = ${a.orgId}::uuid`)), '23503');
    await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_nodes SET alias_target_id = ${b.nodeId}::uuid WHERE id = ${a.nodeId}::uuid`)), '23503');
    await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_node_positions SET layout_id = ${b.layoutId}::uuid WHERE node_id = ${a.nodeId}::uuid`)), '23503');
  });

  it('keeps one independent layout per view and rejects nonfinite or out-of-range coordinates', async () => {
    const a = await createTopologyGraph();
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_layouts (org_id, site_id, view) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, 'overview')`)), '23505');
    for (const view of ['physical', 'logical']) await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_layouts (org_id, site_id, view) VALUES (${a.orgId}::uuid, ${a.siteId}::uuid, ${view})`));
    for (const value of ['NaN', 'Infinity', '-Infinity', '1000001', '-1000001']) {
      await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_node_positions SET x = ${value}::double precision WHERE node_id = ${a.nodeId}::uuid`)), '23514');
      await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_node_positions SET y = ${value}::double precision WHERE node_id = ${a.nodeId}::uuid`)), '23514');
    }
    await scoped(a.orgId, () => db.execute(sql`UPDATE topology_node_positions SET x = -1000000, y = 1000000 WHERE node_id = ${a.nodeId}::uuid`));
  });

  it('preserves bigint revision fences and archival source identities through migration replay', async () => {
    const a = await createTopologyGraph();
    await scoped(a.orgId, async () => {
      await db.execute(sql`UPDATE topology_nodes SET lifecycle = 'archived', deleted_at = now(), legacy_source_type = 'manual_node', legacy_source_id = ${a.manualId}::uuid, legacy_source_revision = 9007199254740993 WHERE id = ${a.nodeId}::uuid`);
      await db.execute(sql`UPDATE topology_relationships SET lifecycle = 'archived', deleted_at = now(), legacy_source_type = 'legacy_relationship', legacy_source_id = gen_random_uuid(), legacy_source_revision = 9007199254740993 WHERE org_id = ${a.orgId}::uuid`);
      await db.execute(sql`UPDATE topology_node_positions SET deleted_at = now(), legacy_source_revision = 9007199254740993 WHERE node_id = ${a.nodeId}::uuid`);
    });
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      for (const statement of splitSqlStatements(await migration(indexFile))) await admin.unsafe(statement);
      await admin.begin(async tx => { await tx.unsafe(await migration(foundationFile)); });
    } finally { await admin.end(); }
    for (const name of ['topology_nodes', 'topology_relationships', 'topology_node_positions']) {
      const rows = await scoped(a.orgId, () => db.execute(sql`SELECT legacy_source_revision::text AS revision, deleted_at FROM ${sql.identifier(name)} WHERE org_id = ${a.orgId}::uuid AND deleted_at IS NOT NULL`));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revision).toBe('9007199254740993');
    }
  });

  it('rejects malformed identity material, negative counters and oversized JSON', async () => {
    const a = await createTopologyGraph();
    for (const material of [{}, { version: 1, kind: null, sourceKey: 'x' }, { version: 1, kind: 'manual', sourceKey: 'x' }, { version: 1, kind: 'endpoint', sourceKey: '' }, { version: 1, kind: 'endpoint', sourceKey: 'x', arbitrary: true }]) {
      await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_nodes SET identity_material = ${JSON.stringify(material)}::jsonb WHERE id = ${a.nodeId}::uuid`)), '23514');
    }
    await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_site_state SET graph_revision = -1 WHERE org_id = ${a.orgId}::uuid`)), '23514');
    await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_change_outbox SET payload = ${JSON.stringify({ value: 'a'.repeat(262144) })}::jsonb WHERE org_id = ${a.orgId}::uuid`)), '23514');
  });

  it('registers all seven as plain repoint with site-disambiguated keys and immediate deferrable FKs', async () => {
    const defaults = await createTopologyGraph();
    const [relationship] = await scoped(defaults.orgId, () => db.execute(sql`
      SELECT evidence_class, confidence FROM topology_relationships WHERE org_id = ${defaults.orgId}::uuid
    `));
    // The fixture omits both fields: storage defaults must describe one coherent manual assertion.
    expect(relationship).toMatchObject({ evidence_class: 'manual', confidence: 'asserted' });
    const policies = getOrgMergePolicies();
    for (const name of TOPOLOGY_TABLES) expect(policies.get(name)?.kind).toBe('repoint');
    const fks = await db.execute(sql`SELECT conname, condeferrable, condeferred, confdeltype FROM pg_constraint
      WHERE conrelid = ANY(ARRAY[${sql.join(TOPOLOGY_TABLES.map(x => sql`${'public.' + x}::regclass`), sql`, `)}]) AND contype = 'f'`);
    expect(fks.length).toBeGreaterThan(7);
    for (const row of fks) expect(row).toMatchObject({ condeferrable: true, condeferred: false });
    for (const label of ['device','asset','manual']) expect(fks.find(x => x.conname === `topology_binding_${label}_scope_fk`)?.confdeltype).toBe('a');
    const a = await createTopologyGraph();
    const site = await createSite({ orgId: a.orgId });
    // A merge retains globally unique site IDs, so equal identity/outbox keys at distinct sites do not collide.
    await scoped(a.orgId, async () => {
      await db.execute(sql`INSERT INTO topology_nodes (org_id, site_id, identity_key, identity_material, kind)
        SELECT org_id, ${site.id}::uuid, identity_key, identity_material, kind FROM topology_nodes WHERE id = ${a.nodeId}::uuid`);
      await db.execute(sql`INSERT INTO topology_change_outbox (org_id, site_id, event_kind, aggregate_id, idempotency_key)
        SELECT org_id, ${site.id}::uuid, event_kind, aggregate_id, idempotency_key FROM topology_change_outbox WHERE site_id = ${a.siteId}::uuid`);
    });
  });

  it('blocks invalid same-name concurrent indexes and recovers only the verified invalid build', async () => {
    // Dedicated disposable database avoids renaming or dropping any live valid FK target.
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const databaseName = `breeze_test_topology_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    const fixture = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      for (const table of ['devices', 'discovered_assets', 'topology_manual_nodes']) {
        await fixture.unsafe(`CREATE TABLE ${table} (id uuid, org_id uuid, site_id uuid)`);
      }
      await fixture`INSERT INTO devices SELECT '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000003'::uuid FROM generate_series(1, 2)`;
      await expect(fixture`CREATE UNIQUE INDEX CONCURRENTLY devices_id_org_id_site_id_uniq ON public.devices (id, org_id, site_id)`).rejects.toMatchObject({ code: '23505' });
      // Both migrations must fail their real prerequisite check, including IF NOT EXISTS replay.
      const applyIndexes = async () => {
        for (const statement of splitSqlStatements(await migration(indexFile))) await fixture.unsafe(statement);
      };
      await expect(applyIndexes()).rejects.toThrow(/prerequisite index/);
      await expect(fixture.begin(async tx => { await tx.unsafe(await migration(foundationFile)); })).rejects.toThrow(/prerequisite index/);
      const [invalid] = await fixture`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = 'public.devices_id_org_id_site_id_uniq'::regclass`;
      expect(invalid!.indisvalid).toBe(false);
      await fixture`DROP INDEX CONCURRENTLY public.devices_id_org_id_site_id_uniq`;
      await fixture`DELETE FROM devices WHERE ctid = (SELECT ctid FROM devices LIMIT 1)`;
      await applyIndexes();
      const [valid] = await fixture`SELECT i.indisvalid, i.indisready FROM pg_index i WHERE i.indexrelid = 'public.devices_id_org_id_site_id_uniq'::regclass`;
      expect(valid).toMatchObject({ indisvalid: true, indisready: true });
      await applyIndexes();
      // A valid same-name index with the wrong columns must also fail; preserve it until database teardown.
      await fixture`ALTER INDEX public.devices_id_org_id_site_id_uniq RENAME TO preserved_valid_topology_fixture_idx`;
      await fixture`CREATE UNIQUE INDEX CONCURRENTLY devices_id_org_id_site_id_uniq ON public.devices (id)`;
      await expect(applyIndexes()).rejects.toThrow(/prerequisite index/);
    } finally {
      await fixture.end();
      await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    }
  });
});
