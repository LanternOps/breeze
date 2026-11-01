#!/usr/bin/env tsx
/**
 * Partner group evaluation capacity benchmark (#10521 W2b). NOT run in CI.
 * Writes 9,960 devices and 1,195,200 software rows. Requires an isolated DB
 * and Redis on production-class infrastructure (the 1-vCPU managed DB class),
 * with no other Breeze workers. Never point it at a customer fleet.
 *
 * Acceptance is fixed BEFORE the run in ./partner-group-eval-benchmark.lib.ts:
 * cold <=60s/0 failed orgs; steady <=30s/0 writes; filter p95 <=250ms,
 * large org <=400ms; churn <=900s/job p95 <=200ms/0 failures/0 deadlocks;
 * sweep <=600s; foreground probe p95 <=50ms. --skip-churn is diagnostic only
 * and deliberately cannot produce a passing acceptance report.
 *
 * PARTNER_GROUP_BENCHMARK_CONFIRM=1 pnpm --filter @breeze/api partner-group-eval:benchmark
 * Options: --keep-data, --cleanup (only tagged fixtures), --skip-churn.
 * Use --cleanup before repeating a --keep-data run. The driver never starts
 * the partner evaluation worker: it drains injected jobs in memory, serially.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type SQL } from 'drizzle-orm';
import { db, closeDb, withSystemDbAccessContext } from '../src/db';
import {
  createDeviceGroupReevaluationWorker, getDeviceGroupReevaluationQueue,
  scheduleDeviceGroupReevaluation, shutdownDeviceGroupJobs,
} from '../src/jobs/deviceGroupJobs';
import {
  processPartnerGroupEvaluation, runPartnerGroupSweep,
  type PartnerGroupEvaluationJobData,
} from '../src/jobs/partnerGroupEvaluationJobs';
import {
  getPeripheralPolicyDistributionQueue, shutdownPeripheralJobs,
} from '../src/jobs/peripheralJobs';
import { closeRedis } from '../src/services/redis';
import { SOFTWARE_GROUP_FILTER_FIELDS } from '../src/services/softwareGroupFilterFields';
import { cascadeDeletePartner } from '../src/services/tenantCascade';
import type { PartnerGroupOrgResult } from '../src/services/partnerGroupEvaluation';
import { pgErrorCode } from '../src/utils/pgErrors';
import {
  evaluateBenchmarkResult, formatReport, parseBenchmarkArgs, percentile,
  type PartnerGroupBenchmarkResult,
} from './partner-group-eval-benchmark.lib';

const TAG = 'partner-group-eval-benchmark';
const TARGET_NAMES = ['PowerChute Business Edition Agent', ...Array.from({ length: 9 }, (_, i) => `Benchmark Target ${i + 1}`)];
const probeId = randomUUID();
const probeMs: number[] = [];
type Fleet = { partnerId: string; largeOrgId: string; groupIds: string[] };

async function query<T extends Record<string, unknown>>(statement: SQL) {
  return withSystemDbAccessContext(async () => [...await db.execute<T>(statement)], TAG);
}
function requireFirst<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('benchmark query unexpectedly returned no rows');
  return row;
}
function head(groupId: string): PartnerGroupEvaluationJobData {
  return { type: 'partner-group-evaluation', groupId, revision: null, afterOrgId: null,
    failedOrgs: 0, evaluatedOrgs: 0, reason: TAG, queuedAt: new Date().toISOString() };
}

async function seed(partnerId: string): Promise<Fleet> {
  await query(sql`
    INSERT INTO partners (id, name, slug, status, settings)
    VALUES (${partnerId}, ${TAG}, ${`${TAG}-${partnerId}`}, 'active', jsonb_build_object('benchmark', ${TAG}::text))
  `);
  // Set-based org/site/device/software generation; each device-writing
  // transaction touches ONE org, preserving the export advisory-lock order.
  await query(sql`
    INSERT INTO organizations (partner_id, name, slug, type, status, settings, currency_code)
    SELECT ${partnerId}::uuid, ${TAG} || '-org-' || n, 'benchmark-org-' || n, 'customer', 'active',
      jsonb_build_object('benchmark', ${TAG}::text, 'ordinal', n), 'USD'
    FROM generate_series(0, 199) n
  `);
  const orgs = await query<{ id: string; ordinal: number }>(sql`
    SELECT id, (settings->>'ordinal')::integer AS ordinal FROM organizations
    WHERE partner_id = ${partnerId} ORDER BY id
  `);
  let largeOrgId: string | undefined;
  for (const org of orgs) {
    if (org.ordinal === 199) largeOrgId = org.id;
    await withSystemDbAccessContext(async () => {
      const site = requireFirst([...await db.execute<{ id: string }>(sql`
        INSERT INTO sites (org_id, name) VALUES (${org.id}, ${TAG}) RETURNING id
      `)]);
      await db.execute(sql`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version,
          architecture, agent_version, is_ephemeral)
        SELECT ${org.id}::uuid, ${site.id}::uuid, gen_random_uuid()::text,
          'benchmark-device-' || n, 'linux', '1', 'amd64', '1', false
        FROM generate_series(0, ${org.ordinal === 199 ? 1999 : 39}) n
      `);
      await db.execute(sql`
        INSERT INTO software_inventory (device_id, org_id, name, version, vendor)
        SELECT d.id, d.org_id, 'Benchmark Common Software ' || n, '1', ${TAG}
        FROM devices d CROSS JOIN generate_series(1, 119) n WHERE d.org_id = ${org.id}
      `);
      await db.execute(sql`
        INSERT INTO software_inventory (device_id, org_id, name, version, vendor)
        SELECT id, org_id, (ARRAY[${sql.join(TARGET_NAMES.map(name => sql`${name}`), sql`, `)}]::text[])
          [(substring(hostname from '[0-9]+$')::integer % 10) + 1], '1', ${TAG}
        FROM devices WHERE org_id = ${org.id}
      `);
    }, `${TAG}.seedOrg`);
  }
  if (!largeOrgId) throw new Error('large benchmark org missing');
  const groupIds: string[] = [];
  for (const [index, name] of TARGET_NAMES.entries()) {
    const filter = { operator: 'AND', conditions: [{ field: 'software.installed', operator: 'equals', value: name }] };
    const group = requireFirst(await query<{ id: string }>(sql`
      INSERT INTO device_groups (partner_id, org_id, name, type, filter_conditions, filter_fields_used)
      VALUES (${partnerId}, NULL, ${`${TAG}-group-${index}`}, 'dynamic', ${JSON.stringify(filter)}::jsonb,
        ARRAY['software.installed']::text[]) RETURNING id
    `));
    groupIds.push(group.id);
  }
  return { partnerId, largeOrgId, groupIds };
}

async function evaluateJobs(pending: PartnerGroupEvaluationJobData[]): Promise<PartnerGroupOrgResult[]> {
  const results: PartnerGroupOrgResult[] = [];
  const enqueue = async (data: PartnerGroupEvaluationJobData) => { pending.push(data); };
  let pages = 0;
  while (pending.length > 0) {
    const data = pending.shift();
    if (!data) break;
    if (++pages > 10_000) throw new Error('benchmark job drain exceeded 10,000 pages');
    const result = await processPartnerGroupEvaluation(data, { enqueue });
    if (result.status === 'gone' || result.status === 'superseded') {
      throw new Error(`unexpected benchmark group state: ${result.status}`);
    }
    results.push(...result.orgResults);
  }
  return results;
}
function assertEvaluated(results: PartnerGroupOrgResult[], expected: number): void {
  if (results.length !== expected || results.some(result => !result.ok || result.status !== 'evaluated')) {
    throw new Error(`benchmark expected ${expected} successful org evaluations; got ${results.length}, failures=${results.filter(r => !r.ok).length}`);
  }
}

/** One query at a time, on its own context/connection, sampled every 250ms. */
async function withProbe<T>(work: () => Promise<T>): Promise<T> {
  let stop = false;
  let probeError: unknown;
  const probing = (async () => {
    while (!stop) {
      const started = performance.now();
      // An unrelated indexed lookup (absent id) never takes a fleet row lock.
      await query(sql`SELECT id FROM devices WHERE id = ${probeId}`);
      probeMs.push(performance.now() - started);
      await sleep(Math.max(0, 250 - (performance.now() - started)));
    }
  })().catch(error => { probeError = error; });
  try { return await work(); }
  finally {
    stop = true;
    await probing;
    if (probeError) throw probeError;
  }
}
async function deadlocks(): Promise<number> {
  const row = requireFirst(await query<{ deadlocks: string }>(sql`
    SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()
  `));
  return Number(row.deadlocks);
}

async function churn(fleet: Fleet, competingWholeGroup: boolean) {
  const queue = getDeviceGroupReevaluationQueue();
  const deviceRows = await query<{ id: string; orgId: string }>(sql`
    SELECT d.id, d.org_id AS "orgId" FROM devices d JOIN organizations o ON o.id = d.org_id
    WHERE o.partner_id = ${fleet.partnerId} ORDER BY d.org_id, d.id
  `);
  if (deviceRows.length !== 9960) throw new Error(`expected 9960 devices, got ${deviceRows.length}`);
  // Materialize all ten groups before changing inventory. Every device belongs
  // to one target; rotating it changes that device's result in two groups.
  // The pure run (no competing writer) measures drain and job p95 with every
  // membership write done by the per-device jobs; the mixed run races
  // whole-group evaluations against the same (group, org) keys for 40P01.
  assertEvaluated(await evaluateJobs(fleet.groupIds.map(head)), 2000);
  const orgIds = [...new Set(deviceRows.map(device => device.orgId))];
  for (const orgId of orgIds) {
    await query(sql`
      UPDATE software_inventory s SET name = names.next
      FROM (VALUES ${sql.join(TARGET_NAMES.map((name, i) => sql`(${name}, ${TARGET_NAMES[(i + 1) % TARGET_NAMES.length] ?? TARGET_NAMES[0]})`), sql`, `)}) names(previous, next)
      WHERE s.org_id = ${orgId} AND s.vendor = ${TAG} AND s.name = names.previous
    `);
  }
  const beforeDeadlocks = await deadlocks();
  const started = performance.now();
  const failures = new Set<string>();
  const finished = new Set<string>();
  const jobMs: number[] = [];
  let deadlockAttempts = 0;
  let workerError: unknown;
  const worker = createDeviceGroupReevaluationWorker();
  worker.on('completed', job => {
    finished.add(job.data.deviceId);
    if (job.finishedOn === undefined || job.processedOn === undefined) {
      workerError = new Error('completed job has no timing metadata');
    } else jobMs.push(job.finishedOn - job.processedOn);
  });
  // Failed events include retry attempts; a recovered 40P01 still fails the
  // benchmark, even if BullMQ eventually marks that job completed.
  worker.on('failed', (job, error) => {
    if (!job) { workerError = error; return; }
    failures.add(job.data.deviceId);
    if (pgErrorCode(error) === '40P01' || /40P01|deadlock detected/i.test(error.message)) deadlockAttempts += 1;
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) finished.add(job.data.deviceId);
  });
  worker.on('error', error => { workerError = error; });
  let stop = false;
  let concurrentError: unknown;
  const competing = (async () => {
    if (!competingWholeGroup) return;
    do {
      // One complete pass even if churn drains early, then repeat until drain.
      for (const groupId of fleet.groupIds) assertEvaluated(await evaluateJobs([head(groupId)]), 200);
    } while (!stop);
  })().catch(error => { concurrentError = error; });
  try {
    for (let offset = 0; offset < deviceRows.length; offset += 100) {
      await Promise.all(deviceRows.slice(offset, offset + 100).map(device => scheduleDeviceGroupReevaluation({
        deviceId: device.id, orgId: device.orgId, eventType: 'device.updated',
        changedFields: [...SOFTWARE_GROUP_FILTER_FIELDS], reason: TAG,
      })));
    }
    while (finished.size < deviceRows.length) {
      if (workerError) throw workerError;
      if (concurrentError) throw concurrentError;
      if (performance.now() - started > 1_800_000) throw new Error('churn did not drain within 30 minutes');
      await sleep(250);
    }
    const drainSeconds = (performance.now() - started) / 1000;
    stop = true;
    await competing;
    if (workerError) throw workerError;
    if (concurrentError) throw concurrentError;
    const afterDeadlocks = await deadlocks();
    console.log(`[${TAG}] churn (${competingWholeGroup ? 'mixed' : 'pure'}) database deadlock delta=${afterDeadlocks - beforeDeadlocks}, deadlock attempts=${deadlockAttempts}, completed=${jobMs.length}, failed jobs=${failures.size}`);
    return {
      churnDrainSeconds: drainSeconds, churnJobP95Ms: jobMs.length ? percentile(jobMs, 95) : null,
      churnFailedJobs: failures.size, churnDeadlocks: Math.max(afterDeadlocks - beforeDeadlocks, deadlockAttempts),
    };
  } finally {
    stop = true;
    await worker.close();
    await competing;
    // Retained jobs belong to this fixture only; never obliterate a queue.
    for (const device of deviceRows) {
      const job = await queue.getJob(`group-reeval-${device.id}`);
      if (job) await job.remove();
    }
  }
}

async function cleanup(partnerId?: string): Promise<void> {
  const partners = await query<{ id: string }>(sql`
    SELECT id FROM partners WHERE settings->>'benchmark' = ${TAG}
      ${partnerId ? sql`AND id = ${partnerId}` : sql``} ORDER BY id
  `);
  for (const partner of partners) {
    const devices = await query<{ id: string }>(sql`
      SELECT d.id FROM devices d JOIN organizations o ON o.id = d.org_id WHERE o.partner_id = ${partner.id}
    `);
    const queues = [getDeviceGroupReevaluationQueue(), getPeripheralPolicyDistributionQueue()];
    for (const queue of queues) {
      if ((await queue.getWorkers()).length) throw new Error('stop external workers before benchmark cleanup');
    }
    for (let offset = 0; offset < devices.length; offset += 100) {
      await Promise.all(devices.slice(offset, offset + 100).map(async device => {
        const reeval = await getDeviceGroupReevaluationQueue().getJob(`group-reeval-${device.id}`);
        if (reeval) await reeval.remove();
        const peripheral = await getPeripheralPolicyDistributionQueue().getJob(`policy-reconciliation-${device.id}`);
        if (peripheral) await peripheral.remove();
      }));
    }
    // This helper owns its contexts: NEVER wrap the cross-org cascade in one.
    await cascadeDeletePartner(partner.id, '00000000-0000-0000-0000-000000000000');
  }
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  if (process.env.PARTNER_GROUP_BENCHMARK_CONFIRM !== '1') {
    throw new Error('PARTNER_GROUP_BENCHMARK_CONFIRM=1 is required: this writes a large synthetic fleet');
  }
  if (options.cleanup) { await cleanup(); return; }
  for (const queue of [getDeviceGroupReevaluationQueue(), getPeripheralPolicyDistributionQueue()]) {
    if ((await queue.getWorkers()).length) throw new Error('benchmark requires isolated Redis with no other workers');
    const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'paused');
    if (Object.values(counts).some(count => count > 0)) throw new Error('benchmark requires empty work queues');
  }
  const groups = await query(sql`SELECT id FROM device_groups WHERE type = 'dynamic' AND filter_conditions IS NOT NULL LIMIT 1`);
  if (groups.length) throw new Error('benchmark requires an isolated DB without existing dynamic groups; use --cleanup for retained fixtures');
  const runPartnerId = randomUUID();
  let fleet: Fleet | undefined;
  try {
    console.log(`[${TAG}] seeding 200 orgs, 9960 devices, 1195200 inventory rows`);
    fleet = await seed(runPartnerId);
    const groupId = fleet.groupIds[0];
    if (!groupId) throw new Error('benchmark group missing');
    const coldStarted = performance.now();
    const cold = await withProbe(() => evaluateJobs([head(groupId)]));
    const coldEvalSeconds = (performance.now() - coldStarted) / 1000;
    if (cold.length !== 200) throw new Error(`cold evaluation covered ${cold.length} orgs, expected 200`);
    // Every 10th device carries the group-0 target: 199 × 4 + 200 = 996 members.
    const coldAdded = cold.reduce((count, org) => count + org.added, 0);
    console.log(`[${TAG}] cold evaluation materialized ${coldAdded} memberships`);
    if (coldAdded !== 996) throw new Error(`cold evaluation added ${coldAdded} memberships, expected 996`);
    const steadyStarted = performance.now();
    const steady = await evaluateJobs([head(groupId)]);
    const steadyStateSeconds = (performance.now() - steadyStarted) / 1000;
    assertEvaluated(steady, 200);
    const large = cold.find(result => result.orgId === fleet?.largeOrgId);
    if (!large) throw new Error('large-org measurement missing');
    const churnResult = options.skipChurn
      ? { churnDrainSeconds: null, churnJobP95Ms: null, churnFailedJobs: null, churnDeadlocks: null }
      : await (async () => {
        const pure = await churn(fleet, false);
        const mixed = await churn(fleet, true);
        console.log(`[${TAG}] mixed churn: drain=${mixed.churnDrainSeconds.toFixed(1)}s jobP95=${mixed.churnJobP95Ms}ms failed=${mixed.churnFailedJobs} deadlocks=${mixed.churnDeadlocks}`);
        return { ...pure,
          churnFailedJobs: pure.churnFailedJobs + mixed.churnFailedJobs,
          churnDeadlocks: pure.churnDeadlocks + mixed.churnDeadlocks };
      })();
    const sweepStarted = performance.now();
    await withProbe(async () => {
      const pending: PartnerGroupEvaluationJobData[] = [];
      const counts = await runPartnerGroupSweep({ random: () => 0,
        enqueue: async data => { pending.push(data); } });
      if (counts.partnerGroups !== 10 || counts.orgGroups !== 0) throw new Error('unexpected sweep fixture size');
      assertEvaluated(await evaluateJobs(pending), 2000);
    });
    const result: PartnerGroupBenchmarkResult = {
      coldEvalSeconds, coldFailedOrgs: cold.filter(result => !result.ok).length,
      steadyStateSeconds, steadyStateMembershipWrites: steady.reduce((count, org) => count + org.added + org.removed, 0),
      perOrgFilterP95Ms: percentile(cold.map(org => org.filterMs), 95), largeOrgFilterMs: large.filterMs,
      ...churnResult, sweepSeconds: (performance.now() - sweepStarted) / 1000, probeP95Ms: percentile(probeMs, 95),
    };
    console.log(formatReport(result));
    const verdict = evaluateBenchmarkResult(result);
    if (!verdict.pass) { console.error(verdict.failures.join('\n')); process.exitCode = 1; }
  } finally {
    if (!options.keepData) await cleanup(runPartnerId);
    else console.log(`[${TAG}] retained partner ${runPartnerId}; remove with --cleanup`);
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await shutdownDeviceGroupJobs();
  await shutdownPeripheralJobs();
  await closeRedis();
  await closeDb();
});
