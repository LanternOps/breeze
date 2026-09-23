/**
 * Topology collection ingest soak harness.
 *
 * Drives the REAL producer seam — negotiate -> ingest -> publish -> retention —
 * against a DISPOSABLE test database, using the deterministic `I10K` fleet
 * shape, and records admitted/confirmed/published transitions plus the
 * accepted-change -> publication latency distribution.
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
 *
 * Smoke-sized run (a minute, a handful of producers, 5s cadence):
 *   ... --duration-hours 0.02 --sites 2 --agents 3 --cadence-seconds 5
 *
 * Checkpointing: the output file is rewritten (atomically) after bootstrap and
 * after every round with `status: "running"`, so a run that dies at hour 13
 * still leaves 13 hours of evidence. A signal, uncaught exception or failed
 * main() rewrites it with `status: "aborted"` and the reason; only a run that
 * reaches its deadline writes `status: "completed"`.
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
import { publishTopologyBuild } from '../../apps/api/src/services/topology/publish';

type Options = {
  fixture: 'I10K'; seed: string; durationHours: number; output: string;
  sites?: number; agents?: number; cadenceSeconds: number; roundSeconds: number; changePeriod?: number;
};

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

/** Synchronous so it also works from signal / uncaughtException handlers. */
function writeArtifact(output: string, report: unknown): void {
  mkdirSync(dirname(output), { recursive: true });
  const temp = `${output}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(temp, output);
}
/** Set once the soak has something to record; called on any abnormal exit. */
let recordAbort: ((reason: string) => void) | null = null;

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
      deviceId: crypto.randomUUID(), nodeId: crypto.randomUUID(), jitterSeconds: agent.jitterSeconds,
    }));
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200);
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash) VALUES ${
        sql.join(batch.map((row) => sql`(${row.deviceId}::uuid,${orgId}::uuid,${row.siteId}::uuid,${row.deviceId},${`soak-${row.index}`},'linux','1','amd64','1',${(row.index + 1).toString(16).padStart(64, '0')})`), sql`,`)}`);
      await db.execute(sql`INSERT INTO topology_nodes (id,org_id,site_id,identity_key,identity_material,kind) VALUES ${
        sql.join(batch.map((row) => sql`(${row.nodeId}::uuid,${orgId}::uuid,${row.siteId}::uuid,${row.nodeId},${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: row.nodeId })}::jsonb,'endpoint')`), sql`,`)}`);
      await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,device_id) VALUES ${
        sql.join(batch.map((row) => sql`(${orgId}::uuid,${row.siteId}::uuid,${row.nodeId}::uuid,${row.deviceId}::uuid)`), sql`,`)}`);
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
  const output = resolvePath(process.cwd(), options.output);

  const spec = topologyIngestFixture(options.fixture, options.seed,
    { siteCount: options.sites, agentsPerSite: options.agents });
  const startedAt = new Date();
  const deadline = startedAt.getTime() + options.durationHours * 3_600_000;
  console.log(`[topology-soak] ${options.fixture} seed=${options.seed} producers=${spec.agents.length} `
    + `sites=${spec.siteCount} cadence=${options.cadenceSeconds}s round=${options.roundSeconds}s until=${new Date(deadline).toISOString()}`);

  const fleet = await seedFleet(spec);
  const producers: SoakProducer[] = [];
  for (const row of fleet.rows) {
    const config = await scoped(fleet.orgId, () => negotiateTopologyContext(row.deviceId));
    if (!('producerEpoch' in config) || !config.producerEpoch) throw new Error('topology materialization is disabled for the soak org');
    producers.push({
      scope: { orgId: fleet.orgId, siteId: row.siteId }, producerId: row.deviceId, producerKind: 'agent',
      producerEpoch: config.producerEpoch, configurationRevision: config.configurationRevision!,
      sourceIdentity: config.sourceIdentity!, producerIndex: row.index, siteIndex: row.siteIndex,
      siteId: row.siteId, deviceId: row.deviceId, jitterSeconds: row.jitterSeconds,
      sequence: 0n, baseSnapshotId: '', contentDigest: '',
    });
  }

  // Default: the fixture's normative 1% per round (each producer changes once
  // every 100 rounds). `--change-period` compresses that for a smoke run only.
  const isChangedRound = options.changePeriod
    ? (producerIndex: number, round: number) => (producerIndex + round) % options.changePeriod! === 0
    : spec.isChangedRound;

  const counters = { admitted: 0, confirmed: 0, rejected: 0, publications: 0, acceptedChanges: 0 };
  const latencies: number[] = [];
  const runCount = () => scoped(fleet.orgId, async () => {
    const [row] = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM topology_collection_runs WHERE org_id=${fleet.orgId}::uuid) AS runs,
      (SELECT count(*)::int FROM topology_observations WHERE org_id=${fleet.orgId}::uuid) AS observations,
      (SELECT count(*)::int FROM topology_collection_runs WHERE org_id=${fleet.orgId}::uuid AND materialized_at IS NULL) AS unmaterialized`);
    return { runs: Number(row!.runs), observations: Number(row!.observations), unmaterialized: Number(row!.unmaterialized) };
  });
  const ingest = (producer: SoakProducer, payload: unknown) =>
    scoped(fleet.orgId, () => ingestTopologyNetworkContext(producer, payload));
  const publishSite = (siteId: string) => scoped(fleet.orgId, async () => {
    const [state] = await db.execute(sql`SELECT build_fence::text,dirty_revision::text FROM topology_site_state
      WHERE org_id=${fleet.orgId}::uuid AND site_id=${siteId}::uuid`);
    const result = await publishTopologyBuild({ orgId: fleet.orgId, siteId },
      { buildFence: String(state!.build_fence), inputRevision: String(state!.dirty_revision), nodes: [], relationships: [], bindings: [] });
    if (result.published) counters.publications += 1;
    return result;
  });

  // Bootstrap: one real full report per producer, then publish every site.
  for (const producer of producers) {
    const report = buildFull(producer, options.cadenceSeconds, 0);
    const receipt = await ingest(producer, report);
    if (!receipt.accepted) throw new Error(`soak bootstrap rejected: ${receipt.reason}`);
    producer.baseSnapshotId = report.snapshotId; producer.contentDigest = report.contentDigest;
    counters.admitted += 1;
  }
  for (const siteId of fleet.sites) await publishSite(siteId);
  const bootstrap = await runCount();

  let unchangedRunInserts = 0;
  let unchangedObservationInserts = 0;
  let round = 0;
  let current = bootstrap;
  const snapshot = (status: 'running' | 'completed' | 'aborted', abortReason?: string) => ({
    status, ...(abortReason ? { abortReason } : {}),
    fixture: options.fixture, seed: options.seed, startedAt: startedAt.toISOString(),
    finishedAt: status === 'running' ? null : new Date().toISOString(),
    lastCheckpointAt: new Date().toISOString(),
    elapsedHours: Number(((Date.now() - startedAt.getTime()) / 3_600_000).toFixed(3)),
    requestedDurationHours: options.durationHours,
    scale: { sites: spec.siteCount, agentsPerSite: spec.agentsPerSite, producers: producers.length,
      cadenceSeconds: options.cadenceSeconds, roundSeconds: options.roundSeconds,
      changePeriod: options.changePeriod ?? Math.round(1 / spec.changedFraction), rounds: round },
    counters: { ...counters },
    latencyMs: { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99), max: latencies.length ? Math.max(...latencies) : 0 },
    invariants: {
      unchangedRunInserts, unchangedObservationInserts,
      // Mid-run this is "accepted but not yet published" as of the last
      // checkpoint; only the completed value is the lost-transition verdict.
      lostAcceptedTransitions: current.unmaterialized,
      bootstrapRuns: bootstrap.runs, finalRuns: current.runs, finalObservations: current.observations,
    },
  });
  // Abort path records the LAST CHECKPOINTED counts — it must not touch the
  // database, which is often the thing that just went away.
  recordAbort = (reason) => writeArtifact(output, snapshot('aborted', reason));
  writeArtifact(output, snapshot('running'));

  while (Date.now() < deadline) {
    round += 1;
    const roundStart = Date.now();
    const pendingSites = new Set<string>();
    const changeStarts = new Map<string, number[]>();
    const before = current;
    let changedThisRound = 0;

    for (const producer of producers) {
      const changed = isChangedRound(producer.producerIndex, round);
      if (changed) {
        const report = buildFull(producer, options.cadenceSeconds, round);
        const at = Date.now();
        const receipt = await ingest(producer, report);
        if (receipt.accepted) {
          producer.baseSnapshotId = report.snapshotId; producer.contentDigest = report.contentDigest;
          counters.admitted += 1; counters.acceptedChanges += 1; changedThisRound += 1;
          pendingSites.add(producer.siteId);
          changeStarts.set(producer.siteId, [...(changeStarts.get(producer.siteId) ?? []), at]);
        } else counters.rejected += 1;
      } else {
        const receipt = await ingest(producer, buildUnchanged(producer, options.cadenceSeconds));
        if (receipt.accepted) counters.confirmed += 1; else counters.rejected += 1;
      }
    }
    if (!changedThisRound) {
      const after = await runCount();
      unchangedRunInserts += after.runs - before.runs;
      unchangedObservationInserts += after.observations - before.observations;
    }
    for (const siteId of pendingSites) {
      await publishSite(siteId);
      const finished = Date.now();
      for (const at of changeStarts.get(siteId) ?? []) latencies.push(finished - at);
    }
    current = await runCount();
    writeArtifact(output, snapshot('running'));

    const elapsed = Date.now() - roundStart;
    const wait = Math.min(options.roundSeconds * 1000 - elapsed, Math.max(deadline - Date.now(), 0));
    if (wait > 0) await sleep(wait);
  }

  current = await runCount();
  const final = current;
  const report = snapshot('completed');
  recordAbort = null;
  writeArtifact(output, report);
  console.log(`[topology-soak] wrote ${output}`);
  console.log(JSON.stringify(report.counters), JSON.stringify(report.latencyMs), JSON.stringify(report.invariants));
  const failures = [
    unchangedRunInserts !== 0 ? `unchanged confirmations inserted ${unchangedRunInserts} runs` : null,
    unchangedObservationInserts !== 0 ? `unchanged confirmations inserted ${unchangedObservationInserts} observations` : null,
    final.unmaterialized !== 0 ? `${final.unmaterialized} accepted transitions were never published` : null,
  ].filter(Boolean);
  if (failures.length) {
    console.error(`[topology-soak] FAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
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
