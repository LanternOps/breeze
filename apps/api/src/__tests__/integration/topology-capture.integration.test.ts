import './setup';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createSite } from './db-utils';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { enqueueTopologyChange, parseLegacyTopologyEvent, type TopologyChangeInput } from '../../services/topology/legacyCapture';

const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext(orgContext(orgId), action);
const captureMigration = '2026-10-22-150200-topology-legacy-capture.sql';
// Later migrations CREATE OR REPLACE the capture functions (M2 D5 delete cause).
// A replay must re-apply the whole chain, or it leaves the M0 bodies installed
// for every suite that runs after this one in the same database.
const captureMigrationChain = [captureMigration, '2026-11-01-110100-topology-legacy-delete-cause.sql'];
type Scope = { orgId: string; siteId: string };
async function manual(scope: Scope, id = crypto.randomUUID()) {
  await scoped(scope.orgId, () => db.execute(sql`INSERT INTO topology_manual_nodes (id, org_id, site_id, label, role)
    VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'Switch', 'switch')`));
  return id;
}
async function events(scope: Scope) {
  return scoped(scope.orgId, () => db.execute(sql`SELECT *, source_revision::text AS revision FROM topology_change_outbox
    WHERE org_id = ${scope.orgId}::uuid AND site_id = ${scope.siteId}::uuid ORDER BY source_revision`));
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function intent(scope: Scope, key = 'v2-intent:1'): TopologyChangeInput {
  const id = crypto.randomUUID();
  return { version: 1, type: 'node.upsert', sourceTable: 'v2_intents', sourceId: id,
    oldIdentity: null, newIdentity: { orgId: scope.orgId, siteId: scope.siteId, sourceId: id }, idempotencyKey: key,
    data: { label: 'Router', role: 'router', notes: null, createdBy: null } };
}

describe('transactionally captured legacy topology changes', () => {
  it('captures old-client manual writes with all rollout flags off, exactly once', async () => {
    const scope = await createTopologyTenant();
    await scoped(scope.orgId, () => db.execute(sql`UPDATE organizations SET settings = '{"topologyFeatureFlags":{"materialization":false,"ui":false}}' WHERE id = ${scope.orgId}::uuid`));
    const id = await manual(scope);
    await scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET label = 'Core switch' WHERE id = ${id}::uuid`));
    await scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET updated_at = now(), label = label WHERE id = ${id}::uuid`));
    const rows = await events(scope);
    expect(rows.map(r => r.revision)).toEqual(['1', '2']);
    expect(rows.map(r => parseLegacyTopologyEvent(r.payload).type)).toEqual(['node.upsert', 'node.upsert']);
    expect(rows[1]!.payload).toMatchObject({ data: { label: 'Core switch' }, sourceTable: 'topology_manual_nodes' });
  });

  it('rolls back both source row and outbox revision on a failed transaction', async () => {
    const scope = await createTopologyTenant();
    const id = crypto.randomUUID();
    await expect(scoped(scope.orgId, async () => {
      await db.execute(sql`INSERT INTO topology_manual_nodes (id, org_id, site_id, label, role) VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'Switch', 'switch')`);
      throw new Error('rollback writer');
    })).rejects.toThrow('rollback writer');
    expect(await events(scope)).toHaveLength(0);
    expect(await scoped(scope.orgId, () => db.execute(sql`SELECT * FROM topology_site_state WHERE site_id = ${scope.siteId}::uuid`))).toHaveLength(0);
    expect(await scoped(scope.orgId, () => db.execute(sql`SELECT * FROM topology_manual_nodes WHERE id = ${id}::uuid`))).toHaveLength(0);
  });

  it('keeps node and position tombstones after deleting legacy rows', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    await scoped(scope.orgId, async () => {
      await db.execute(sql`INSERT INTO topology_layout (org_id, site_id, node_type, node_id, x, y, pinned) VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, 'manual_node', ${id}::uuid, 1, 2, true)`);
      await db.execute(sql`UPDATE topology_layout SET x = 4 WHERE node_id = ${id}::uuid`);
      await db.execute(sql`DELETE FROM topology_layout WHERE node_id = ${id}::uuid`);
      await db.execute(sql`DELETE FROM topology_manual_nodes WHERE id = ${id}::uuid`);
    });
    const payloads = (await events(scope)).map(r => parseLegacyTopologyEvent(r.payload));
    expect(payloads.map(p => p.type)).toEqual(['node.upsert', 'layout.upsert', 'layout.upsert', 'layout.delete', 'node.delete']);
    expect(payloads[3]!.data).toEqual({ nodeType: 'manual_node', nodeId: id });
    expect(payloads[4]).toMatchObject({ oldIdentity: { orgId: scope.orgId, siteId: scope.siteId, sourceId: id }, newIdentity: null, data: null });
  });

  it('captures only manual relationships and records transitions out of manual ownership', async () => {
    const scope = await createTopologyTenant(); const id = crypto.randomUUID();
    await scoped(scope.orgId, async () => {
      await db.execute(sql`INSERT INTO network_topology (id, org_id, site_id, source_type, source_id, target_type, target_id, connection_type, method)
        VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'manual_node', gen_random_uuid(), 'manual_node', gen_random_uuid(), 'manual', 'arp')`);
      await db.execute(sql`UPDATE network_topology SET method = 'manual' WHERE id = ${id}::uuid`);
      await db.execute(sql`UPDATE network_topology SET last_verified_at = now(), latency = 5 WHERE id = ${id}::uuid`);
      await db.execute(sql`UPDATE network_topology SET method = 'arp' WHERE id = ${id}::uuid`);
      await db.execute(sql`DELETE FROM network_topology WHERE id = ${id}::uuid`);
    });
    expect((await events(scope)).map(r => parseLegacyTopologyEvent(r.payload).type)).toEqual(['relationship.upsert', 'relationship.delete']);
  });

  it('records inventory identity, label, type and accepted-link changes, ignoring heartbeats', async () => {
    const scope = await createTopologyTenant(); const deviceId = crypto.randomUUID(); const assetId = crypto.randomUUID();
    await scoped(scope.orgId, async () => {
      await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
        VALUES (${deviceId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${deviceId}, 'Host', 'linux', '1', 'amd64', '1')`);
      await db.execute(sql`UPDATE devices SET last_seen_at = now(), status = 'online', agent_version = '2' WHERE id = ${deviceId}::uuid`);
      await db.execute(sql`UPDATE devices SET display_name = 'Router', device_role = 'server' WHERE id = ${deviceId}::uuid`);
      await db.execute(sql`INSERT INTO discovered_assets (id, org_id, site_id, ip_address, snmp_data)
        VALUES (${assetId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, '192.0.2.10', '{"password":"never-capture"}')`);
      await db.execute(sql`UPDATE discovered_assets SET last_seen_at = now(), is_online = true, response_time_ms = 2, snmp_data = '{"password":"still-secret"}' WHERE id = ${assetId}::uuid`);
      await db.execute(sql`UPDATE discovered_assets SET label = 'Linked router', asset_type = 'router', linked_device_id = ${deviceId}::uuid, link_source = 'manual', ip_address = '192.0.2.11' WHERE id = ${assetId}::uuid`);
      await db.execute(sql`UPDATE discovered_assets SET linked_device_id = NULL, link_source = NULL, auto_link_suppressed_at = now() WHERE id = ${assetId}::uuid`);
      await db.execute(sql`DELETE FROM discovered_assets WHERE id = ${assetId}::uuid`);
      await db.execute(sql`DELETE FROM devices WHERE id = ${deviceId}::uuid`);
    });
    const rows = await events(scope);
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(parseLegacyTopologyEvent(row.payload).type).toBe('binding.changed');
    expect(JSON.stringify(rows)).not.toMatch(/password|secret|snmpData/);
    expect(rows.at(-1)!.payload).toMatchObject({ data: null, sourceId: deviceId });
  });

  it('captures a site move as old-scope removal and new-scope upsert', async () => {
    const scope = await createTopologyTenant(); const destination = await createSite({ orgId: scope.orgId });
    const id = await manual(scope);
    await scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET site_id = ${destination.id}::uuid WHERE id = ${id}::uuid`));
    const old = (await events(scope)).at(-1)!;
    const next = (await events({ ...scope, siteId: destination.id }))[0]!;
    expect(parseLegacyTopologyEvent(old.payload)).toMatchObject({ type: 'node.delete', data: null, oldIdentity: { siteId: scope.siteId }, newIdentity: { siteId: destination.id } });
    expect(parseLegacyTopologyEvent(next.payload)).toMatchObject({ type: 'node.upsert', data: { label: 'Switch' }, oldIdentity: { siteId: scope.siteId }, newIdentity: { siteId: destination.id } });
    expect(old.revision).toBe('2'); expect(next.revision).toBe('1');
  });

  it('serializes simultaneous opposite-direction site moves without duplicate events', async () => {
    const scope = await createTopologyTenant(); const destination = await createSite({ orgId: scope.orgId });
    const otherScope = { ...scope, siteId: destination.id };
    const a = await manual(scope); const b = await manual(otherScope);
    await Promise.all([
      scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET site_id = ${destination.id}::uuid WHERE id = ${a}::uuid`)),
      scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET site_id = ${scope.siteId}::uuid WHERE id = ${b}::uuid`)),
    ]);
    expect((await events(scope)).map(r => r.revision)).toEqual(['1', '2', '3']);
    expect((await events(otherScope)).map(r => r.revision)).toEqual(['1', '2', '3']);
  });

  it('does not resurrect state when the parent site has already disappeared during erasure', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const rollback = new Error('rollback temporary deferred erasure fixture');
    try {
      // Model cascade ordering on the legacy parent FK without changing its
      // production deletion policy. The DDL and erasure are rolled back together.
      await expect(admin.begin(async tx => {
        const constraints = await tx`SELECT conname FROM pg_constraint WHERE conrelid = 'topology_manual_nodes'::regclass AND confrelid = 'sites'::regclass AND contype = 'f'`;
        for (const row of constraints) await tx.unsafe(`ALTER TABLE topology_manual_nodes ALTER CONSTRAINT "${String(row.conname).replaceAll('"', '""')}" DEFERRABLE INITIALLY DEFERRED`);
        await tx`SET CONSTRAINTS ALL DEFERRED`;
        await tx`DELETE FROM sites WHERE id = ${scope.siteId}::uuid`;
        await tx`DELETE FROM topology_manual_nodes WHERE id = ${id}::uuid`;
        expect(await tx`SELECT * FROM topology_site_state WHERE site_id = ${scope.siteId}::uuid`).toHaveLength(0);
        expect(await tx`SELECT * FROM topology_change_outbox WHERE site_id = ${scope.siteId}::uuid`).toHaveLength(0);
        throw rollback;
      })).rejects.toBe(rollback);
    } finally { await admin.end(); }
  });

  it('does not create old/new state for an organization-only merge repoint', async () => {
    const scope = await createTopologyTenant(); const destination = await createTopologyTenant(); const id = await manual(scope);
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await db.execute(sql`UPDATE topology_manual_nodes SET org_id = ${destination.orgId}::uuid WHERE id = ${id}::uuid`);
      await db.execute(sql`UPDATE sites SET org_id = ${destination.orgId}::uuid WHERE id = ${scope.siteId}::uuid`);
      await db.execute(sql`UPDATE topology_site_state SET org_id = ${destination.orgId}::uuid WHERE site_id = ${scope.siteId}::uuid`);
      await db.execute(sql`UPDATE topology_change_outbox SET org_id = ${destination.orgId}::uuid WHERE site_id = ${scope.siteId}::uuid`);
    });
    expect(await events({ orgId: destination.orgId, siteId: scope.siteId })).toHaveLength(1);
    expect(await withSystemDbAccessContext(() => db.execute(sql`SELECT * FROM topology_site_state WHERE site_id = ${scope.siteId}::uuid`))).toHaveLength(1);
  });

  it('replays one v2 intent without another revision and rejects conflicting reuse', async () => {
    const scope = await createTopologyTenant(); const event = intent(scope);
    const enqueue = (payload: TopologyChangeInput) => scoped(scope.orgId, () => db.transaction(tx => enqueueTopologyChange(tx, scope, payload)));
    expect(await enqueue(event)).toBe('1'); expect(await enqueue(event)).toBe('1');
    await expect(enqueue({ ...event, data: { ...event.data!, label: 'Changed' } } as TopologyChangeInput)).rejects.toThrow(/idempotency/);
    expect(await events(scope)).toHaveLength(1);
    const [state] = await scoped(scope.orgId, () => db.execute(sql`SELECT dirty_revision::text AS revision FROM topology_site_state WHERE site_id = ${scope.siteId}::uuid`));
    expect(state!.revision).toBe('1');
  });

  it('captures a compatibility mirror once and does not capture canonical consumer writes', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    await scoped(scope.orgId, async () => {
      await db.execute(sql`INSERT INTO topology_nodes (org_id, site_id, identity_key, identity_material, kind, label_override)
        VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, 'canonical', '{"version":1,"kind":"manual","sourceKey":"manual:stable"}', 'manual', 'Switch')`);
      await db.execute(sql`UPDATE topology_manual_nodes SET label = 'New switch' WHERE id = ${id}::uuid`);
      await db.execute(sql`UPDATE topology_nodes SET label_override = 'New switch' WHERE site_id = ${scope.siteId}::uuid`);
      await db.execute(sql`UPDATE topology_change_outbox SET delivered_at = now() WHERE site_id = ${scope.siteId}::uuid`);
      await db.execute(sql`UPDATE topology_manual_nodes SET label = 'New switch' WHERE id = ${id}::uuid`);
    });
    expect(await events(scope)).toHaveLength(2);
  });

  it('serializes a delayed writer against a snapshot barrier even after its ID is allocated', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    expect(await events(scope)).toHaveLength(1);
    const written = signal(); const commitWriter = signal(); const barrierStarted = signal();
    const writer = scoped(scope.orgId, async () => {
      await db.execute(sql`UPDATE topology_manual_nodes SET label = 'Before barrier' WHERE id = ${id}::uuid`);
      const rows = await db.execute(sql`SELECT id FROM topology_change_outbox WHERE site_id = ${scope.siteId}::uuid AND source_revision = 2`);
      expect(rows).toHaveLength(1); written.resolve(); await commitWriter.promise;
    });
    await written.promise;
    let barrierFinished = false;
    const barrier = scoped(scope.orgId, async () => {
      barrierStarted.resolve();
      const [state] = await db.execute(sql`SELECT dirty_revision::text AS revision FROM topology_site_state WHERE site_id = ${scope.siteId}::uuid FOR UPDATE`);
      const rows = await db.execute(sql`SELECT id FROM topology_change_outbox WHERE site_id = ${scope.siteId}::uuid AND source_revision <= ${state!.revision as string}::bigint`);
      barrierFinished = true; return { revision: state!.revision, count: rows.length };
    });
    await barrierStarted.promise;
    // An independent read sees only the committed prefix while the writer holds
    // the capture lock; UUID allocation is deliberately irrelevant to the fence.
    expect(await events(scope)).toHaveLength(1); expect(barrierFinished).toBe(false);
    commitWriter.resolve(); await writer;
    expect(await barrier).toEqual({ revision: '2', count: 2 });
  });

  it('gives a post-barrier write a strictly newer captured revision', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    const locked = signal(); const release = signal();
    const barrier = scoped(scope.orgId, async () => {
      const [row] = await db.execute(sql`SELECT dirty_revision::text AS revision FROM topology_site_state WHERE site_id = ${scope.siteId}::uuid FOR UPDATE`);
      locked.resolve(); await release.promise; return row!.revision;
    });
    await locked.promise;
    const writer = scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET label = 'After barrier' WHERE id = ${id}::uuid`));
    release.resolve(); expect(await barrier).toBe('1'); await writer;
    expect((await events(scope)).map(r => r.revision)).toEqual(['1', '2']);
  });

  it('serializes delete-vs-save with a final durable tombstone', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    const updated = signal(); const release = signal();
    const save = scoped(scope.orgId, async () => {
      await db.execute(sql`UPDATE topology_manual_nodes SET label = 'Last saved value' WHERE id = ${id}::uuid`);
      updated.resolve(); await release.promise;
    });
    await updated.promise;
    const deletion = scoped(scope.orgId, () => db.execute(sql`DELETE FROM topology_manual_nodes WHERE id = ${id}::uuid`));
    release.resolve(); await Promise.all([save, deletion]);
    const rows = await events(scope);
    expect(rows.map(r => r.event_kind)).toEqual(['node.upsert', 'node.upsert', 'node.delete']);
    expect(rows.at(-1)!.revision).toBe('3');
  });

  it('rejects cross-tenant SQL enqueue and malformed payloads atomically', async () => {
    const scope = await createTopologyTenant(); const other = await createTopologyTenant(); const event = intent(other);
    await expect(scoped(scope.orgId, () => db.execute(sql`SELECT topology_enqueue_change(${other.orgId}::uuid, ${other.siteId}::uuid, ${JSON.stringify(event)}::jsonb)`))).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(scoped(scope.orgId, () => db.execute(sql`SELECT topology_enqueue_change(${scope.orgId}::uuid, ${scope.siteId}::uuid, ${JSON.stringify({ ...intent(scope), data: { password: 'secret' } })}::jsonb)`))).rejects.toThrow();
    await expect(scoped(scope.orgId, () => db.execute(sql`INSERT INTO topology_manual_nodes (org_id, site_id, label, role)
      VALUES (${scope.orgId}::uuid, ${other.siteId}::uuid, 'Forged site owner', 'switch')`))).rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await events(scope)).toHaveLength(0); expect(await events(other)).toHaveLength(0);
  });

  it('fails the source mutation when bounded capture validation fails', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    await expect(scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET notes = ${'x'.repeat(8193)} WHERE id = ${id}::uuid`))).rejects.toThrow();
    expect(await events(scope)).toHaveLength(1);
    const [row] = await scoped(scope.orgId, () => db.execute(sql`SELECT notes FROM topology_manual_nodes WHERE id = ${id}::uuid`));
    expect(row!.notes).toBeNull();
  });

  it('reapplies the migration without losing events or creating duplicate triggers', async () => {
    const scope = await createTopologyTenant(); const id = await manual(scope);
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try { for (const file of captureMigrationChain) await admin.begin(async tx => { await tx.unsafe(await readFile(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8')); }); }
    finally { await admin.end(); }
    await scoped(scope.orgId, () => db.execute(sql`UPDATE topology_manual_nodes SET label = 'After replay' WHERE id = ${id}::uuid`));
    expect((await events(scope)).map(r => r.revision)).toEqual(['1', '2']);
  });
});
