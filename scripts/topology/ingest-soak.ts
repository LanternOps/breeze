/**
 * Topology collection ingest soak harness (M1 gate, spec §"I10K soak").
 *
 * Drives the REAL production seams against a DISPOSABLE test database, using
 * the deterministic `I10K` fleet shape:
 *   - producers negotiate and ingest through `negotiateTopologyContext` /
 *     `ingestTopologyNetworkContext`, each on its own fixture jitter offset
 *     inside the cadence window, with up to `--concurrency` in flight (a real
 *     fleet does not queue behind one connection);
 *   - every site is brought to publishable state through the real legacy
 *     backfill (`importLegacyTopologySite`), exactly as an operator enables it;
 *   - publication is done ONLY by the production reconcile worker tick
 *     (`runTopologyReconcileTick`) on its production 2s interval — the harness
 *     never calls `publishTopologyBuild` itself.
 *
 * Measured (and gated, per the spec):
 *   - accepted-change -> publication latency: from just before the accepted
 *     ingest call until the site's `materialized_input_revision` covers the
 *     revision that ingest produced. Pass: p95 <= 10s, p99 <= 30s.
 *   - lost accepted transitions: changes whose revision is still unpublished
 *     after the post-deadline drain window, plus unmaterialized runs. Pass: 0.
 *   - unchanged-history inserts: runs carrying an unchanged confirmation's
 *     snapshot id, and observations inserted in a round for runs created
 *     before the PREVIOUS round began. Observations are written when the
 *     worker publishes (seconds after ingest), so a late change's rows can
 *     legitimately land in the next round; anything older can only come from
 *     re-recording history on a confirmation. Pass: 0.
 *   - send lag: how late each producer's send starts versus its scheduled
 *     jitter slot. A lag above 10% of the round means the harness (or the
 *     database) did not sustain the I10K rate, so the run is not evidence.
 *     Pass: max lag <= 10% of the round.
 *
 * Safety:
 *   - It refuses to start unless BOTH database URLs pass the integration
 *     test-database guard (breeze_test* name, local host allowlist, non-5432
 *     port, explicit test opt-in). There is no flag to bypass that.
 *   - It performs NO network I/O of any kind beyond the Postgres connection:
 *     it never contacts an enrolled agent, an API host or an external service.
 *     The producers it drives are rows it created itself in the test database.
 *
 * Usage (from the repo root, with `pnpm test-stack up` already running):
 *   pnpm --filter @breeze/api exec tsx ../../scripts/topology/ingest-soak.ts \
 *     --fixture I10K --duration-hours 24 --seed topology-v1 \
 *     --output ../../test-results/topology-soak.json
 * `--duration-hours` counts steady-state rounds only; bootstrap is extra.
 *
 * Smoke-sized run (a few minutes, a handful of producers, compressed rounds):
 *   ... --duration-hours 0.05 --sites 2 --agents 3 --round-seconds 20 --change-period 3
 *
 * Checkpointing: the output file is rewritten (atomically) after bootstrap and
 * after every round with `status: "running"`, so a run that dies at hour 13
 * still leaves 13 hours of evidence. A signal, uncaught exception or failed
 * main() rewrites it with `status: "aborted"` and the reason; only a run that
 * reaches its deadline writes `status: "completed"` (with `passed`).
 */
import '../../apps/api/src/__tests__/integration/loadEnv';

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { sql } from 'drizzle-orm';
import { TOPOLOGY_FIXTURE_SEED, topologyIngestFixture } from '../../packages/shared/src/testing/topologyFleet';
import { networkContextFixture } from '../../packages/shared/src/testing/topologyFixtures';
import type { NetworkContextFull } from '../../packages/shared/src/index';
import { assertTestDatabaseUrlSafe } from '../../apps/api/src/testUtils/integrationDatabaseSafety';
import { closeDb, db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../apps/api/src/db';
import { negotiateTopologyContext } from '../../apps/api/src/services/topology/collectionAuthority';
import { topologyContextDigest, topologySectionDigest } from '../../apps/api/src/services/topology/collectionDigest';
import { ingestTopologyNetworkContext } from '../../apps/api/src/services/topology/collectionIngest';
import type { AuthenticatedTopologyProducer } from '../../apps/api/src/services/topology/collectionTypes';
import { importLegacyTopologySite } from '../../apps/api/src/services/topology/legacyImport';
import { retryableTopologyTransaction } from '../../apps/api/src/jobs/topologyOutboxWorker';
import { runTopologyReconcileTick } from '../../apps/api/src/jobs/topologyReconcileWorker';

type Options = {
  fixture: 'I10K'; seed: string; durationHours: number; output: string;
  sites?: number; agents?: number; cadenceSeconds: number; roundSeconds: number; changePeriod?: number;
  concurrency: number; drainSeconds: number;
};
/** Production reconcile worker interval (`initializeTopologyReconcileWorker`). */
const RECONCILE_INTERVAL_MS = 2_000;
const LATENCY_POLL_MS = 250;
const GATE = { p95Ms: 10_000, p99Ms: 30_000, maxSendLagFraction: 0.1 };

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const [flag, inline] = token.slice(2).split('=', 2);
    values.set(flag!, inline ?? argv[++index] ?? '');
  }
  const number = (name: string, fallback: number) => {
    const raw = values.get(name);
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number`);
    return parsed;
  };
  const fixture = values.get('fixture') ?? 'I10K';
  if (fixture !== 'I10K') throw new Error(`Unsupported --fixture ${fixture}; the ingest soak drives I10K`);
  const output = values.get('output');
  if (!output) throw new Error('--output <path> is required so the run leaves an artifact');
  // The reported cadence is part of the wire contract (>= 60s). `--round-seconds`
  // only compresses the harness's own wall-clock loop for a smoke run.
  const cadenceSeconds = number('cadence-seconds', 300);
  if (cadenceSeconds < 60) throw new Error('--cadence-seconds must be at least 60 (network context contract)');
  return {
    fixture, seed: values.get('seed') ?? TOPOLOGY_FIXTURE_SEED,
    durationHours: number('duration-hours', 24), output,
    sites: values.has('sites') ? number('sites', 0) : undefined,
    agents: values.has('agents') ? number('agents', 0) : undefined,
    cadenceSeconds, roundSeconds: number('round-seconds', cadenceSeconds),
    changePeriod: values.has('change-period') ? number('change-period', 0) : undefined,
    // Must stay under the pool (DB_POOL_MAX, default 30): the reconcile tick
    // and the latency watcher each need a connection too. For the full I10K
    // rate use e.g. DB_POOL_MAX=48 --concurrency 32.
    concurrency: Math.floor(number('concurrency', 16)), drainSeconds: number('drain-seconds', 120),
  };
}

/** No flag, env var or argument can turn this off. */
function assertDisposableTarget(): void {
  assertTestDatabaseUrlSafe(process.env.DATABASE_URL ?? '', 'topology ingest soak (DATABASE_URL)');
  assertTestDatabaseUrlSafe(process.env.DATABASE_URL_APP ?? '', 'topology ingest soak (DATABASE_URL_APP)');
  if (process.env.NODE_ENV === 'production') throw new Error('topology ingest soak refuses to run with NODE_ENV=production');
}

const orgContext = (orgId: string): DbAccessContext =>
  ({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null });
const scoped = <T>(orgId: string, fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
const address = (siteIndex: number, agentIndex: number) => `198.18.${siteIndex % 256}.${(agentIndex % 240) + 10}`;
const gateway = (siteIndex: number) => `198.18.${siteIndex % 256}.1`;
const sleep = (ms: number) => new Promise((done) => { setTimeout(done, ms); });
/** Run `fn` over `items` with at most `limit` in flight, preserving pull order. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}
/** Whole-transaction retry for the same lock conflicts the production callers retry. */
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fn(); } catch (error) {
      if (attempt < 4 && retryableTopologyTransaction(error)) { await sleep(25 * (attempt + 1)); continue; }
      throw error;
    }
  }
}

/** Synchronous so it also works from signal / uncaughtException handlers. */
function writeArtifact(output: string, report: unknown): void {
  mkdirSync(dirname(output), { recursive: true });
  const temp = `${output}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(temp, output);
}
/** Set once the soak has something to record; called on any abnormal exit. */
let recordAbort: ((reason: string) => void) | null = null;

/** Fixed-memory millisecond histogram: a 24h I10K run records ~2.9M send-lag
 * samples, too many to keep, sort each round, or spread into Math.max. */
class MsHistogram {
  private readonly counts: Uint32Array;
  samples = 0;
  max = 0;
  constructor(private readonly capMs: number) { this.counts = new Uint32Array(capMs + 1); }
  record(ms: number) {
    const value = Math.max(0, Math.round(ms));
    this.counts[Math.min(value, this.capMs)]! += 1;
    this.samples += 1;
    if (value > this.max) this.max = value;
  }
  percentile(fraction: number): number {
    if (!this.samples) return 0;
    const rank = Math.min(this.samples, Math.max(1, Math.ceil(fraction * this.samples)));
    let seen = 0;
    for (let ms = 0; ms <= this.capMs; ms += 1) { seen += this.counts[ms]!; if (seen >= rank) return ms; }
    return this.capMs;
  }
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

type SoakProducer = AuthenticatedTopologyProducer & {
  producerIndex: number; siteIndex: number; siteId: string; deviceId: string;
  jitterSeconds: number; sequence: bigint; baseSnapshotId: string; contentDigest: string;
};

async function seedFleet(spec: ReturnType<typeof topologyIngestFixture>) {
  const stamp = Date.now();
  return withSystemDbAccessContext(async () => {
    const [partner] = await db.execute(sql`INSERT INTO partners (name,slug,type,plan,status,currency_code)
      VALUES (${`Soak Partner ${stamp}`},${`soak-partner-${stamp}`},'msp','pro','active','USD') RETURNING id`);
    const [org] = await db.execute(sql`INSERT INTO organizations (partner_id,name,slug,type,status,currency_code,settings)
      VALUES (${String(partner!.id)}::uuid,${`Soak Org ${stamp}`},${`soak-org-${stamp}`},'customer','active','USD',
        '{"topologyFeatureFlags":{"materialization":true}}') RETURNING id`);
    const orgId = String(org!.id);
    const sites: string[] = [];
    for (let index = 0; index < spec.siteCount; index += 1) {
      const [site] = await db.execute(sql`INSERT INTO sites (org_id,name,timezone)
        VALUES (${orgId}::uuid,${`Soak Site ${index}`},'UTC') RETURNING id`);
      sites.push(String(site!.id));
    }
    const rows = spec.agents.map((agent) => ({
      index: agent.producerIndex, siteIndex: agent.siteIndex, siteId: sites[agent.siteIndex]!,
      deviceId: crypto.randomUUID(), jitterSeconds: agent.jitterSeconds,
    }));
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200);
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash) VALUES ${
        sql.join(batch.map((row) => sql`(${row.deviceId}::uuid,${orgId}::uuid,${row.siteId}::uuid,${row.deviceId},${`soak-${row.index}`},'linux','1','amd64','1',${(row.index + 1).toString(16).padStart(64, '0')})`), sql`,`)}`);
      // No hand-made topology_nodes/bindings: the legacy backfill in main()
      // projects these devices into the canonical graph, as in production.
    }
    return { orgId, sites, rows };
  }, 'topology-ingest-soak-seed');
}

function buildFull(producer: SoakProducer, cadenceSeconds: number, variant: number): NetworkContextFull {
  const report = networkContextFixture();
  const interfaces = report.sections.find((section) => section.kind === 'interfaces')!;
  const routes = report.sections.find((section) => section.kind === 'routes')!;
  const resolvers = report.sections.find((section) => section.kind === 'resolvers')!;
  interfaces.rows[0]!.addresses = [{ ...interfaces.rows[0]!.addresses[0]!, address: address(producer.siteIndex, producer.producerIndex % 240) }];
  routes.rows[0]!.nextHops = [{ ...routes.rows[0]!.nextHops[0]!, address: gateway(producer.siteIndex) }];
  routes.rows[0]!.metric = 100 + variant;
  resolvers.rows[0]!.address = gateway(producer.siteIndex);
  producer.sequence += 1n;
  Object.assign(report, {
    producerEpoch: producer.producerEpoch, sequence: producer.sequence.toString(), snapshotId: crypto.randomUUID(),
    capturedAt: new Date(Date.now() - producer.jitterSeconds * 1000).toISOString(),
    captureAgeAtSendMs: producer.jitterSeconds * 1000, expectedIntervalSeconds: cadenceSeconds,
  });
  for (const section of report.sections) section.contentDigest = topologySectionDigest(report, section, producer.sourceIdentity);
  report.contentDigest = topologyContextDigest(report, producer.sourceIdentity);
  return report;
}
function buildUnchanged(producer: SoakProducer, cadenceSeconds: number) {
  producer.sequence += 1n;
  return {
    version: 1, reportKind: 'unchanged' as const, producerEpoch: producer.producerEpoch,
    sequence: producer.sequence.toString(), snapshotId: crypto.randomUUID(), baseSnapshotId: producer.baseSnapshotId,
    capturedAt: new Date(Date.now() - producer.jitterSeconds * 1000).toISOString(),
    captureAgeAtSendMs: producer.jitterSeconds * 1000, expectedIntervalSeconds: cadenceSeconds,
    contentDigest: producer.contentDigest,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertDisposableTarget();
  const poolMax = Number.parseInt(process.env.DB_POOL_MAX ?? '30', 10) || 30;
  if (options.concurrency + 4 > poolMax) throw new Error(`--concurrency ${options.concurrency} needs DB_POOL_MAX >= ${options.concurrency + 4} (have ${poolMax})`);
  const output = resolvePath(process.cwd(), options.output);

  const spec = topologyIngestFixture(options.fixture, options.seed,
    { siteCount: options.sites, agentsPerSite: options.agents });
  const startedAt = new Date();
  console.log(`[topology-soak] ${options.fixture} seed=${options.seed} producers=${spec.agents.length} sites=${spec.siteCount} `
    + `cadence=${options.cadenceSeconds}s round=${options.roundSeconds}s concurrency=${options.concurrency} steady-state=${options.durationHours}h`);

  // Until the first steady-state checkpoint, an abort still leaves a record.
  recordAbort = (reason) => writeArtifact(output, { status: 'aborted', phase: 'bootstrap', abortReason: reason,
    fixture: options.fixture, seed: options.seed, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString() });
  const fleet = await seedFleet(spec);
  const orgId = fleet.orgId;
  // Real operator enablement path: legacy backfill to a complete checkpoint.
  // Until it completes, the production reconcile tick skips the site.
  for (const siteId of fleet.sites) {
    for (let pass = 0; ; pass += 1) {
      const result = await retrying(() => scoped(orgId, () => importLegacyTopologySite({ orgId, siteId })));
      if (result.complete) break;
      if (pass > 1000) throw new Error(`legacy backfill for site ${siteId} did not complete`);
    }
  }

  const producers: SoakProducer[] = new Array(fleet.rows.length);
  await runPool(fleet.rows.map((row, index) => ({ row, index })), options.concurrency, async ({ row, index }) => {
    const config = await retrying(() => scoped(orgId, () => negotiateTopologyContext(row.deviceId)));
    if (!('producerEpoch' in config) || !config.producerEpoch) throw new Error('topology materialization is disabled for the soak org');
    producers[index] = {
      scope: { orgId, siteId: row.siteId }, producerId: row.deviceId, producerKind: 'agent',
      producerEpoch: config.producerEpoch, configurationRevision: config.configurationRevision!,
      sourceIdentity: config.sourceIdentity!, producerIndex: row.index, siteIndex: row.siteIndex,
      siteId: row.siteId, deviceId: row.deviceId, jitterSeconds: row.jitterSeconds,
      sequence: 0n, baseSnapshotId: '', contentDigest: '',
    };
  });

  // Default: the fixture's normative 1% per round (each producer changes once
  // every 100 rounds). `--change-period` compresses that for a smoke run only.
  const isChangedRound = options.changePeriod
    ? (producerIndex: number, round: number) => (producerIndex + round) % options.changePeriod! === 0
    : spec.isChangedRound;
  const jitterScale = options.roundSeconds / options.cadenceSeconds;
  const maxSendLagMs = Math.round(options.roundSeconds * 1000 * GATE.maxSendLagFraction);
  const byJitter = [...producers].sort((a, b) => a.jitterSeconds - b.jitterSeconds || a.producerIndex - b.producerIndex);

  const counters = { admitted: 0, confirmed: 0, rejected: 0, acceptedChanges: 0, reconcileTicks: 0, reconcileErrors: 0 };
  const rejectReasons: Record<string, number> = {};
  const latencies: number[] = [];
  let steadyState = false;
  // siteId -> accepted revisions awaiting publication, in revision order.
  const pending = new Map<string, Array<{ revision: bigint; at: number }>>();

  const siteStats = () => scoped(orgId, async () => {
    const [row] = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM topology_collection_runs WHERE org_id=${orgId}::uuid) AS runs,
      (SELECT count(*)::int FROM topology_observations WHERE org_id=${orgId}::uuid) AS observations,
      (SELECT count(*)::int FROM topology_collection_runs WHERE org_id=${orgId}::uuid AND materialized_at IS NULL) AS unmaterialized,
      (SELECT coalesce(sum(graph_revision),0)::text FROM topology_site_state WHERE org_id=${orgId}::uuid) AS graph_revisions,
      (SELECT count(*)::int FROM topology_site_state WHERE org_id=${orgId}::uuid AND dirty_revision>materialized_input_revision) AS dirty_sites`);
    return { runs: Number(row!.runs), observations: Number(row!.observations), unmaterialized: Number(row!.unmaterialized),
      graphRevisions: BigInt(String(row!.graph_revisions)), dirtySites: Number(row!.dirty_sites) };
  });
  const dbNow = async () => {
    const [row] = await scoped(orgId, () => db.execute(sql`SELECT clock_timestamp()::text AS now`));
    return String(row!.now);
  };
  const recordReject = (reason: string | undefined) => {
    counters.rejected += 1; rejectReasons[reason ?? 'unknown'] = (rejectReasons[reason ?? 'unknown'] ?? 0) + 1;
  };
  /** Ingest; for an accepted change also read (in the same transaction, under
   * the site-state row lock ingest took) the dirty revision it produced. */
  const ingest = (producer: SoakProducer, payload: unknown, change: boolean) => retrying(() => scoped(orgId, async () => {
    const receipt = await ingestTopologyNetworkContext(producer, payload);
    if (!change || !receipt.accepted) return { receipt, revision: null };
    const [state] = await db.execute(sql`SELECT dirty_revision::text AS revision FROM topology_site_state
      WHERE org_id=${orgId}::uuid AND site_id=${producer.siteId}::uuid`);
    return { receipt, revision: BigInt(String(state!.revision)) };
  }));

  // Publisher: the production reconcile tick on its production interval.
  let stopping = false;
  const reconcileLoop = (async () => {
    while (!stopping) {
      const at = Date.now();
      try { await runTopologyReconcileTick(); counters.reconcileTicks += 1; }
      catch (error) { counters.reconcileErrors += 1; console.error('[topology-soak] reconcile tick failed', error); }
      await sleep(Math.max(0, RECONCILE_INTERVAL_MS - (Date.now() - at)));
    }
  })();
  // Latency watcher: resolve pending revisions once materialized.
  const latencyLoop = (async () => {
    while (!stopping) {
      const sites = [...pending.keys()];
      if (sites.length) {
        const rows = await scoped(orgId, () => db.execute(sql`SELECT site_id::text AS site_id, materialized_input_revision::text AS through
          FROM topology_site_state WHERE org_id=${orgId}::uuid AND site_id IN (${sql.join(sites.map((id) => sql`${id}::uuid`), sql`,`)})`));
        const now = Date.now();
        for (const row of rows) {
          const siteId = String(row.site_id); const through = BigInt(String(row.through));
          const queue = pending.get(siteId) ?? [];
          while (queue.length && queue[0]!.revision <= through) {
            const entry = queue.shift()!;
            if (steadyState) latencies.push(now - entry.at);
          }
          if (!queue.length) pending.delete(siteId);
        }
      }
      await sleep(LATENCY_POLL_MS);
    }
  })();
  const track = (siteId: string, revision: bigint, at: number) => {
    const queue = pending.get(siteId) ?? [];
    queue.push({ revision, at }); queue.sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0));
    pending.set(siteId, queue);
  };

  try {
    // Bootstrap: one real full report per producer, published by the worker.
    await runPool(producers, options.concurrency, async (producer) => {
      const report = buildFull(producer, options.cadenceSeconds, 0);
      const at = Date.now();
      const { receipt, revision } = await ingest(producer, report, true);
      if (!receipt.accepted) throw new Error(`soak bootstrap rejected: ${receipt.reason}`);
      producer.baseSnapshotId = report.snapshotId; producer.contentDigest = report.contentDigest;
      counters.admitted += 1;
      track(producer.siteId, revision!, at);
    });
    const bootstrapDeadline = Date.now() + Math.max(options.drainSeconds * 1000, fleet.sites.length * 5_000);
    while (pending.size && Date.now() < bootstrapDeadline) await sleep(500);
    if (pending.size) throw new Error(`bootstrap: ${pending.size} sites never published within the drain window`);
    const bootstrap = await siteStats();
    const bootstrapFinishedAt = new Date();
    const deadline = bootstrapFinishedAt.getTime() + options.durationHours * 3_600_000;
    console.log(`[topology-soak] bootstrap done in ${((bootstrapFinishedAt.getTime() - startedAt.getTime()) / 60_000).toFixed(1)} min; `
      + `steady state until ${new Date(deadline).toISOString()}`);
    steadyState = true;
    let previousRoundDbStart = await dbNow();

    let unchangedRunInserts = 0;
    let unchangedObservationInserts = 0;
    // Values past the cap still count and still set `max` exactly.
    const sendLags = new MsHistogram(Math.max(maxSendLagMs * 4, 60_000));
    let maxRoundSendMs = 0;
    let round = 0;
    let current = bootstrap;
    let lost: number | null = null;
    const snapshot = (status: 'running' | 'completed' | 'aborted', abortReason?: string) => {
      const p95 = percentile(latencies, 0.95); const p99 = percentile(latencies, 0.99);
      const maxSendLag = sendLags.max;
      const invariants = {
        unchangedRunInserts, unchangedObservationInserts,
        // Mid-run: accepted-but-unpublished right now (normally > 0, in flight).
        // Completed: after the drain window, the lost-transition verdict.
        lostAcceptedTransitions: lost ?? [...pending.values()].reduce((sum, queue) => sum + queue.length, 0),
        unmaterializedRuns: current.unmaterialized,
        bootstrapRuns: bootstrap.runs, finalRuns: current.runs, finalObservations: current.observations,
      };
      const failures = status === 'completed' ? [
        p95 > GATE.p95Ms ? `p95 ${p95}ms > ${GATE.p95Ms}ms` : null,
        p99 > GATE.p99Ms ? `p99 ${p99}ms > ${GATE.p99Ms}ms` : null,
        invariants.lostAcceptedTransitions ? `${invariants.lostAcceptedTransitions} accepted changes never published` : null,
        invariants.unmaterializedRuns ? `${invariants.unmaterializedRuns} runs never materialized` : null,
        unchangedRunInserts ? `unchanged confirmations inserted ${unchangedRunInserts} runs` : null,
        unchangedObservationInserts ? `unchanged confirmations inserted ${unchangedObservationInserts} observations` : null,
        maxSendLag > maxSendLagMs ? `max send lag ${maxSendLag}ms > ${maxSendLagMs}ms (I10K rate not sustained)` : null,
        counters.reconcileErrors ? `${counters.reconcileErrors} reconcile ticks threw` : null,
        latencies.length === 0 ? 'no accepted-change latency samples' : null,
      ].filter((failure): failure is string => failure !== null) : undefined;
      return {
        status, ...(abortReason ? { abortReason } : {}), ...(failures ? { passed: failures.length === 0, failures } : {}),
        fixture: options.fixture, seed: options.seed, startedAt: startedAt.toISOString(),
        bootstrapFinishedAt: bootstrapFinishedAt.toISOString(),
        finishedAt: status === 'running' ? null : new Date().toISOString(),
        lastCheckpointAt: new Date().toISOString(),
        steadyStateHours: Number(((Date.now() - bootstrapFinishedAt.getTime()) / 3_600_000).toFixed(3)),
        requestedDurationHours: options.durationHours,
        scale: { sites: spec.siteCount, agentsPerSite: spec.agentsPerSite, producers: producers.length,
          cadenceSeconds: options.cadenceSeconds, roundSeconds: options.roundSeconds, concurrency: options.concurrency,
          changePeriod: options.changePeriod ?? Math.round(1 / spec.changedFraction), rounds: round, maxRoundSendMs },
        counters: { ...counters, publications: (current.graphRevisions - bootstrap.graphRevisions).toString() },
        rejectReasons: { ...rejectReasons },
        gate: GATE,
        latencyMs: { samples: latencies.length, p50: percentile(latencies, 0.5), p95, p99,
          max: latencies.reduce((max, value) => Math.max(max, value), 0) },
        sendLagMs: { samples: sendLags.samples, p50: sendLags.percentile(0.5), p99: sendLags.percentile(0.99),
          max: maxSendLag, limit: maxSendLagMs },
        invariants,
      };
    };
    // Abort path records the LAST CHECKPOINTED counts — it must not touch the
    // database, which is often the thing that just went away.
    recordAbort = (reason) => writeArtifact(output, snapshot('aborted', reason));
    writeArtifact(output, snapshot('running'));

    while (Date.now() < deadline) {
      round += 1;
      const roundStart = Date.now();
      const roundEnd = roundStart + options.roundSeconds * 1000;
      const dbStart = await dbNow();
      const unchangedIds: string[] = [];

      await runPool(byJitter, options.concurrency, async (producer) => {
        const due = roundStart + producer.jitterSeconds * 1000 * jitterScale;
        if (due > Date.now()) await sleep(due - Date.now());
        sendLags.record(Date.now() - due);
        if (isChangedRound(producer.producerIndex, round)) {
          const report = buildFull(producer, options.cadenceSeconds, round);
          const at = Date.now();
          const { receipt, revision } = await ingest(producer, report, true);
          if (!receipt.accepted) { recordReject(receipt.reason); return; }
          producer.baseSnapshotId = report.snapshotId; producer.contentDigest = report.contentDigest;
          counters.admitted += 1; counters.acceptedChanges += 1;
          track(producer.siteId, revision!, at);
        } else {
          const payload = buildUnchanged(producer, options.cadenceSeconds);
          const { receipt } = await ingest(producer, payload, false);
          if (receipt.accepted) { counters.confirmed += 1; unchangedIds.push(payload.snapshotId); } else recordReject(receipt.reason);
        }
      });
      const sendMs = Date.now() - roundStart;
      maxRoundSendMs = Math.max(maxRoundSendMs, sendMs);

      const inList = (ids: string[]) => ids.length ? sql.join(ids.map((id) => sql`${id}::uuid`), sql`,`) : sql`NULL::uuid`;
      const [history] = await scoped(orgId, () => db.execute(sql`SELECT
        (SELECT count(*)::int FROM topology_collection_runs WHERE org_id=${orgId}::uuid AND snapshot_id IN (${inList(unchangedIds)})) AS runs,
        (SELECT count(*)::int FROM topology_observations o JOIN topology_collection_runs r ON r.id=o.run_id AND r.org_id=o.org_id
          WHERE o.org_id=${orgId}::uuid AND o.created_at>=${dbStart}::timestamptz AND r.created_at<${previousRoundDbStart}::timestamptz) AS observations`));
      previousRoundDbStart = dbStart;
      unchangedRunInserts += Number(history!.runs);
      unchangedObservationInserts += Number(history!.observations);

      current = await siteStats();
      writeArtifact(output, snapshot('running'));
      const wait = Math.min(roundEnd - Date.now(), Math.max(deadline - Date.now(), 0));
      if (wait > 0) await sleep(wait);
    }

    // Drain: give the worker a bounded window to publish what was accepted.
    const drainDeadline = Date.now() + options.drainSeconds * 1000;
    while (pending.size && Date.now() < drainDeadline) await sleep(500);
    lost = [...pending.values()].reduce((sum, queue) => sum + queue.length, 0);
    current = await siteStats();
    const report = snapshot('completed');
    recordAbort = null;
    writeArtifact(output, report);
    console.log(`[topology-soak] wrote ${output}`);
    console.log(JSON.stringify(report.counters), JSON.stringify(report.latencyMs), JSON.stringify(report.invariants));
    if (!report.passed) {
      console.error(`[topology-soak] FAILED: ${report.failures!.join('; ')}`);
      process.exitCode = 1;
    } else console.log('[topology-soak] PASSED');
  } finally {
    stopping = true;
    await Promise.allSettled([reconcileLoop, latencyLoop]);
  }
}

// AggregateError (e.g. ECONNREFUSED from a dual-stack connect) has an empty message.
const describe = (error: unknown) => error instanceof Error
  ? error.message || (error as { code?: string }).code || error.name
  : String(error);
function abort(reason: string): void {
  if (!recordAbort) return;
  try { recordAbort(reason); console.error(`[topology-soak] aborted (${reason}); partial artifact written`); }
  catch (error) { console.error('[topology-soak] could not write the aborted artifact', error); }
  recordAbort = null;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.on(signal, () => { abort(signal); process.exit(code); });
}
// The postgres driver can throw from a socket callback when the server
// disappears, which never reaches main()'s rejection handler.
process.on('uncaughtException', (error) => { console.error(error); abort(`uncaughtException: ${describe(error)}`); process.exit(1); });
process.on('unhandledRejection', (error) => {
  console.error(error); abort(`unhandledRejection: ${describe(error)}`); process.exit(1);
});

main().then(async () => { await closeDb(); }, async (error) => {
  console.error(error);
  abort(describe(error));
  process.exitCode = 1;
  await closeDb().catch(() => {});
});
