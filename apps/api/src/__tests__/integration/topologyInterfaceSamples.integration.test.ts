import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import fixtureFile from '../../../../../packages/shared/src/testing/topology-interface-metrics-v1.json';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { topologyInterfaceSamples } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createSite } from './db-utils';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { replayMigration } from './replayMigration';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import {
  registerTopologyTelemetryAuthority, resolveTopologyPhysicalProducer, registerTopologyProducerAuthority, resolveTopologyTelemetryProducer,
  revokeTopologyTelemetrySources, type AuthenticatedTopologyTelemetryProducer, type TopologyTelemetryAuthorityRequest,
} from '../../services/topology/collectionAuthority';
import { ingestTopologySourceReport } from '../../services/topology/collectionIngest';
import {
  persistTopologyInterfaceSamples, TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED, TOPOLOGY_TELEMETRY_SOURCE_DAILY_SAMPLES, topologyTelemetryInFlightLockKey,
} from '../../services/topology/interfaceSamples';
import { readGraphCoverage } from '../../services/topology/physicalCoverage';
import { executeOrgMerge } from '../../services/orgMerge';
import { canonicalIdentityKey } from '../../services/topology/identity';

const TARGET = 'snmp:192.0.2.10';
const MIGRATION = '2026-11-02-100000-topology-interface-samples.sql';
const UINT64_MAX = '18446744073709551615';
const base = fixtureFile.valid.samples[0]!;
const iso = (ms: number) => new Date(ms).toISOString();
const today = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

let allowed: string[] = [];
let generation = 'arm-1';
const requests: TopologyTelemetryAuthorityRequest[] = [];
let unregister: (() => void) | undefined;
beforeEach(() => {
  allowed = []; generation = 'arm-1'; requests.length = 0;
  vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0');
  // Stand-in for Track B's standing telemetry arm.
  unregister = registerTopologyTelemetryAuthority('snmp', async request => {
    requests.push(request);
    return request.authorityKey === TARGET ? { authorized: true, configurationGeneration: generation, interfaceIds: allowed } : { authorized: false, reason: 'arm_not_found' };
  });
});
afterEach(() => { unregister?.(); unregister = undefined; vi.unstubAllEnvs(); });

async function fixture() {
  const f = await topologyIngestFixture();
  const scope = { orgId: f.orgId, siteId: f.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId), fn);
  const siteB = (await createSite({ orgId: f.orgId })).id;
  const nodeB = crypto.randomUUID();
  const [ifA, ifA2, ifRetired, ifB] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await scoped(async () => {
    await db.execute(sql`UPDATE organizations SET settings='{"topologyFeatureFlags":{"materialization":true,"interfaceHealth":true}}' WHERE id=${f.orgId}::uuid`);
    await db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind)
      VALUES (${nodeB}::uuid, ${f.orgId}::uuid, ${siteB}::uuid, ${nodeB}, ${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: nodeB })}::jsonb, 'endpoint')`);
    for (const [id, site, node, key, epoch, retired] of [[ifA, f.siteId, f.nodeId, 'port-1', 'gen:1', false], [ifA2, f.siteId, f.nodeId, 'port-2', 'gen:1', false],
      [ifRetired, f.siteId, f.nodeId, 'port-3', 'gen:1', true], [ifB, siteB, nodeB, 'port-1', 'gen:1', false]] as const) {
      await db.execute(sql`INSERT INTO topology_interfaces (id, org_id, site_id, owner_node_id, interface_key, epoch, retired_at)
        VALUES (${id}::uuid, ${f.orgId}::uuid, ${site}::uuid, ${node}::uuid, ${key}, ${epoch}, ${retired ? sql`now()` : sql`NULL`})`);
    }
  });
  allowed = [ifA, ifA2, ifRetired, ifB];
  const resolve = () => scoped(() => resolveTopologyTelemetryProducer({ producerKind: 'snmp', deviceId: f.deviceId, scope, authorityKey: TARGET }));
  const producer = await resolve();
  const sample = (interfaceId: string, atMs: number, over: Record<string, unknown> = {}) =>
    ({ ...structuredClone(base), interfaceId, interfaceEpoch: 'gen:1', sampledAt: iso(atMs), ...over });
  const envelope = (p: AuthenticatedTopologyTelemetryProducer, sequence: string, atMs: number, samples: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, family: 'if_metrics', producerEpoch: p.producerEpoch, sequence, commandId: null, configurationRevision: p.configurationRevision,
    startedAt: iso(atMs - 1000), finishedAt: iso(atMs + 1000), captureAgeAtSendMs: 0, expectedIntervalSeconds: 60,
    outcome: 'complete', reasonCode: null, samples, ...over,
  });
  const persist = (value: unknown, p = producer) => scoped(() => persistTopologyInterfaceSamples(p, value));
  const count = (where = sql`TRUE`) => withSystemDbAccessContext(async () =>
    Number((await db.execute(sql`SELECT count(*)::int AS n FROM topology_interface_samples WHERE org_id=${f.orgId}::uuid AND ${where}`))[0]!.n));
  const revisions = () => withSystemDbAccessContext(async () => (await db.execute(sql`SELECT graph_revision::text AS graph, health_revision::text AS health
    FROM topology_site_state WHERE org_id=${f.orgId}::uuid AND site_id=${f.siteId}::uuid`))[0] as { graph: string; health: string });
  return { ...f, scope, scoped, siteB, nodeB, ifA, ifA2, ifRetired, ifB, producer, resolve, sample, envelope, persist, count, revisions };
}
const minute = 60_000;

describe('topology interface samples: schema and tenancy', () => {
  it('rejects a forged sample whose interface belongs to another site of the same org', async () => {
    const f = await fixture();
    const now = Date.now();
    const receipt = await f.persist(f.envelope(f.producer, '1', now - minute, [f.sample(f.ifA, now - minute)]));
    await expect(f.scoped(() => db.execute(sql`
      INSERT INTO topology_interface_samples
        (org_id,site_id,interface_id,interface_epoch,source_id,producer_epoch,source_sequence,sampled_at,resolution)
      VALUES (${f.orgId}::uuid,${f.siteId}::uuid,${f.ifB}::uuid,'gen:1',${receipt.sourceId!}::uuid,'epoch-a','1',now(),'raw')
    `))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('round-trips the uint64 maximum sequence and rejects overflow and JS-number transport', async () => {
    const f = await fixture();
    const now = Date.now();
    const receipt = await f.persist(f.envelope(f.producer, UINT64_MAX, now - minute, [f.sample(f.ifA, now - minute)]));
    expect(receipt).toMatchObject({ accepted: true, acceptedSequence: UINT64_MAX, inserted: 1 });
    const [row] = await f.scoped(() => db.select({ sequence: topologyInterfaceSamples.sourceSequence, readings: topologyInterfaceSamples.readings })
      .from(topologyInterfaceSamples).where(eq(topologyInterfaceSamples.interfaceId, f.ifA)));
    expect(row!.sequence).toBe(UINT64_MAX);
    expect(JSON.parse(JSON.stringify(row)).sequence).toBe(UINT64_MAX);
    expect((row!.readings as Record<string, unknown>).inOctets).toBe(base.inOctets);
    await expect(f.scoped(() => db.execute(sql`
      INSERT INTO topology_interface_samples (org_id,site_id,interface_id,interface_epoch,source_id,producer_epoch,source_sequence,sampled_at,resolution)
      VALUES (${f.orgId}::uuid,${f.siteId}::uuid,${f.ifA2}::uuid,'gen:1',${receipt.sourceId!}::uuid,'epoch-a','18446744073709551616',now(),'raw')
    `))).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(f.persist(f.envelope(f.producer, 18446744073709551615 as never, now, [f.sample(f.ifA2, now)]))).rejects.toThrow('invalid_envelope');
  });

  it('denies cross-org SELECT, INSERT, UPDATE and DELETE on the parent and every partition level', async () => {
    const f = await fixture();
    const now = Date.now();
    await f.persist(f.envelope(f.producer, '1', now - minute, [f.sample(f.ifA, now - minute)]));
    const otherOrg = (await createTopologyTenant()).orgId;
    const relations = ['topology_interface_samples', 'topology_interface_samples_raw', `topology_interface_samples_raw_p${today()}`];
    const [row] = await f.scoped(() => db.execute(sql`SELECT * FROM topology_interface_samples WHERE org_id=${f.orgId}::uuid`));
    for (const name of relations) {
      const table = sql.identifier(name);
      expect(await f.scoped(() => db.execute(sql`SELECT 1 FROM ${table} WHERE org_id=${f.orgId}::uuid`)), `${name} own read`).toHaveLength(1);
      const asOther = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(otherOrg), fn);
      expect(await asOther(() => db.execute(sql`SELECT 1 FROM ${table} WHERE org_id=${f.orgId}::uuid`)), `${name} read`).toHaveLength(0);
      expect(await asOther(() => db.execute(sql`UPDATE ${table} SET updated_at=now() WHERE org_id=${f.orgId}::uuid RETURNING 1`)), `${name} update`).toHaveLength(0);
      expect(await asOther(() => db.execute(sql`DELETE FROM ${table} WHERE org_id=${f.orgId}::uuid RETURNING 1`)), `${name} delete`).toHaveLength(0);
      const forged = { ...row, sampled_at: new Date(now - 30_000).toISOString() };
      await expect(asOther(() => db.execute(sql`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, ${JSON.stringify(forged)}::jsonb)`)), `${name} insert`)
        .rejects.toMatchObject({ cause: { code: '42501' } });
    }
    expect(await f.count()).toBe(1);
  });

  it('forces RLS with four org policies on every relation in the partition tree', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname
          AND p.policyname IN ('breeze_org_isolation_select','breeze_org_isolation_insert','breeze_org_isolation_update','breeze_org_isolation_delete')) AS policies,
        has_table_privilege('breeze_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS granted
      FROM pg_partition_tree('public.topology_interface_samples') t JOIN pg_class c ON c.oid = t.relid`));
    expect(rows.length).toBeGreaterThanOrEqual(4 + 3 * 9);
    for (const row of rows) expect(row, String(row.name)).toMatchObject({ rls: true, forced: true, policies: 4, granted: true });
    expect(rows.some(row => /_default$/.test(String(row.name)))).toBe(false);
  });

  it('lets breeze_app create and drop leaves only through the bounded SECURITY DEFINER entry points', async () => {
    const ensure = (resolution: string, offsetDays: number) => withSystemDbAccessContext(async () => (await db.execute(sql`
      SELECT public.breeze_ensure_topology_interface_sample_partition(${resolution}, (now() AT TIME ZONE 'UTC')::date + ${offsetDays}::int) AS name`))[0]!.name as string);
    const drop = (resolution: string, offsetDays: number) => withSystemDbAccessContext(async () => (await db.execute(sql`
      SELECT public.breeze_drop_topology_interface_sample_partition(${resolution}, (now() AT TIME ZONE 'UTC')::date + ${offsetDays}::int) AS name`))[0]!.name as string | null);
    const future = await ensure('1h', 10);
    expect(future).toMatch(/^topology_interface_samples_1h_p\d{8}$/);
    expect(await ensure('1h', 10)).toBe(future);
    const [state] = await withSystemDbAccessContext(() => db.execute(sql`SELECT relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE relname=${future}`));
    expect(state!.forced).toBe(true);
    await expect(ensure('raw', 15)).rejects.toMatchObject({ cause: { code: '22023' } });
    await expect(ensure('raw', -9)).rejects.toMatchObject({ cause: { code: '22023' } });
    await expect(ensure('1m', 0)).rejects.toMatchObject({ cause: { code: '22023' } });
    await expect(drop('raw', -1)).rejects.toMatchObject({ cause: { code: '22023' } });
    const expired = await ensure('raw', -8);
    expect(await drop('raw', -8)).toBe(expired);
    expect(await drop('raw', -8)).toBeNull();
    await expect(withSystemDbAccessContext(() => db.execute(sql`CREATE TABLE topology_interface_samples_raw_p19990101 PARTITION OF topology_interface_samples_raw
      FOR VALUES FROM ('1999-01-01') TO ('1999-01-02')`))).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`SELECT public.breeze_converge_topology_interface_sample_rls('topology_interface_samples_raw')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    const [acl] = await getTestDb().execute(sql`SELECT
      has_function_privilege('public', 'public.breeze_ensure_topology_interface_sample_partition(text,date)', 'EXECUTE') AS ensure_public,
      has_function_privilege('public', 'public.breeze_drop_topology_interface_sample_partition(text,date)', 'EXECUTE') AS drop_public`);
    expect(acl).toEqual({ ensure_public: false, drop_public: false });
  });

  it('keeps raw readings immutable but lets ownership move', async () => {
    const f = await fixture();
    const now = Date.now();
    await f.persist(f.envelope(f.producer, '1', now - minute, [f.sample(f.ifA, now - minute)]));
    await expect(f.scoped(() => db.execute(sql`UPDATE topology_interface_samples SET readings='{"forged":true}' WHERE org_id=${f.orgId}::uuid`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(f.scoped(() => db.execute(sql`UPDATE topology_interface_samples SET source_sequence=7 WHERE org_id=${f.orgId}::uuid`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    expect(await f.scoped(() => db.execute(sql`UPDATE topology_interface_samples SET updated_at=now() WHERE org_id=${f.orgId}::uuid RETURNING 1`))).toHaveLength(1);
  });

  it('purges samples before their interface and source parents', async () => {
    const f = await fixture();
    const now = Date.now();
    const receipt = await f.persist(f.envelope(f.producer, '1', now - minute, [f.sample(f.ifA, now - minute), f.sample(f.ifA2, now - minute)]));
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM topology_interfaces WHERE id=${f.ifA}::uuid`));
    expect(await f.count()).toBe(1);
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM topology_collection_sources WHERE id=${receipt.sourceId!}::uuid`));
    expect(await f.count()).toBe(0);
  });

  it('replays the migration without changing rows, policies or leaves', async () => {
    const f = await fixture();
    const now = Date.now();
    await f.persist(f.envelope(f.producer, UINT64_MAX, now - minute, [f.sample(f.ifA, now - minute)]));
    const snapshot = () => withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS relations,
      (SELECT count(*)::int FROM pg_policies WHERE tablename LIKE 'topology_interface_samples%') AS policies
      FROM pg_partition_tree('public.topology_interface_samples')`));
    const before = await snapshot();
    await replayMigration(MIGRATION);
    expect(await snapshot()).toEqual(before);
    expect(await f.count(sql`source_sequence = ${UINT64_MAX}::numeric`)).toBe(1);
  });
});

describe('topology interface samples: telemetry sink', () => {
  it('accepts a batch, replays it idempotently and refuses stale or conflicting sequences', async () => {
    const f = await fixture();
    const t = Date.now() - 5 * minute;
    const first = f.envelope(f.producer, '5', t, [f.sample(f.ifA, t), f.sample(f.ifA2, t)]);
    expect(await f.persist(first)).toMatchObject({ accepted: true, inserted: 2, duplicates: 0, historicalOnly: 0, acceptedSequence: '5' });
    expect(await f.persist(structuredClone(first))).toMatchObject({ accepted: true, inserted: 0, duplicates: 2 });
    expect(await f.persist({ ...first, samples: [first.samples[0]] })).toMatchObject({ accepted: false, reason: 'sequence_conflict' });
    expect(await f.persist(f.envelope(f.producer, '4', t + minute, [f.sample(f.ifA, t + minute)]))).toMatchObject({ accepted: false, reason: 'stale_sequence' });
    expect(await f.count()).toBe(2);
    expect(requests.at(-1)).toMatchObject({ family: 'if_metrics', producerKind: 'snmp', authorityKey: TARGET, scope: f.scope, commandId: null });
  });

  it('writes a batch atomically: a conflicting sample at an existing identity writes nothing', async () => {
    const f = await fixture();
    const t = Date.now() - 5 * minute;
    await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]));
    const conflicting = f.envelope(f.producer, '2', t, [f.sample(f.ifA2, t), f.sample(f.ifA, t, { inOctets: '1' })]);
    expect(await f.persist(conflicting)).toMatchObject({ accepted: false, reason: 'sample_conflict', acceptedSequence: '1' });
    expect(await f.count()).toBe(1);
    const identical = f.envelope(f.producer, '2', t, [f.sample(f.ifA2, t), f.sample(f.ifA, t)]);
    expect(await f.persist(identical)).toMatchObject({ accepted: true, inserted: 1, duplicates: 1 });
  });

  it('stores late samples and retired generations as history only and bumps only the health revision', async () => {
    const f = await fixture();
    const t = Date.now() - 10 * minute;
    const start = await f.revisions();
    expect(await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]))).toMatchObject({ healthChanged: true, historicalOnly: 0 });
    const afterFirst = await f.revisions();
    expect(BigInt(afterFirst.health)).toBe(BigInt(start.health) + 1n);
    expect(await f.persist(f.envelope(f.producer, '2', t + minute, [f.sample(f.ifA, t + minute, { inOctets: '99' })]))).toMatchObject({ healthChanged: false });
    expect((await f.revisions()).health).toBe(afterFirst.health);
    expect(await f.persist(f.envelope(f.producer, '3', t + 2 * minute, [f.sample(f.ifA, t + 2 * minute, { operStatus: 'down' })]))).toMatchObject({ healthChanged: true });
    const late = await f.persist(f.envelope(f.producer, '4', t - minute, [f.sample(f.ifA, t - minute), f.sample(f.ifRetired, t - minute)]));
    expect(late).toMatchObject({ accepted: true, inserted: 2, historicalOnly: 2, healthChanged: false });
    const end = await f.revisions();
    expect(end.graph).toBe(start.graph);
    expect(BigInt(end.health)).toBe(BigInt(start.health) + 2n);
  });

  it('refuses unauthorized, unknown, foreign-site and wrong-epoch interfaces', async () => {
    const f = await fixture();
    const t = Date.now() - minute;
    const outside = crypto.randomUUID();
    expect(await f.persist(f.envelope(f.producer, '1', t, [f.sample(outside, t)]))).toMatchObject({ accepted: false, reason: 'interface_not_authorized' });
    allowed.push(outside);
    expect(await f.persist(f.envelope(f.producer, '1', t, [f.sample(outside, t)]))).toMatchObject({ accepted: false, reason: 'interface_not_found' });
    expect(await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifB, t)]))).toMatchObject({ accepted: false, reason: 'interface_not_found' });
    expect(await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t, { interfaceEpoch: 'gen:2' })]))).toMatchObject({ accepted: false, reason: 'interface_epoch_mismatch' });
    expect(await f.persist(f.envelope(f.producer, '1', Date.now() + 10 * minute, [f.sample(f.ifA, Date.now() + 10 * minute)]))).toMatchObject({ accepted: false, reason: 'invalid_capture_time' });
    expect(await f.count()).toBe(0);
  });

  it('default-denies without a registered authority and when interface health is disabled', async () => {
    const f = await fixture();
    const t = Date.now() - minute;
    unregister?.(); unregister = undefined;
    await expect(f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]))).rejects.toThrow('producer_authority_unavailable');
    await expect(f.resolve()).rejects.toThrow('producer_authority_unavailable');
    unregister = registerTopologyTelemetryAuthority('snmp', async () => ({ authorized: false, reason: 'arm_expired' }));
    await expect(f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]))).rejects.toThrow('producer_authority_denied');
    unregister(); unregister = registerTopologyTelemetryAuthority('snmp', async () => ({ authorized: true, configurationGeneration: generation, interfaceIds: allowed }));
    await f.scoped(() => db.execute(sql`UPDATE organizations SET settings='{"topologyFeatureFlags":{"materialization":true}}' WHERE id=${f.orgId}::uuid`));
    await expect(f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]))).rejects.toThrow('interface_health_disabled');
    expect(await f.count()).toBe(0);
  });

  it('keeps telemetry and structural credentials in separate domains', async () => {
    const f = await fixture();
    const t = Date.now() - minute;
    const unregisterDiscovery = registerTopologyProducerAuthority('discovery', async () => ({ authorized: true, configurationGeneration: generation }));
    try {
      const structural = await f.scoped(() => resolveTopologyPhysicalProducer({ producerKind: 'discovery', deviceId: f.deviceId, scope: f.scope, authorityKey: TARGET }));
      // A structural epoch presented as telemetry fails the telemetry credential domain.
      const forged = { ...f.producer, producerEpoch: structural.producerEpoch, configurationRevision: structural.configurationRevision };
      await expect(f.persist(f.envelope(forged, '1', t, [f.sample(f.ifA, t)]), forged)).rejects.toThrow('producer_epoch_changed');
      await expect(f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]), structural as never)).rejects.toThrow('unsupported_producer');
      await expect(f.scoped(() => ingestTopologySourceReport(f.producer, { reportKind: 'unchanged', confirmation: {} as never }))).rejects.toThrow('unsupported_producer');
    } finally { unregisterDiscovery(); }
  });

  it('fences a rotated epoch, re-baselines the source and retains old-epoch samples', async () => {
    const f = await fixture();
    const t = Date.now() - 5 * minute;
    await f.persist(f.envelope(f.producer, '9', t, [f.sample(f.ifA, t)]));
    generation = 'arm-2';
    await expect(f.persist(f.envelope(f.producer, '10', t + minute, [f.sample(f.ifA, t + minute)]))).rejects.toThrow('producer_epoch_changed');
    const rotated = await f.resolve();
    expect(rotated.producerEpoch).not.toBe(f.producer.producerEpoch);
    expect(await f.persist(f.envelope(rotated, '1', t + minute, [f.sample(f.ifA, t + minute)]), rotated)).toMatchObject({ accepted: true, acceptedSequence: '1', inserted: 1 });
    expect(await f.count(sql`producer_epoch=${f.producer.producerEpoch}`)).toBe(1);
    expect(await f.count(sql`producer_epoch=${rotated.producerEpoch}`)).toBe(1);
    await f.scoped(() => db.transaction(() => revokeTopologyTelemetrySources(f.scope, { producerKind: 'snmp', authorityKey: TARGET })));
    expect(await f.persist(f.envelope(rotated, '2', t + 2 * minute, [f.sample(f.ifA, t + 2 * minute)]), rotated)).toMatchObject({ accepted: false, reason: 'source_revoked' });
  });

  it('fences the producer when its device moves and keeps the site history', async () => {
    const f = await fixture();
    const t = Date.now() - minute;
    await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]));
    const destination = await createSite({ orgId: f.orgId });
    await f.scoped(() => db.execute(sql`UPDATE devices SET site_id=${destination.id}::uuid WHERE id=${f.deviceId}::uuid`));
    await expect(f.persist(f.envelope(f.producer, '2', t + 1000, [f.sample(f.ifA, t + 1000)]))).rejects.toThrow('producer_epoch_changed');
    expect(await f.count(sql`site_id=${f.siteId}::uuid`)).toBe(1);
  });

  it('admits one in-flight batch per source', async () => {
    const f = await fixture();
    const t = Date.now() - minute;
    const key = topologyTelemetryInFlightLockKey(f.producer);
    const receipt = await getTestDb().transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, ${TOPOLOGY_TELEMETRY_INFLIGHT_LOCK_SEED}))`);
      return f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]));
    });
    expect(receipt).toMatchObject({ accepted: false, reason: 'batch_in_flight', retryAfterSeconds: 5 });
    expect(await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]))).toMatchObject({ accepted: true });
  });

  it('enforces the per-source sample quota without writing', async () => {
    const f = await fixture();
    const t = Date.now() - 2 * minute;
    const first = await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]));
    await getTestDb().execute(sql`UPDATE topology_collection_sources SET telemetry_window_samples=${TOPOLOGY_TELEMETRY_SOURCE_DAILY_SAMPLES} WHERE id=${first.sourceId!}::uuid`);
    expect(await f.persist(f.envelope(f.producer, '2', t + minute, [f.sample(f.ifA, t + minute)]))).toMatchObject({ accepted: false, reason: 'telemetry_quota_exceeded', retryAfterSeconds: 300 });
    const [source] = await getTestDb().execute(sql`SELECT quota_rejected_count, accepted_sequence::text AS seq FROM topology_collection_sources WHERE id=${first.sourceId!}::uuid`);
    expect(source).toEqual({ quota_rejected_count: 1, seq: '1' });
    expect(await f.count()).toBe(1);
  });

  it('is invisible to structural physical coverage', async () => {
    const f = await fixture();
    const t = Date.now() - minute;
    await f.persist(f.envelope(f.producer, '1', t, [f.sample(f.ifA, t)]));
    const coverage = await f.scoped(() => readGraphCoverage(db as never, f.scope, 'physical', true));
    expect(coverage).toEqual({ state: 'unknown', reasons: [expect.objectContaining({ code: 'no_collector' })] });
  });

  it('moves samples with a whole-org merge, readings intact', async () => {
    const f = await fixture();
    const t = Date.now() - minute;
    await f.persist(f.envelope(f.producer, UINT64_MAX, t, [f.sample(f.ifA, t)]));
    // Merge re-keys canonical identities; give the fixture graph real ones (topology-lifecycle precedent).
    await f.scoped(async () => {
      for (const [id, siteId] of [[f.nodeId, f.siteId], [f.targetNodeId, f.siteId], [f.nodeB, f.siteB]] as const) {
        await db.execute(sql`UPDATE topology_nodes SET identity_key=${canonicalIdentityKey({ orgId: f.orgId, siteId }, 'endpoint', id)} WHERE id=${id}::uuid`);
      }
      const [relationship] = await db.execute(sql`SELECT id FROM topology_relationships WHERE org_id=${f.orgId}::uuid`);
      const sourceKey = `manual:${relationship!.id}`;
      await db.execute(sql`UPDATE topology_relationships SET canonical_key=${canonicalIdentityKey(f.scope, 'attachment', sourceKey)},
        identity_material=${JSON.stringify({ version: 1, kind: 'attachment', sourceKey })}::jsonb WHERE id=${relationship!.id}::uuid`);
    });
    const survivor = await createOrganization({ partnerId: f.partnerId });
    await executeOrgMerge({ loserOrgId: f.orgId, survivorOrgId: survivor.id, partnerId: f.partnerId, performedBy: '00000000-0000-0000-0000-000000000000' });
    const rows = await withSystemDbAccessContext(() => db.select().from(topologyInterfaceSamples).where(and(eq(topologyInterfaceSamples.interfaceId, f.ifA))));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: survivor.id, siteId: f.siteId, sourceSequence: UINT64_MAX });
    expect((rows[0]!.readings as Record<string, unknown>).inOctets).toBe(base.inOctets);
  });
});

