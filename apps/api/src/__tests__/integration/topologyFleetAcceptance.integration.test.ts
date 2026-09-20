import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NetworkContextFull } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { orgContext } from './topology-fixtures';
import { seedTopologyFleetFixture, type TopologyFleetFixture } from '../helpers/topologyFleet';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';

/**
 * Fleet release gate for M1 collection. Every case drives the real
 * negotiate/ingest/publish/retention seam; only the fleet SIZE is scaled down
 * by default (`TOPOLOGY_FLEET_SCALE=full` restores the plan's 100x100 / 288
 * round shape). The invariants are identical at both scales.
 */
const SECTIONS_PER_PRODUCER = 5;
const withForbidden = <T>(f: TopologyFleetFixture, fn: () => Promise<T>) =>
  withDbAccessContext(orgContext(f.forbidden.orgId), fn);
const routeMetric = (metric: number) => (report: NetworkContextFull) => {
  const routes = report.sections.find((section) => section.kind === 'routes')!;
  if (routes.kind === 'routes') routes.rows[0]!.metric = metric;
};

afterEach(() => { vi.useRealTimers(); });

describe('topology fleet acceptance', () => {
  it('retains compact current truth after raw retention without per-tick history', async () => {
    const f: TopologyFleetFixture = await seedTopologyFleetFixture('I10K', 'topology-v1');
    const producers = f.producers.length;
    await f.ingestInitialAndPublish();

    const baseline = await f.rowCounts();
    expect(baseline.runs).toBe(producers * SECTIONS_PER_PRODUCER);
    expect(baseline.observations).toBeGreaterThan(0);
    expect(baseline.relationships).toBeGreaterThan(0);

    // A full revalidation whose content is identical appends NO history at all.
    await f.confirmAll({ rounds: f.scale.rounds, intervalSeconds: 300 });
    expect(await f.rowCounts()).toMatchObject({ runs: baseline.runs, observations: baseline.observations });

    f.advanceClock({ days: 31 });
    await f.confirmAll({ rounds: 1, intervalSeconds: 300 });
    expect(await f.expireRawEvidence()).toBe(baseline.runs);

    expect(await f.compactCurrentSourceCount()).toBe(producers);
    expect(await f.sampleCurrentSupport()).toMatchObject({ freshness: 'fresh', lifecycle: 'active' });
    const after = await f.rowCounts();
    expect(after.runs).toBe(0);
    expect(after.relationships).toBe(baseline.relationships);
    expect(after.support).toBe(baseline.support);
  });

  it('keeps a second tenant reporting the same addresses out of every fleet count', async () => {
    const f = await seedTopologyFleetFixture('I10K', 'topology-v1');
    await f.ingestInitialAndPublish();
    const fleet = await f.rowCounts();
    expect(fleet.runs).toBe(f.producers.length * SECTIONS_PER_PRODUCER);
    // The fleet org's RLS context cannot see the other tenant's evidence at all,
    // even though its addresses, prefixes and gateway are identical.
    const [leaked] = await f.scoped(() => db.execute(sql`SELECT count(*)::int AS count FROM topology_collection_runs
      WHERE org_id=${f.forbidden.orgId}::uuid`));
    expect(Number(leaked!.count)).toBe(0);
    const [own] = await withForbidden(f, () => db.execute(sql`SELECT count(*)::int AS count FROM topology_collection_runs`));
    expect(Number(own!.count)).toBe(SECTIONS_PER_PRODUCER);
  });

  it('withdraws on the identical-empty second miss and leaves siblings untouched', async () => {
    const f = await seedTopologyFleetFixture('I10K', 'topology-v1', { siteCount: 1, agentsPerSite: 2 });
    await f.ingestInitialAndPublish();
    const [noisy, quiet] = f.producers;
    const before = await f.rowCounts();

    f.advanceClock({ seconds: 600 });
    const emptied = await f.ingestFull(noisy!, { edit: (report) => {
      const routes = report.sections.find((section) => section.kind === 'routes')!;
      if (routes.kind === 'routes') { routes.rows = []; routes.rowCount = 0; }
    } });
    expect(emptied.accepted).toBe(true);
    await f.publishAll();
    expect((await f.relationshipsFor(noisy!)).find((row) => row.kind === 'default_route')?.lifecycle).toBe('active');

    // The second complete read with the identical empty body qualifies the miss
    // without appending a run; the withdrawal is published from compact state.
    f.advanceClock({ seconds: 600 });
    const afterMiss = await f.rowCounts();
    expect((await f.ingest(noisy!, f.unchangedReport(noisy!))).accepted).toBe(true);
    expect((await f.rowCounts()).runs).toBe(afterMiss.runs);
    await f.publishAll();
    expect((await f.relationshipsFor(noisy!)).find((row) => row.kind === 'default_route')?.lifecycle).toBe('withdrawn');

    // A qualified streak is consumed, so repeating the confirmation is a no-op.
    f.advanceClock({ seconds: 600 });
    expect((await f.ingest(noisy!, f.unchangedReport(noisy!))).accepted).toBe(true);
    await f.publishAll();
    expect((await f.rowCounts()).runs).toBe(afterMiss.runs);
    expect((await f.relationshipsFor(quiet!)).every((row) => row.lifecycle === 'active')).toBe(true);
    expect(await f.rowCounts()).toMatchObject({ observations: afterMiss.observations });
    expect(before.runs).toBeLessThan(afterMiss.runs);
  });

  it('rejects and coalesces a noisy producer over quota without touching history', async () => {
    const f = await seedTopologyFleetFixture('I10K', 'topology-v1', { siteCount: 1, agentsPerSite: 2 });
    await f.ingestInitialAndPublish();
    const [noisy] = f.producers;
    const accepted = await f.rowCounts();

    const reasons: (string | undefined)[] = [];
    let lastRejectedSnapshot = '';
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      f.advanceClock({ seconds: 30 });
      const report = f.fullReport(noisy!, { edit: routeMetric(200 + attempt) });
      const receipt = await f.ingest(noisy!, report);
      reasons.push(receipt.sourceReceipts.find((entry) => !entry.accepted)?.reason ?? receipt.reason);
      if (receipt.accepted) { noisy!.baseSnapshotId = report.snapshotId; noisy!.contentDigest = report.contentDigest; }
      else lastRejectedSnapshot = report.snapshotId;
    }
    expect(reasons).toContain('snapshot_budget_exceeded');

    const rejected = reasons.filter((reason) => reason === 'snapshot_budget_exceeded').length;
    expect(rejected).toBeGreaterThan(1);
    const state = await f.sourceState(noisy!, 'routes');
    expect(Number(state.quota_rejected_count)).toBeGreaterThan(0);
    // An unresolved miss streak cannot survive a quota gap it never observed.
    expect((state.pending_misses as { active?: unknown[] }).active ?? []).toEqual([]);

    const root = await f.sourceState(noisy!, 'envelope');
    expect(root.has_retry).toBe(true);
    const [candidate] = await f.scoped(() => db.execute(sql`SELECT retry_candidate->>'snapshotId' AS snapshot_id
      FROM topology_collection_sources WHERE org_id=${f.orgId}::uuid AND producer_id=${noisy!.deviceId}::uuid AND protocol='envelope'`));
    // Coalesced: one retry candidate, the latest rejection, not a queue of them.
    expect(candidate!.snapshot_id).toBe(lastRejectedSnapshot);

    // Only the section whose content actually changed appends history; the four
    // unchanged sections of an accepted report confirm in place, and every
    // rejected report appends nothing at all.
    const counts = await f.rowCounts();
    expect(counts.runs).toBe(accepted.runs + (reasons.length - rejected));
  });

  it('keeps a quiet producer route stable while a neighbor burns its change quota', async () => {
    const f = await seedTopologyFleetFixture('I10K', 'topology-v1', { siteCount: 1, agentsPerSite: 2 });
    await f.ingestInitialAndPublish();
    const [noisy, quiet] = f.producers;
    const quietBefore = await f.relationshipsFor(quiet!);
    expect(quietBefore.length).toBeGreaterThan(0);

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      f.advanceClock({ seconds: 30 });
      await f.ingest(noisy!, f.fullReport(noisy!, { edit: routeMetric(300 + attempt) }));
      const confirmation = await f.ingest(quiet!, f.unchangedReport(quiet!));
      expect(confirmation.accepted).toBe(true);
    }
    await f.publishAll();

    const quietAfter = await f.relationshipsFor(quiet!);
    expect(quietAfter.map((row) => [row.kind, row.lifecycle, row.support_count]))
      .toEqual(quietBefore.map((row) => [row.kind, row.lifecycle, row.support_count]));
    expect(quietAfter.every((row) => row.lifecycle === 'active')).toBe(true);
    expect(await f.sampleCurrentSupport()).toMatchObject({ freshness: 'fresh', lifecycle: 'active' });
  });

  it('refuses an unauthorized epoch reset and withdraws a rotated producer evidence', async () => {
    const f = await seedTopologyFleetFixture('I10K', 'topology-v1', { siteCount: 1, agentsPerSite: 2 });
    await f.ingestInitialAndPublish();
    const [victim] = f.producers;
    const baseline = await f.rowCounts();

    // A forged previous epoch is not a reset request.
    const forged = await f.scoped(() => negotiateTopologyContext(victim!.deviceId, { previousEpoch: crypto.randomUUID() }));
    expect(forged.producerEpoch).toBe(victim!.producerEpoch);
    expect(forged.epochFreshlyIssued).toBe(false);
    // Neither is a correct epoch replayed inside the reset cooldown.
    const early = await f.scoped(() => negotiateTopologyContext(victim!.deviceId, { previousEpoch: victim!.producerEpoch }));
    expect(early.producerEpoch).toBe(victim!.producerEpoch);
    expect(early.epochFreshlyIssued).toBe(false);
    expect(await f.rowCounts()).toMatchObject({ runs: baseline.runs });

    // A real credential rotation does issue a new epoch; the old producer's
    // evidence is fenced out rather than being replayed into the graph.
    await f.scoped(() => db.execute(sql`UPDATE devices SET agent_token_hash=${'b'.repeat(64)} WHERE id=${victim!.deviceId}::uuid`));
    const rotated = await f.scoped(() => negotiateTopologyContext(victim!.deviceId));
    expect(rotated.producerEpoch).not.toBe(victim!.producerEpoch);

    f.advanceClock({ seconds: 600 });
    await expect(f.ingest(victim!, f.fullReport(victim!, { edit: routeMetric(999) }))).rejects.toThrow('producer_epoch_changed');
    await expect(f.ingest(victim!, f.unchangedReport(victim!))).rejects.toThrow('producer_epoch_changed');
    expect(await f.rowCounts()).toMatchObject({ runs: baseline.runs });

    await f.publishAll();
    expect((await f.relationshipsFor(victim!)).every((row) => row.lifecycle === 'withdrawn')).toBe(true);
    expect((await f.relationshipsFor(f.producers[1]!)).every((row) => row.lifecycle === 'active')).toBe(true);
  });
});
