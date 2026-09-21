/**
 * Fleet-scale ingestion fixture built on the REAL collection seam
 * (negotiate -> ingest -> publish -> retention). Sources are bulk seeded, but
 * every admission, confirmation and publication runs the production code path.
 *
 * Scale is parameterized: the default is a small fleet that keeps the blocking
 * Integration Tests job fast, and `TOPOLOGY_FLEET_SCALE=full` runs the plan's
 * I10K shape (100 sites x 100 agents). The invariants asserted are identical at
 * both scales; only the row budgets scale with the producer count.
 */
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { TOPOLOGY_FIXTURE_SEED, topologyIngestFixture } from '../../../../../packages/shared/src/testing/topologyFleet';
import type { NetworkContextFull } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from '../integration/db-utils';
import { orgContext } from '../integration/topology-fixtures';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import { expireTopologyEvidence } from '../../services/topology/collectionRetention';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import { publishTopologyBuild } from '../../services/topology/publish';

export type TopologyFleetScale = { siteCount: number; agentsPerSite: number; rounds: number; full: boolean };
/**
 * `TOPOLOGY_FLEET_SCALE=full` selects the plan's I10K/288-round shape. That is
 * the SOAK shape (10,000 producers x 288 rounds is millions of transactions,
 * hours of wall clock) and is not meant for the blocking CI job — use
 * `scripts/topology/ingest-soak.ts` for it. `TOPOLOGY_FLEET_SITES` /
 * `_AGENTS` / `_ROUNDS` dial an intermediate scale for local investigation.
 */
export function topologyFleetScale(): TopologyFleetScale {
  const full = process.env.TOPOLOGY_FLEET_SCALE === 'full';
  const base = full ? { siteCount: 100, agentsPerSite: 100, rounds: 288 } : { siteCount: 2, agentsPerSite: 3, rounds: 6 };
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    siteCount: read('TOPOLOGY_FLEET_SITES', base.siteCount),
    agentsPerSite: read('TOPOLOGY_FLEET_AGENTS', base.agentsPerSite),
    rounds: read('TOPOLOGY_FLEET_ROUNDS', base.rounds),
    full,
  };
}

export type FleetProducer = AuthenticatedTopologyProducer & {
  producerIndex: number; siteIndex: number; siteId: string; deviceId: string; nodeId: string;
  jitterSeconds: number; sequence: bigint; baseSnapshotId: string; contentDigest: string;
};

const scoped = <T>(orgId: string, fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
const hex = (value: number) => value.toString(16).padStart(64, '0');
/** RFC 2544 benchmarking space: never routed, never a production default. */
const address = (siteIndex: number, agentIndex: number) => `198.18.${siteIndex % 256}.${(agentIndex % 240) + 10}`;
const gateway = (siteIndex: number) => `198.18.${siteIndex % 256}.1`;

async function seedTenant(siteCount: number) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const sites: string[] = [];
  for (let index = 0; index < siteCount; index += 1) sites.push((await createSite({ orgId: org.id })).id);
  await scoped(org.id, () => db.execute(
    sql`UPDATE organizations SET settings='{"topologyFeatureFlags":{"materialization":true}}' WHERE id=${org.id}::uuid`));
  return { partnerId: partner.id, orgId: org.id, sites };
}

async function seedProducerRows(orgId: string, rows: { deviceId: string; nodeId: string; siteId: string; index: number }[]) {
  await scoped(orgId, async () => {
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200);
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash) VALUES ${
        sql.join(batch.map((row) => sql`(${row.deviceId}::uuid,${orgId}::uuid,${row.siteId}::uuid,${row.deviceId},${`fleet-${row.index}`},'linux','1','amd64','1',${hex(row.index + 1)})`), sql`,`)}`);
      await db.execute(sql`INSERT INTO topology_nodes (id,org_id,site_id,identity_key,identity_material,kind) VALUES ${
        sql.join(batch.map((row) => sql`(${row.nodeId}::uuid,${orgId}::uuid,${row.siteId}::uuid,${row.nodeId},${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: row.nodeId })}::jsonb,'endpoint')`), sql`,`)}`);
      await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,device_id) VALUES ${
        sql.join(batch.map((row) => sql`(${orgId}::uuid,${row.siteId}::uuid,${row.nodeId}::uuid,${row.deviceId}::uuid)`), sql`,`)}`);
    }
  });
}

export type TopologyFleetFixture = Awaited<ReturnType<typeof seedTopologyFleetFixture>>;

export async function seedTopologyFleetFixture(name: 'I10K' = 'I10K', seed: string = TOPOLOGY_FIXTURE_SEED,
  overrides?: Partial<TopologyFleetScale>) {
  const scale = { ...topologyFleetScale(), ...overrides };
  const spec = topologyIngestFixture(name, seed, scale);
  const tenant = await seedTenant(scale.siteCount);
  const rows = spec.agents.map((agent) => ({
    index: agent.producerIndex, siteId: tenant.sites[agent.siteIndex]!,
    deviceId: crypto.randomUUID(), nodeId: crypto.randomUUID(),
  }));
  await seedProducerRows(tenant.orgId, rows);

  // A second tenant that reports the SAME address ranges. Nothing it publishes
  // may ever appear in a fleet-scoped count, read or retention sweep.
  const forbidden = await seedTenant(1);
  const forbiddenRow = { index: 0, siteId: forbidden.sites[0]!, deviceId: crypto.randomUUID(), nodeId: crypto.randomUUID() };
  await seedProducerRows(forbidden.orgId, [forbiddenRow]);

  const clock = { now: new Date() };
  vi.useFakeTimers({ toFake: ['Date'], now: clock.now });

  async function negotiate(orgId: string, siteId: string, row: { deviceId: string; nodeId: string; index: number },
    siteIndex: number): Promise<FleetProducer> {
    const config = await scoped(orgId, () => negotiateTopologyContext(row.deviceId));
    if (!('producerEpoch' in config) || !config.producerEpoch) throw new Error('fleet fixture capability disabled');
    return {
      scope: { orgId, siteId }, producerId: row.deviceId, producerKind: 'agent',
      producerEpoch: config.producerEpoch, configurationRevision: config.configurationRevision!,
      sourceIdentity: config.sourceIdentity!, producerIndex: row.index, siteIndex, siteId,
      deviceId: row.deviceId, nodeId: row.nodeId,
      jitterSeconds: spec.agents[row.index]?.jitterSeconds ?? 0,
      sequence: 0n, baseSnapshotId: '', contentDigest: '',
    };
  }
  const producers: FleetProducer[] = [];
  for (const row of rows) producers.push(await negotiate(tenant.orgId, row.siteId,
    row, spec.agents[row.index]!.siteIndex));
  const forbiddenProducer = await negotiate(forbidden.orgId, forbiddenRow.siteId, forbiddenRow, 0);

  /** A full report for one producer: site/agent addressing, optional mutation. */
  function fullReport(producer: FleetProducer, options: { variant?: number; edit?: (report: NetworkContextFull) => void } = {}): NetworkContextFull {
    const report = networkContextFixture();
    const local = address(producer.siteIndex, producer.producerIndex % 240);
    const via = gateway(producer.siteIndex);
    const interfaces = report.sections.find((section) => section.kind === 'interfaces')!;
    const routes = report.sections.find((section) => section.kind === 'routes')!;
    const resolvers = report.sections.find((section) => section.kind === 'resolvers')!;
    interfaces.rows[0]!.addresses = [{ ...interfaces.rows[0]!.addresses[0]!, address: local }];
    routes.rows[0]!.nextHops = [{ ...routes.rows[0]!.nextHops[0]!, address: via }];
    routes.rows[0]!.metric = 100 + (options.variant ?? 0);
    resolvers.rows[0]!.address = via;
    producer.sequence += 1n;
    Object.assign(report, {
      producerEpoch: producer.producerEpoch, sequence: producer.sequence.toString(),
      snapshotId: crypto.randomUUID(),
      capturedAt: new Date(Date.now() - producer.jitterSeconds * 1000).toISOString(),
      captureAgeAtSendMs: producer.jitterSeconds * 1000, expectedIntervalSeconds: spec.cadenceSeconds,
    });
    options.edit?.(report);
    for (const section of report.sections) section.contentDigest = topologySectionDigest(report, section, producer.sourceIdentity);
    report.contentDigest = topologyContextDigest(report, producer.sourceIdentity);
    return report;
  }
  function unchangedReport(producer: FleetProducer) {
    producer.sequence += 1n;
    return {
      version: 1, reportKind: 'unchanged' as const, producerEpoch: producer.producerEpoch,
      sequence: producer.sequence.toString(), snapshotId: crypto.randomUUID(), baseSnapshotId: producer.baseSnapshotId,
      capturedAt: new Date(Date.now() - producer.jitterSeconds * 1000).toISOString(),
      captureAgeAtSendMs: producer.jitterSeconds * 1000, expectedIntervalSeconds: spec.cadenceSeconds,
      contentDigest: producer.contentDigest,
    };
  }
  const ingest = (producer: FleetProducer, payload: unknown) =>
    scoped(producer.scope.orgId, () => ingestTopologyNetworkContext(producer, payload));

  async function ingestFull(producer: FleetProducer, options: { variant?: number; edit?: (report: NetworkContextFull) => void } = {}) {
    const report = fullReport(producer, options);
    const receipt = await ingest(producer, report);
    if (receipt.accepted) { producer.baseSnapshotId = report.snapshotId; producer.contentDigest = report.contentDigest; }
    return receipt;
  }
  const publishSite = (orgId: string, siteId: string) => scoped(orgId, async () => {
    const [state] = await db.execute(sql`SELECT build_fence::text,dirty_revision::text FROM topology_site_state
      WHERE org_id=${orgId}::uuid AND site_id=${siteId}::uuid`);
    return publishTopologyBuild({ orgId, siteId }, { buildFence: String(state!.build_fence),
      inputRevision: String(state!.dirty_revision), nodes: [], relationships: [], bindings: [] });
  });
  const publishAll = async () => { for (const siteId of tenant.sites) await publishSite(tenant.orgId, siteId); };

  return {
    ...tenant, scale, spec, producers, sites: tenant.sites,
    forbidden: { ...forbidden, producer: forbiddenProducer },
    clock,
    fullReport, unchangedReport, ingest, ingestFull, publishSite, publishAll,
    scoped: <T>(fn: () => Promise<T>) => scoped(tenant.orgId, fn),
    restoreClock: () => vi.useRealTimers(),
    advanceClock({ days = 0, seconds = 0 }: { days?: number; seconds?: number }) {
      clock.now = new Date(clock.now.getTime() + days * 86_400_000 + seconds * 1000);
      vi.setSystemTime(clock.now);
    },
    async ingestInitialAndPublish() {
      for (const producer of producers) {
        const receipt = await ingestFull(producer);
        if (!receipt.accepted) throw new Error(`fleet baseline rejected: ${receipt.reason}`);
      }
      const receipt = await ingestFull(forbiddenProducer);
      if (!receipt.accepted) throw new Error(`forbidden baseline rejected: ${receipt.reason}`);
      await publishAll();
      await publishSite(forbidden.orgId, forbidden.sites[0]!);
    },
    /** Identical-content full revalidation for every producer, `rounds` times. */
    async confirmAll({ rounds, intervalSeconds }: { rounds: number; intervalSeconds: number }) {
      for (let round = 0; round < rounds; round += 1) {
        this.advanceClock({ seconds: intervalSeconds });
        for (const producer of producers) {
          const receipt = await ingest(producer, unchangedReport(producer));
          if (!receipt.accepted) throw new Error(`fleet confirmation rejected: ${receipt.reason}`);
        }
      }
    },
    rowCounts: () => scoped(tenant.orgId, async () => {
      const [row] = await db.execute(sql`SELECT
        (SELECT count(*)::int FROM topology_collection_runs WHERE org_id=${tenant.orgId}::uuid) AS runs,
        (SELECT count(*)::int FROM topology_observations WHERE org_id=${tenant.orgId}::uuid) AS observations,
        (SELECT count(*)::int FROM topology_relationships WHERE org_id=${tenant.orgId}::uuid) AS relationships,
        (SELECT count(*)::int FROM topology_relationship_support WHERE org_id=${tenant.orgId}::uuid) AS support`);
      return { runs: Number(row!.runs), observations: Number(row!.observations),
        relationships: Number(row!.relationships), support: Number(row!.support) };
    }),
    /** Raw detail expiry to exhaustion (the service deletes 500 runs per call). */
    async expireRawEvidence() {
      let deleted = 0;
      for (const siteId of tenant.sites) {
        for (;;) {
          // The retention worker's own context: only a system scope can tell a
          // deleted producer from one that merely moved (collectionRetention.ts).
          const result = await runOutsideDbContext(() => withSystemDbAccessContext(
            () => expireTopologyEvidence({ orgId: tenant.orgId, siteId }, clock.now)));
          deleted += result.deletedDetails;
          if (!result.deletedDetails) break;
        }
      }
      return deleted;
    },
    /** Producers whose compact current truth survived retention. */
    compactCurrentSourceCount: () => scoped(tenant.orgId, async () => {
      const [row] = await db.execute(sql`SELECT count(*)::int AS count FROM topology_collection_sources
        WHERE org_id=${tenant.orgId}::uuid AND protocol='envelope' AND content_digest IS NOT NULL AND revoked_at IS NULL`);
      return Number(row!.count);
    }),
    /**
     * Current support truth, not the last published timestamp: a source that
     * still confirms the digest behind a support row carries that row's
     * freshness forward — the same rule `queueTopologyAging` archives by.
     */
    sampleCurrentSupport: () => scoped(tenant.orgId, async () => {
      const [row] = await db.execute(sql`SELECT s.lifecycle,
          GREATEST(s.fresh_until, CASE WHEN src.producer_epoch=s.producer_epoch AND src.content_digest=s.content_digest
            AND src.published_digest=s.content_digest AND src.last_outcome IN ('complete','partial')
            THEN src.fresh_until ELSE s.fresh_until END) AS fresh_until
        FROM topology_relationship_support s
        JOIN topology_collection_sources src ON src.id=s.source_id AND src.org_id=s.org_id AND src.site_id=s.site_id
        WHERE s.org_id=${tenant.orgId}::uuid ORDER BY s.relationship_id LIMIT 1`);
      if (!row) return { freshness: 'unknown', lifecycle: 'missing' };
      return { freshness: new Date(String(row.fresh_until)).getTime() > clock.now.getTime() ? 'fresh' : 'stale',
        lifecycle: String(row.lifecycle) };
    }),
    relationshipsFor: (producer: FleetProducer) => scoped(producer.scope.orgId, () => db.execute(
      sql`SELECT r.kind,r.lifecycle,r.support_count::text AS support_count FROM topology_relationships r
        JOIN topology_node_bindings b ON b.node_id=r.source_node_id AND b.org_id=r.org_id
        WHERE r.org_id=${producer.scope.orgId}::uuid AND r.site_id=${producer.siteId}::uuid
          AND b.device_id=${producer.deviceId}::uuid AND r.attributes->>'method'='os_network_context'
        ORDER BY r.kind`)),
    sourceState: (producer: FleetProducer, protocol = 'routes') => scoped(producer.scope.orgId, async () => {
      const [row] = await db.execute(sql`SELECT quota_rejected_count::int AS quota_rejected_count,pending_misses,
        retry_candidate IS NOT NULL AS has_retry,content_digest,accepted_sequence
        FROM topology_collection_sources WHERE org_id=${producer.scope.orgId}::uuid AND producer_id=${producer.deviceId}::uuid
          AND protocol=${protocol} LIMIT 1`);
      return row!;
    }),
  };
}
