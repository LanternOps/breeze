import './setup';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { normalizeFdbSection, type FdbRow } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { orgContext } from './topology-fixtures';
import { createSite } from './db-utils';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import {
  registerTopologyProducerAuthority, resolveTopologyPhysicalProducer, revokeTopologySources, type TopologyProducerAuthorityRequest,
} from '../../services/topology/collectionAuthority';
import { ingestTopologySourceReport } from '../../services/topology/collectionIngest';
import { publishTopologyBuild } from '../../services/topology/publish';
import type { AdjacencyTopologySnapshot, AuthenticatedTopologyProducer, NormalizedTopologyReport } from '../../services/topology/collectionTypes';

const TARGET = 'snmp:192.0.2.10';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lldpRow = (port: number, name = `sw-${port}`) => ({
  rowKey: `${port}.1`, timeMark: 100, remoteIndex: 1, localPort: { namespace: 'lldp_local' as const, value: String(port), resolvedInterfaceKey: null },
  remoteChassis: { subtype: 'mac_address', value: `02:00:00:00:01:${(port % 256).toString(16).padStart(2, '0')}` }, remotePort: { subtype: 'interface_name', value: `Gi0/${port}` },
  remoteSysName: name,
});
const fdbRow = (port: number, i: number): FdbRow => {
  const mac = `02:00:00:${port.toString(16).padStart(2, '0')}:00:${i.toString(16).padStart(2, '0')}`;
  return { rowKey: `default|700|${mac}|${port}`, bridgeContext: 'default', fdbId: 700, mac, bridgePort: port, ifIndex: 100 + port, status: 'learned', vlans: [10], vlanMapping: 'complete' };
};

let generation = 'gen-1';
let unregister: (() => void) | undefined;
const seen: TopologyProducerAuthorityRequest[] = [];
beforeEach(() => {
  generation = 'gen-1'; seen.length = 0;
  // Stand-in for Task 4b's dispatch-snapshot target authority.
  unregister = registerTopologyProducerAuthority('discovery', async request => {
    seen.push(request);
    return request.authorityKey === TARGET ? { authorized: true, configurationGeneration: generation } : { authorized: false, reason: 'target_not_dispatched' };
  });
});
afterEach(() => { unregister?.(); unregister = undefined; });

async function fixture() {
  const f = await topologyIngestFixture();
  const scope = { orgId: f.orgId, siteId: f.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId), fn);
  const resolve = () => scoped(() => resolveTopologyPhysicalProducer({ producerKind: 'discovery', deviceId: f.deviceId, scope, authorityKey: TARGET }));
  const producer = await resolve();
  const snapshot = (p: AuthenticatedTopologyProducer, section: AdjacencyTopologySnapshot['section'] | Record<string, unknown>, sequence: string, offsetMs: number): AdjacencyTopologySnapshot => {
    const withoutDigest: Record<string, unknown> = { contextKey: `${TARGET}/default`, ...(section as Record<string, unknown>) };
    const digest = sha([p.sourceIdentity, withoutDigest]);
    const finalSection = { ...withoutDigest, contentDigest: digest } as AdjacencyTopologySnapshot['section'];
    return {
      key: { protocol: finalSection.kind, contextKey: finalSection.contextKey, addressFamily: 'any' }, snapshotId: crypto.randomUUID(), producerEpoch: p.producerEpoch,
      sequence, capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 3600, contentDigest: digest,
      manifest: { contract: 'adjacency_v2', target: { sourceKey: TARGET, address: '192.0.2.10', zone: null },
        scopes: [{ kind: finalSection.kind === 'snmp_interfaces' ? 'interfaces' : finalSection.kind, contextKey: 'default', outcome: finalSection.outcome, rowCount: finalSection.rowCount, contentDigest: digest }] },
      section: finalSection,
    };
  };
  const lldp = (rows: ReturnType<typeof lldpRow>[], sequence: string, offsetMs: number, over: Record<string, unknown> = {}, p = producer) =>
    snapshot(p, { kind: 'lldp', outcome: 'complete', rowCount: rows.length, rows, ...over }, sequence, offsetMs);
  const ingest = (report: NormalizedTopologyReport, p: AuthenticatedTopologyProducer = producer) => scoped(() => ingestTopologySourceReport(p, report));
  const full = (s: AdjacencyTopologySnapshot, p: AuthenticatedTopologyProducer = producer) => ingest({ reportKind: 'full', snapshot: s }, p);
  const unchanged = (base: AdjacencyTopologySnapshot, sequence: string, offsetMs: number, over: Record<string, unknown> = {}, p = producer) => ingest({ reportKind: 'unchanged', confirmation: {
    key: base.key, producerEpoch: p.producerEpoch, snapshotId: crypto.randomUUID(), baseSnapshotId: base.snapshotId, sequence,
    capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 3600, contentDigest: base.contentDigest, ...over,
  } }, p);
  const source = (protocol: string) => scoped(async () => {
    const [row] = await db.execute(sql`SELECT * FROM topology_collection_sources WHERE org_id=${f.orgId}::uuid AND producer_kind='discovery' AND protocol=${protocol}`);
    return row as Record<string, any> | undefined;
  });
  const runs = () => scoped(async () => {
    const [row] = await db.execute(sql`SELECT count(*)::int AS n FROM topology_collection_runs r JOIN topology_collection_sources s ON s.id=r.source_id WHERE s.producer_kind='discovery' AND r.org_id=${f.orgId}::uuid`);
    return Number(row!.n);
  });
  const misses = async (protocol: string) => (await source(protocol))!.pending_misses as { active?: { rowKeys: string[] }[]; transitions?: { rowKeys: string[] }[] };
  const agent = { producer: f.producer, full: f.full, ingest: f.ingest };
  return { ...f, agent, scope, scoped, producer, resolve, lldp, snapshot, full, unchanged, source, runs, misses };
}

describe('physical source families through collection ingest (M2 Task 4a)', () => {
  it('admits LLDP and normalized FDB snapshots from a discovery producer under server-derived identity', async () => {
    const f = await fixture();
    expect(f.producer.sourceIdentity).toBe(`${f.orgId}:${f.siteId}:discovery:${f.deviceId}`);
    expect(seen[0]).toMatchObject({ producerKind: 'discovery', authorityKey: TARGET, device: { id: f.deviceId } });
    const lldp = await f.full(f.lldp([lldpRow(7), lldpRow(8)], '1', -1000));
    expect(lldp).toMatchObject({ accepted: true, acceptedSequence: '1' });
    const wire = { kind: 'fdb' as const, contextKey: `${TARGET}/default`, contentDigest: 'a'.repeat(64), outcome: 'complete' as const,
      rows: [...Array.from({ length: 3 }, (_, i) => fdbRow(7, i)), ...Array.from({ length: 20 }, (_, i) => fdbRow(9, i))], rowCount: 23 };
    const normalized = normalizeFdbSection(wire);
    const fdb = await f.full(f.snapshot(f.producer, normalized, '1', -1000));
    expect(fdb.accepted).toBe(true);
    const row = await f.source('fdb');
    expect(row!.current_baseline._knownKeys).toEqual(expect.arrayContaining(['shared_port|default|9', fdbRow(7, 0).rowKey]));
    expect(row!.current_baseline._knownKeys).toHaveLength(4);
    expect(await f.runs()).toBe(2);
    // The agent root's own token bucket is not spent by physical admission.
    const [root] = await f.scoped(() => db.execute(sql`SELECT admission_tokens FROM topology_collection_sources WHERE producer_kind='agent' AND protocol='envelope' AND producer_id=${f.deviceId}::uuid`));
    expect(Number(root!.admission_tokens)).toBe(2);
    // A raw (un-normalized) FDB section cannot reach retained state.
    const raw = { ...wire, rows: Array.from({ length: 20 }, (_, i) => fdbRow(11, i)), rowCount: 20 };
    await expect(f.full(f.snapshot(f.producer, raw as never, '2', 0))).rejects.toThrow('invalid_source_section');
  });

  it('confirms an unchanged report against the exact retained baseline without creating a run', async () => {
    const f = await fixture();
    const first = f.lldp([lldpRow(7)], '1', -600_000);
    await f.full(first);
    const before = await f.runs();
    expect((await f.unchanged(first, '2', 0)).accepted).toBe(true);
    expect(await f.runs()).toBe(before);
    expect((await f.source('lldp'))!.confirmed_sequence).toBe('2');
    for (const over of [{ baseSnapshotId: crypto.randomUUID() }, { contentDigest: 'b'.repeat(64) }, { key: { ...first.key, contextKey: `${TARGET}/vlan-9` } }]) {
      expect((await f.unchanged(first, '3', 0, over)).sourceReceipts[0]!.reason).toBe('full_snapshot_required');
    }
    expect((await f.unchanged(first, '3', 0, { producerEpoch: 'x' })).accepted).toBe(false);
    expect(await f.runs()).toBe(before);
  });

  it('never withdraws on a partial read after a complete one', async () => {
    const f = await fixture();
    await f.full(f.lldp([lldpRow(7), lldpRow(8)], '1', -1_800_000));
    const partial = f.lldp([lldpRow(7)], '2', -1_200_000, { outcome: 'partial', reasonCode: 'timeout' });
    expect((await f.full(partial)).accepted).toBe(true);
    expect((await f.unchanged(partial, '3', -600_000)).accepted).toBe(true);
    const state = await f.misses('lldp');
    expect(state.active ?? []).toEqual([]);
    expect(state.transitions ?? []).toEqual([]);
    expect((await f.source('lldp'))!.current_baseline._knownKeys).toEqual(expect.arrayContaining(['7.1', '8.1']));
  });

  it('records exactly one second-miss transition for complete-empty twice at least five minutes apart', async () => {
    const f = await fixture();
    await f.full(f.lldp([lldpRow(7), lldpRow(8)], '1', -1_800_000));
    const empty = f.lldp([], '2', -1_200_000);
    await f.full(empty);
    expect((await f.misses('lldp')).active).toHaveLength(1);
    // Too soon: 2 minutes after the first miss does not qualify.
    expect((await f.unchanged(empty, '3', -1_080_000)).accepted).toBe(true);
    expect((await f.misses('lldp')).transitions ?? []).toEqual([]);
    // Same empty body re-read >=5 minutes later qualifies once (full, same digest -> confirm).
    const again = { ...empty, snapshotId: crypto.randomUUID(), sequence: '4', capturedAt: new Date(Date.now() - 600_000).toISOString() };
    expect((await f.full(again)).accepted).toBe(true);
    expect((await f.unchanged(empty, '5', 0)).accepted).toBe(true);
    const state = await f.misses('lldp');
    expect(state.transitions).toHaveLength(1);
    expect(state.transitions![0]!.rowKeys.sort()).toEqual(['7.1', '8.1']);
    expect(state.active ?? []).toEqual([]);
    expect(await f.runs()).toBe(2);
  });

  it('rejects an over-capacity snapshot as a coverage gap without touching retained state', async () => {
    const f = await fixture();
    const small = f.lldp([lldpRow(7)], '1', -600_000);
    await f.full(small);
    const before = await f.source('lldp');
    const huge = f.lldp(Array.from({ length: 4000 }, (_, i) => lldpRow(i + 1, `${'n'.repeat(200)}-${i}`)), '2', 0);
    const result = await f.full(huge);
    expect(result).toMatchObject({ accepted: false, reason: 'snapshot_budget_exceeded', retryAfterSeconds: 300 });
    const after = await f.source('lldp');
    expect(after!.content_digest).toBe(before!.content_digest);
    expect(after!.base_snapshot_id).toBe(before!.base_snapshot_id);
    expect(after!.current_baseline).toEqual(before!.current_baseline);
    expect(after!.quota_rejected_count).toBe(1);
    expect(await f.runs()).toBe(1);
    // The retained baseline still confirms.
    expect((await f.unchanged(small, '3', 0)).accepted).toBe(true);
  });

  it('rejects forged identity, wrong kind or family, out-of-authority scopes and revoked sources', async () => {
    const f = await fixture();
    const first = f.lldp([lldpRow(7)], '1', -600_000);
    expect((await f.full(first)).accepted).toBe(true);
    await expect(f.full(f.lldp([lldpRow(7)], '2', 0), { ...f.producer, sourceIdentity: `${f.orgId}:${f.siteId}:agent:${f.deviceId}` })).rejects.toThrow('producer_identity_mismatch');
    await expect(f.full(f.lldp([lldpRow(7)], '2', 0), { ...f.producer, producerKind: 'unifi' })).rejects.toThrow('producer_identity_mismatch');
    await expect(f.full(f.lldp([lldpRow(7)], '2', 0), { ...f.producer, producerKind: 'snmp' })).rejects.toThrow('unsupported_producer');
    await expect(f.full(f.lldp([lldpRow(7)], '2', 0), { ...f.producer, producerEpoch: 'forged' })).rejects.toThrow('producer_epoch_changed');
    await expect(f.full(f.lldp([lldpRow(7)], '2', 0), { ...f.producer, authorityKey: 'snmp:192.0.2.99' })).rejects.toThrow('producer_authority_denied');
    // The agent producer cannot write physical families; discovery cannot write OS context.
    await expect(f.full(f.lldp([lldpRow(7)], '2', 0), f.agent.producer)).rejects.toThrow('unsupported_source_family');
    const outside = f.lldp([lldpRow(7)], '2', 0);
    await expect(f.full({ ...outside, key: { ...outside.key, contextKey: 'snmp:192.0.2.99/default' }, section: { ...outside.section, contextKey: 'snmp:192.0.2.99/default' } })).rejects.toThrow('source_outside_authority');

    // Controller remap / target de-authorization revokes; the same epoch stays fenced.
    expect(await f.scoped(() => revokeTopologySources(f.scope, { producerKind: 'discovery', authorityKey: TARGET }))).toBe(1);
    expect((await f.full(f.lldp([lldpRow(8)], '2', 0))).sourceReceipts[0]!.reason).toBe('source_revoked');
    expect((await f.unchanged(first, '2', 0)).sourceReceipts[0]!.reason).toBe('source_revoked');
    // Re-authorization under a new generation rotates the epoch and re-baselines.
    generation = 'gen-2';
    await expect(f.full(f.lldp([lldpRow(8)], '2', 0))).rejects.toThrow('producer_epoch_changed');
    const reauthorized = await f.resolve();
    expect(reauthorized.producerEpoch).not.toBe(f.producer.producerEpoch);
    expect((await f.full(f.lldp([lldpRow(8)], '1', 0, {}, reauthorized), reauthorized)).accepted).toBe(true);

    // Default-deny once the kind's authority check is gone.
    unregister!(); unregister = undefined;
    await expect(f.full(f.lldp([lldpRow(8)], '2', 1000, {}, reauthorized), reauthorized)).rejects.toThrow('producer_authority_unavailable');
  });

  it('revokes physical sources when the collecting device moves, in every affected site', async () => {
    const f = await fixture();
    await f.full(f.lldp([lldpRow(7)], '1', -1000));
    const other = await createSite({ orgId: f.orgId });
    await f.scoped(() => db.execute(sql`UPDATE devices SET site_id=${other.id}::uuid WHERE id=${f.deviceId}::uuid`));
    expect((await f.source('lldp'))!.revoked_at).not.toBeNull();
    await expect(f.full(f.lldp([lldpRow(7)], '2', 0))).rejects.toThrow();
  });

  it('keeps heartbeat context disappearance and agent budgets away from physical sources', async () => {
    const f = await fixture();
    const lldp = f.lldp([lldpRow(7)], '1', -1000);
    await f.full(lldp);
    const before = await f.source('lldp');
    expect((await f.agent.ingest(f.agent.full('1', -500))).accepted).toBe(true);
    const [agentLldp] = await f.scoped(() => db.execute(sql`SELECT count(*)::int AS n FROM topology_collection_sources WHERE org_id=${f.orgId}::uuid AND producer_kind='agent' AND protocol='lldp'`));
    expect(Number(agentLldp!.n)).toBe(0);
    const after = await f.source('lldp');
    expect(after!.accepted_sequence).toBe(before!.accepted_sequence);
    expect(after!.current_baseline).toEqual(before!.current_baseline);
    expect(after!.revoked_at).toBeNull();
  });

  it('publishes a physical source through the physical projector and checkpoints its row mapping', async () => {
    const f = await fixture();
    await f.full(f.lldp([lldpRow(7)], '1', -1000));
    const published = await f.scoped(async () => {
      const [state] = await db.execute(sql`SELECT build_fence::text,dirty_revision::text FROM topology_site_state WHERE org_id=${f.orgId}::uuid AND site_id=${f.siteId}::uuid`);
      return publishTopologyBuild(f.scope, { buildFence: String(state!.build_fence), inputRevision: String(state!.dirty_revision), nodes: [], relationships: [], bindings: [] });
    });
    expect(published.published).toBe(true);
    const row = await f.source('lldp');
    expect(row!.materialized_sequence).toBe('1');
    // No inventory for the target or neighbour: one candidate on scoped unbound nodes (Task 6).
    expect(Object.keys(row!.published_baseline._rowRelationships)).toEqual(['7.1']);
    expect(row!.published_baseline._rowRelationships['7.1']).toHaveLength(1);
  });
});
