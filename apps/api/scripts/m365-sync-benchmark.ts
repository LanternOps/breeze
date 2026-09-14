#!/usr/bin/env tsx
/**
 * M365 tenant-sync capacity benchmark (spec §5.11). NOT part of CI.
 *
 * Seeds N orgs with a realistic size distribution (median 60 users / 40
 * devices, p95 2 000 / 1 500, two at 25k), points the API at an in-process
 * fake executor with 200 ms latency, then runs the ticker + worker loop for
 * one cadence window and reports:
 *
 *   - tick drain time (p95 over ticks)
 *   - ticker utilisation (claimed runs / (tickBatch × ticks))
 *   - max queue depth (claimed-but-not-yet-run)
 *   - WAL bytes written (pg_current_wal_lsn delta)
 *   - pool occupancy peak (pg_stat_activity for the app role) against pool max
 *   - p95 latency of an unrelated foreground probe query sampled every second
 *   - entity writes on a second, unchanged pass
 *
 * PASS CRITERIA, fixed before the first run (BENCHMARK_PASS_CRITERIA in
 * ./m365-sync-benchmark.lib.ts):
 *   ticker utilisation      <= 0.50 of tickBatch × ticks   (§5.9 capacity rule)
 *   tick drain p95          <= 60 s                        (a tick finishes before the next)
 *   max queue depth         <= 500                         (M365_SYNC_MAX_BACKLOG default)
 *   pool occupancy peak     <= 50 % of the pool             (fetch holds no connection)
 *   foreground probe p95    <= 50 ms                        (unrelated endpoints stay fast)
 *   steady-state writes     == 0 rows for users/ca_policies/skus/secure_score
 *
 * Run it against a production-class Postgres (1 vCPU managed class), never a
 * laptop container, or the numbers mean nothing:
 *   docs/runbooks/m365-sync-benchmark.md
 *
 * Usage:
 *   DATABASE_URL_APP=... M365_TENANT_SYNC_ENABLED=true \
 *     pnpm --filter @breeze/api m365-sync:benchmark --orgs=1000 --window-minutes=60
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { M365_SYNC_DOMAINS } from '@breeze/shared/m365';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { claimDueDomains, countDueDomains } from '../src/services/m365Sync/claim';
import { runSyncDomain } from '../src/services/m365Sync/run';
import {
  createFakeSyncExecutor,
  syncCaPoliciesResult, syncIntuneDevicesResult, syncSecureScoreResult,
  syncSkusResult, syncUsersResult,
} from '../src/__tests__/integration/m365SyncFakeExecutor';
import {
  formatReport, makeSizeDistribution, parseBenchmarkArgs, percentile,
  type BenchmarkReport,
} from './m365-sync-benchmark.lib';

const BENCH_TAG = 'm365-sync-benchmark';

async function walLsnBytes(): Promise<bigint> {
  const [row] = (await withSystemDbAccessContext(() =>
    db.execute(sql`SELECT pg_current_wal_lsn() - '0/0'::pg_lsn AS bytes`))) as unknown as { bytes: string }[];
  return BigInt(row!.bytes);
}

/**
 * The pass criterion is against the APP's configured pool size (the fetch
 * phase holds no connection, so sync must never occupy more than half the
 * pool it shares with request traffic) — not `max_connections`, which is a
 * server-wide ceiling this benchmark's own pool is typically a small
 * fraction of. Mirrors `getDbPoolMax()` in `../src/db/index.ts` (kept local
 * rather than importing/exporting it, since that module has no other reason
 * to expose an internal sizing default).
 */
function benchmarkPoolMax(): number {
  const raw = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);
  return !Number.isFinite(raw) || raw <= 0 ? 30 : raw;
}

async function poolOccupancy(): Promise<{ active: number; max: number }> {
  const [row] = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT count(*) FILTER (WHERE state <> 'idle') AS active
    FROM pg_stat_activity WHERE usename = current_user`))) as unknown as { active: string }[];
  return { active: Number(row!.active), max: benchmarkPoolMax() };
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  if (process.env.M365_TENANT_SYNC_ENABLED !== 'true') {
    throw new Error('set M365_TENANT_SYNC_ENABLED=true — every sync entry point is flag-gated');
  }
  const sizes = makeSizeDistribution(options.orgs, options.seed);
  const executor = await createFakeSyncExecutor({ latencyMs: options.executorLatencyMs });

  // --- seed ---------------------------------------------------------------
  console.log(`[${BENCH_TAG}] seeding ${options.orgs} orgs …`);
  // tenantId is minted here (not gen_random_uuid() in SQL) so the driver can
  // key fixtures per tenant below — see the executor.enqueue(..., tenantId)
  // calls in the ticker loop.
  const orgTenantIds = new Map<string, string>();
  const orgIds = await withSystemDbAccessContext(async () => {
    const [partner] = (await db.execute(sql`
      INSERT INTO partners (name, slug, status)
      VALUES (${`${BENCH_TAG} partner`}, ${`${BENCH_TAG}-${Date.now()}`}, 'active')
      RETURNING id`)) as unknown as { id: string }[];
    const created: string[] = [];
    for (let index = 0; index < options.orgs; index += 1) {
      const tenantId = randomUUID();
      const [org] = (await db.execute(sql`
        INSERT INTO organizations (partner_id, name, status)
        VALUES (${partner!.id}::uuid, ${`${BENCH_TAG}-org-${index}`}, 'active')
        RETURNING id`)) as unknown as { id: string }[];
      const [connection] = (await db.execute(sql`
        INSERT INTO m365_connections (
          org_id, tenant_id, client_id, profile, auth_mode, credential_domain,
          vault_ref, credential_version, permission_manifest_version,
          observed_grants, consent_attempt_id, status, display_name)
        VALUES (${org!.id}::uuid, ${tenantId}::uuid, '55555555-5555-4555-8555-555555555555',
                'customer-graph-read', 'application-certificate', 'customer-graph-read',
                'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
                '0123456789abcdef0123456789abcdef', 3, '[]'::jsonb, gen_random_uuid(),
                'active', ${`${BENCH_TAG}-tenant-${index}`})
        RETURNING id`)) as unknown as { id: string }[];
      for (const domain of M365_SYNC_DOMAINS) {
        await db.execute(sql`
          INSERT INTO m365_sync_state (org_id, connection_id, domain, next_sync_at, interval_seconds)
          VALUES (${org!.id}::uuid, ${connection!.id}::uuid, ${domain}::m365_sync_domain,
                  now() + (random() * interval '1 hour'), 21600)
          ON CONFLICT (org_id, domain) DO NOTHING`);
      }
      created.push(org!.id);
      orgTenantIds.set(org!.id, tenantId);
    }
    return created;
  });

  // --- fixtures per org size ----------------------------------------------
  const fixtureFor = (index: number, domain: string) => {
    const size = sizes[index]!;
    switch (domain) {
      case 'm365.sync.users':
        return syncUsersResult(Array.from({ length: size.users }, (_unused, userIndex) => ({
          id: `aaaaaaaa-0000-4000-8000-${String(userIndex).padStart(12, '0')}`,
          userPrincipalName: `user${userIndex}@bench${index}.example`,
        })));
      case 'm365.sync.intune_devices':
        return syncIntuneDevicesResult(Array.from({ length: size.devices }, (_unused, deviceIndex) => ({
          id: `bbbbbbbb-0000-4000-8000-${String(deviceIndex).padStart(12, '0')}`,
          deviceName: `BENCH-${index}-${deviceIndex}`,
          serialNumber: `SN-${index}-${deviceIndex}`,
        })));
      case 'm365.sync.signin_activity':
        return { success: true as const, kind: 'sync' as const, items: [], truncated: false,
                 fetchedAt: new Date().toISOString(), sources: { signInActivity: 'ok' as const } };
      case 'm365.sync.ca_policies':
        return syncCaPoliciesResult([{ id: 'cccccccc-0000-4000-8000-000000000001', displayName: 'MFA', state: 'enabled' }]);
      case 'm365.sync.skus':
        return syncSkusResult([{ skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: size.users, enabled: size.users + 10 }]);
      default:
        return syncSecureScoreResult(new Date().toISOString().slice(0, 10), 3);
    }
  };
  const orgIndex = new Map(orgIds.map((id, index) => [id, index]));

  // --- probe sampler ------------------------------------------------------
  const probeLatencies: number[] = [];
  let poolPeak = 0;
  let poolMax = 1;
  const sampler = setInterval(() => {
    void (async () => {
      const started = process.hrtime.bigint();
      await withSystemDbAccessContext(() => db.execute(sql`
        SELECT count(*) FROM devices WHERE org_id = ${orgIds[0]!}::uuid`));
      probeLatencies.push(Number(process.hrtime.bigint() - started) / 1_000_000);
      const occupancy = await poolOccupancy();
      poolPeak = Math.max(poolPeak, occupancy.active);
      poolMax = occupancy.max;
    })();
  }, options.probeIntervalMs);

  // --- ticker + worker loop ----------------------------------------------
  const walBefore = await walLsnBytes();
  const deadline = Date.now() + options.windowMinutes * 60_000;
  const tickDrainSeconds: number[] = [];
  let ticks = 0;
  let runsCompleted = 0;
  let pagesCompleted = 0;
  let maxQueueDepth = 0;

  while (Date.now() < deadline) {
    const tickStarted = Date.now();
    // Backlog BEFORE this tick claims anything: this harness drives
    // claimDueDomains/runSyncDomain directly and never touches BullMQ (per
    // this wave's own "never drive through BullMQ" constraint), so there is
    // no real queue whose depth to sample — `claimed.length` is bounded by
    // `--tick-batch` and would always read as "healthy" at the default.
    // countDueDomains() (the same gauge feed `m365_sync_due_backlog` uses)
    // is the honest proxy: unclaimed backlog pressure.
    maxQueueDepth = Math.max(maxQueueDepth, await countDueDomains());
    const claimed = await claimDueDomains({ limit: options.tickBatch });
    const queue = [...claimed];
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const index = orgIndex.get(job.orgId);
        if (index === undefined) continue;
        executor.enqueue(
          `m365.sync.${job.domain}`, fixtureFor(index, `m365.sync.${job.domain}`) as never,
          orgTenantIds.get(job.orgId),
        );
        const outcome = await runSyncDomain(job);
        // 'noop' means the domain has no registered persister. After W05 all
        // six are registered, so a noop here is a wiring regression — and it
        // would flatter every number in the report, because a domain that does
        // no work drains instantly and invents utilisation headroom.
        if (outcome === 'noop') {
          throw new Error(
            `domain ${job.domain} returned 'noop' — no persister registered, so this run measures nothing`,
          );
        }
        // A sign-in run that still holds a continuation completed a PAGE, not a
        // run: the same row comes back due immediately, so counting it as a run
        // would understate ticker utilisation.
        if (outcome === 'partial-continue') {
          if (job.domain !== 'signin_activity') {
            throw new Error(`domain ${job.domain} returned 'partial-continue'; only signin_activity paginates`);
          }
          pagesCompleted += 1;
          continue;
        }
        runsCompleted += 1;
      }
    }));
    ticks += 1;
    tickDrainSeconds.push((Date.now() - tickStarted) / 1_000);
    const remaining = 60_000 - (Date.now() - tickStarted);
    if (remaining > 0 && Date.now() + remaining < deadline) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  // --- steady-state second pass ------------------------------------------
  // ONE anchor timestamp, captured before any second-pass write, used for
  // both sides of the comparison. Two separate "before"/"after" windows (an
  // earlier draft used `now() - interval '1 second'` for one and `now() -
  // interval '5 minutes'` for the other) measure different spans of wall
  // clock and can never validly subtract to "writes caused by this pass".
  const [mark] = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT now() AS mark`))) as unknown as { mark: string }[];
  await withSystemDbAccessContext(() => db.execute(sql`
    UPDATE m365_sync_state SET next_sync_at = now(), lease_until = NULL
    WHERE domain IN ('users','ca_policies','skus','secure_score')`));
  const secondPass = await claimDueDomains({ limit: options.tickBatch });
  for (const job of secondPass) {
    const index = orgIndex.get(job.orgId);
    if (index === undefined) continue;
    executor.enqueue(
      `m365.sync.${job.domain}`, fixtureFor(index, `m365.sync.${job.domain}`) as never,
      orgTenantIds.get(job.orgId),
    );
    await runSyncDomain(job);
  }
  const [writesAfter] = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT count(*) AS n FROM m365_users WHERE last_changed_at > ${mark!.mark}::timestamptz`))) as unknown as { n: string }[];

  clearInterval(sampler);
  const walAfter = await walLsnBytes();

  const report: BenchmarkReport = {
    options,
    ticks,
    runsCompleted,
    pagesCompleted,
    tickDrainSecondsP95: Number(percentile(tickDrainSeconds, 95).toFixed(2)),
    tickerUtilisation: runsCompleted / Math.max(options.tickBatch * ticks, 1),
    maxQueueDepth,
    walBytes: Number(walAfter - walBefore),
    poolOccupancyPeak: poolPeak,
    poolMax,
    probeP95Milliseconds: Number(percentile(probeLatencies, 95).toFixed(2)),
    entityWritesSecondPass: Number(writesAfter!.n),
  };
  console.log(formatReport(report));
  console.log(JSON.stringify(report, null, 2));

  await executor.close();
  if (!options.keepData) {
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM organizations WHERE name LIKE ${`${BENCH_TAG}-org-%`}`));
    // The seed step's own partner row (organizations cascade-deletes its
    // orgs, but not itself) — otherwise every run leaves one more
    // "m365-sync-benchmark partner" row behind.
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM partners WHERE slug LIKE ${`${BENCH_TAG}-%`}`));
  }
}

main()
  .catch((error) => {
    console.error(`[${BENCH_TAG}] failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => { await closeDb(); });
