// W3: workspace_ingest_jobs — RLS shape 1 cross-tenant probe + the
// one-active-job-per-partition partial unique index. Mirrors the
// workspaceRls.integration.test.ts bootstrap (:5433 stack, breeze_app role,
// asOrg GUC scoping) — see also visibilityIntersection.integration.test.ts
// for the same ADMIN_URL/APP_URL/port-guard/asOrg shape.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import type { WorkspaceDatabase } from '../hostTypes';
import { createIngestJobsService } from '../services/ingestJobsService';
import { createIngestJobRunner } from '../services/ingestJobRunner';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partnerA: string, partnerB: string, orgA: string, orgB: string;
let partnerC: string, orgC: string;

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);

  // Idempotently apply the migration — the shared :5433 stack may not yet
  // carry this table (or may have been reprovisioned by another branch's
  // integration run; see dev/README.md's re-apply gotcha).
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, '../../migrations/2026-07-25-ingest-jobs.sql'), 'utf8');
  await admin.begin(async (tx) => { await tx.unsafe(sql); });

  partnerA = randomUUID(); partnerB = randomUUID(); partnerC = randomUUID();
  orgA = randomUUID(); orgB = randomUUID(); orgC = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug)
              VALUES (${partnerA}, 'wsp-ingest-jobs-a', ${`wsp-ingest-jobs-a-${sfx}`}),
                     (${partnerB}, 'wsp-ingest-jobs-b', ${`wsp-ingest-jobs-b-${sfx}`}),
                     (${partnerC}, 'wsp-ingest-jobs-c', ${`wsp-ingest-jobs-c-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${orgA}, ${partnerA}, 'wsp-ingest-jobs-org-a', ${`wsp-ingest-jobs-org-a-${sfx}`}, 'USD'),
                     (${orgB}, ${partnerB}, 'wsp-ingest-jobs-org-b', ${`wsp-ingest-jobs-org-b-${sfx}`}, 'USD'),
                     (${orgC}, ${partnerC}, 'wsp-ingest-jobs-org-c', ${`wsp-ingest-jobs-org-c-${sfx}`}, 'USD')`;
});

afterAll(async () => {
  await admin`DELETE FROM workspace_ingest_jobs WHERE org_id IN (${orgA}, ${orgB}, ${orgC})`;
  await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB}, ${orgC})`;
  await admin`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB}, ${partnerC})`;
  await admin.end(); await app.end();
});

/** Run the service as breeze_app inside an org's access context (mirrors withDbAccessContext). */
async function withOrg<T>(org: string, partner: string, fn: (db: WorkspaceDatabase) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(transaction as unknown as WorkspaceDatabase);
  }) as Promise<T>;
}

/** Run fn as breeze_app inside the given org's access context (mirrors withDbAccessContext set_configs). */
async function asOrg<T>(org: string, partner: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(tx);
  }) as Promise<T>;
}

describe('workspace_ingest_jobs RLS (W3, cross-tenant as breeze_app)', () => {
  it('org A can insert a job and read it back', async () => {
    const id = randomUUID();
    await asOrg(orgA, partnerA, (tx) =>
      tx`INSERT INTO workspace_ingest_jobs (id, org_id, trigger) VALUES (${id}, ${orgA}, 'manual')`);
    try {
      const rows = await asOrg(orgA, partnerA, (tx) =>
        tx`SELECT id FROM workspace_ingest_jobs WHERE id = ${id}`);
      expect(rows).toHaveLength(1);
    } finally {
      await admin`DELETE FROM workspace_ingest_jobs WHERE id = ${id}`;
    }
  });

  it('org B context reads zero rows for org A jobs', async () => {
    const id = randomUUID();
    await admin`INSERT INTO workspace_ingest_jobs (id, org_id, trigger) VALUES (${id}, ${orgA}, 'manual')`;
    try {
      const rows = await asOrg(orgB, partnerB, (tx) =>
        tx`SELECT id FROM workspace_ingest_jobs WHERE org_id = ${orgA}`);
      expect(rows).toHaveLength(0); // RLS silent-0-row read, not an error
    } finally {
      await admin`DELETE FROM workspace_ingest_jobs WHERE id = ${id}`;
    }
  });

  it('org B context cannot forge an insert for org A (RLS WITH CHECK)', async () => {
    await expect(
      asOrg(orgB, partnerB, (tx) =>
        tx`INSERT INTO workspace_ingest_jobs (org_id, trigger) VALUES (${orgA}, 'manual')`)
    ).rejects.toThrow(/row-level security policy for table "workspace_ingest_jobs"/);
  });

  it('one-active-job-per-partition: a second pending/running insert for the same (org, NULL source) throws', async () => {
    const first = randomUUID();
    await asOrg(orgA, partnerA, (tx) =>
      tx`INSERT INTO workspace_ingest_jobs (id, org_id, trigger, status) VALUES (${first}, ${orgA}, 'manual', 'pending')`);
    try {
      await expect(
        asOrg(orgA, partnerA, (tx) =>
          tx`INSERT INTO workspace_ingest_jobs (org_id, trigger, status) VALUES (${orgA}, 'manual', 'pending')`)
      ).rejects.toThrow(/duplicate key value violates unique constraint "wsp_ingest_jobs_one_active_idx"/);
    } finally {
      await admin`DELETE FROM workspace_ingest_jobs WHERE id = ${first}`;
    }
  });

  it('completing the active job frees the partial index for a new insert', async () => {
    const first = randomUUID();
    await asOrg(orgA, partnerA, (tx) =>
      tx`INSERT INTO workspace_ingest_jobs (id, org_id, trigger, status) VALUES (${first}, ${orgA}, 'manual', 'pending')`);
    await asOrg(orgA, partnerA, (tx) =>
      tx`UPDATE workspace_ingest_jobs SET status = 'complete', updated_at = now() WHERE id = ${first}`);
    const second = randomUUID();
    await asOrg(orgA, partnerA, (tx) =>
      tx`INSERT INTO workspace_ingest_jobs (id, org_id, trigger, status) VALUES (${second}, ${orgA}, 'manual', 'pending')`);
    await admin`DELETE FROM workspace_ingest_jobs WHERE id IN (${first}, ${second})`;
  });
});

describe('ingestJobsService lifecycle (W3, real PG as breeze_app)', () => {
  const svc = (db: WorkspaceDatabase) => createIngestJobsService(db);

  it('recovers a real wrapped 23505 without aborting the outer org transaction', async () => {
    await admin`DELETE FROM workspace_ingest_jobs WHERE org_id = ${orgC}`;
    const winner = await withOrg(orgC, partnerC, (db) => svc(db).ensureJob(orgC, { trigger: 'manual' }));
    let firstExecute = true;
    let insertError: unknown;
    // Deterministically model losing the NOT EXISTS race: replace only the
    // first INSERT with an unconditional duplicate, but execute it on the real
    // Drizzle connection/savepoint. PostgreSQL itself raises and aborts 23505.
    function losingRacer(db: WorkspaceDatabase): WorkspaceDatabase {
      return new Proxy(db, {
        get(target, property) {
          if (property === 'transaction') {
            return (fn: (tx: WorkspaceDatabase) => Promise<unknown>) =>
              target.transaction((tx) => fn(losingRacer(tx)));
          }
          if (property === 'execute') {
            return async (query: Parameters<WorkspaceDatabase['execute']>[0]) => {
              if (!firstExecute) return target.execute(query);
              firstExecute = false;
              try {
                return await target.execute(sql`INSERT INTO workspace_ingest_jobs (org_id, trigger)
                  VALUES (${orgC}::uuid, 'manual') RETURNING *`);
              } catch (error) {
                insertError = error;
                throw error;
              }
            };
          }
          return Reflect.get(target, property);
        },
      });
    }
    try {
      await withOrg(orgC, partnerC, async (db) => {
        const result = await svc(losingRacer(db)).ensureJob(orgC, { trigger: 'manual', force: true });
        expect(insertError).toBeInstanceOf(DrizzleQueryError);
        expect(pgErrorCode(insertError)).toBe('23505');
        expect(result.created).toBe(false);
        expect(result.job.id).toBe(winner.job.id);
        expect(result.job.force).toBe(true);
        // A fresh statement on the outer transaction must remain usable.
        expect((await svc(db).get(orgC, winner.job.id))?.force).toBe(true);
      });
    } finally {
      await admin`DELETE FROM workspace_ingest_jobs WHERE org_id = ${orgC}`;
    }
  });

  it('drives ensure → claim → progress → yield → transient backoff → phase_complete → complete', async () => {
    // ensure: a fresh org-wide job is created pending in the ingest phase
    const ensured = await withOrg(orgC, partnerC, (db) => svc(db).ensureJob(orgC, { trigger: 'manual' }));
    expect(ensured.created).toBe(true);
    expect(ensured.job.status).toBe('pending');
    expect(ensured.job.phase).toBe('ingest');
    const jobId = ensured.job.id;

    // ensure again is idempotent for a live partition: same job, created=false
    const again = await withOrg(orgC, partnerC, (db) => svc(db).ensureJob(orgC, { trigger: 'manual' }));
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(jobId);

    // claim: pending → running, started_at stamped from the DB clock
    const claimed = await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC));
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).toBeInstanceOf(Date);

    // progress: cursor + shallow stats merge, heartbeat bump
    await withOrg(orgC, partnerC, (db) =>
      svc(db).recordProgress(orgC, jobId, { cursor: 'page-2', statsPatch: { seen: 5 } }));
    const afterProgress = await withOrg(orgC, partnerC, (db) => svc(db).get(orgC, jobId));
    expect(afterProgress?.cursor).toBe('page-2');
    expect(afterProgress?.stats).toMatchObject({ seen: 5 });

    // counter accumulation: counterPatch keys SUM SQL-side across calls while
    // statsPatch keys overwrite. Two `ingested` deltas (2 then 3) → stored 5;
    // `remaining` (absolute) keeps only the last write; `seen` is untouched.
    await withOrg(orgC, partnerC, (db) =>
      svc(db).recordProgress(orgC, jobId, { counterPatch: { ingested: 2 }, statsPatch: { remaining: 9 } }));
    await withOrg(orgC, partnerC, (db) =>
      svc(db).recordProgress(orgC, jobId, { counterPatch: { ingested: 3 }, statsPatch: { remaining: 4 } }));
    const afterCounters = await withOrg(orgC, partnerC, (db) => svc(db).get(orgC, jobId));
    expect(afterCounters?.stats).toMatchObject({ ingested: 5, remaining: 4, seen: 5 });

    // yield: budget spent, work remains → pending, immediately due again
    const yielded = await withOrg(orgC, partnerC, (db) => svc(db).release(orgC, jobId, { kind: 'yield' }));
    expect(yielded?.status).toBe('pending');
    const reclaimed = await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC));
    expect(reclaimed?.id).toBe(jobId);
    expect(reclaimed?.status).toBe('running');

    // transient error: attempts → 1, pending, next_attempt_at pushed into the future
    const transient = await withOrg(orgC, partnerC, (db) =>
      svc(db).release(orgC, jobId, { kind: 'transient_error', error: 'flaky read' }));
    expect(transient?.status).toBe('pending');
    expect(transient?.attempts).toBe(1);
    expect(transient?.lastError).toBe('flaky read');
    const [{ future }] = await admin`
      SELECT next_attempt_at > now() AS future FROM workspace_ingest_jobs WHERE id = ${jobId}`;
    expect(future).toBe(true);

    // not due while backing off: claim returns null
    const notDue = await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC));
    expect(notDue).toBeNull();

    // time-travel the backoff into the past (admin conn) and re-claim
    await admin`UPDATE workspace_ingest_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = ${jobId}`;
    const afterBackoff = await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC));
    expect(afterBackoff?.id).toBe(jobId);
    expect(afterBackoff?.status).toBe('running');

    // phase_complete: → enrich, attempts reset, cursor cleared, pending + due
    const phased = await withOrg(orgC, partnerC, (db) =>
      svc(db).release(orgC, jobId, { kind: 'phase_complete', nextPhase: 'enrich' }));
    expect(phased?.phase).toBe('enrich');
    expect(phased?.attempts).toBe(0);
    expect(phased?.cursor).toBeNull();
    expect(phased?.status).toBe('pending');

    // claim the enrich phase, then complete it
    const enrichClaim = await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC));
    expect(enrichClaim?.id).toBe(jobId);
    const done = await withOrg(orgC, partnerC, (db) => svc(db).release(orgC, jobId, { kind: 'complete' }));
    expect(done?.status).toBe('complete');
    expect(done?.finishedAt).toBeInstanceOf(Date);

    // drained: nothing due
    expect(await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC))).toBeNull();

    await admin`DELETE FROM workspace_ingest_jobs WHERE id = ${jobId}`;
  });

  it('reclaims a running job whose heartbeat is older than the 5-minute stale window', async () => {
    const staleId = randomUUID();
    await admin`INSERT INTO workspace_ingest_jobs (id, org_id, trigger, status, started_at, updated_at)
                VALUES (${staleId}, ${orgC}, 'manual', 'running',
                        now() - interval '6 minutes', now() - interval '6 minutes')`;
    const reclaimed = await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC));
    expect(reclaimed?.id).toBe(staleId);
    expect(reclaimed?.status).toBe('running');
    await admin`DELETE FROM workspace_ingest_jobs WHERE id = ${staleId}`;
  });

  it('claimDue returns null when the org has no due jobs', async () => {
    expect(await withOrg(orgC, partnerC, (db) => svc(db).claimDue(orgC))).toBeNull();
  });
});

// W3 Task 5, Step 5: the runner's own state-machine unit tests (ingestJobRunner.test.ts)
// fake the jobs service; this smoke test flips that — a REAL, RLS-scoped
// jobsService against PG, driven by the runner with fake content/enrichment/
// crosswalk services. No HTTP: this exercises exactly the in-request
// ensure→advance wiring the agent/admin routes call, without a live server.
describe('ingestJobRunner smoke (W3, real PG jobs service + fake content services)', () => {
  it('drives ensure -> advance through ingest -> enrich -> crosswalk -> complete against real PG', async () => {
    const contentIngest = { run: vi.fn(async () => ({ processed: 1, remaining: 0, errors: [], transient: null })) };
    const enrichment = { run: vi.fn(async () => ({ processed: 1, remaining: 0, errors: [] })) };
    const crosswalk = { run: vi.fn(async () => ({ mined: 0 })) };
    const getSettings = vi.fn(async () => ({ contentEnabled: true }));

    function runnerFor(db: WorkspaceDatabase) {
      return createIngestJobRunner({
        jobs: createIngestJobsService(db),
        contentIngest,
        enrichment,
        crosswalk,
        getSettings,
        log: () => {},
      });
    }

    const ensured = await withOrg(orgC, partnerC, (db) =>
      createIngestJobsService(db).ensureJob(orgC, { trigger: 'manual' }));
    expect(ensured.created).toBe(true);
    expect(ensured.job.phase).toBe('ingest');
    const jobId = ensured.job.id;

    // advance #1: claims the pending ingest-phase job, runs one fake ingest
    // batch (remaining: 0) -> phase_complete -> enrich, handed back pending.
    const afterIngest = await withOrg(orgC, partnerC, (db) =>
      runnerFor(db).advance(orgC, { budgetMs: 5_000, batch: 8 }));
    expect(afterIngest.advanced).toBe(true);
    expect(afterIngest.job?.id).toBe(jobId);
    expect(afterIngest.job?.phase).toBe('enrich');
    expect(afterIngest.job?.status).toBe('pending');
    expect(contentIngest.run).toHaveBeenCalledTimes(1);
    expect(enrichment.run).not.toHaveBeenCalled();

    // advance #2: claims the enrich-phase job, one fake enrich batch
    // (remaining: 0) -> phase_complete -> crosswalk.
    const afterEnrich = await withOrg(orgC, partnerC, (db) =>
      runnerFor(db).advance(orgC, { budgetMs: 5_000, batch: 8 }));
    expect(afterEnrich.job?.phase).toBe('crosswalk');
    expect(afterEnrich.job?.status).toBe('pending');
    expect(enrichment.run).toHaveBeenCalledTimes(1);
    expect(crosswalk.run).not.toHaveBeenCalled();

    // advance #3: claims the crosswalk-phase job, runs crosswalk once -> complete.
    const afterCrosswalk = await withOrg(orgC, partnerC, (db) =>
      runnerFor(db).advance(orgC, { budgetMs: 5_000, batch: 8 }));
    expect(afterCrosswalk.job?.status).toBe('complete');
    expect(afterCrosswalk.job?.finishedAt).toBeInstanceOf(Date);
    expect(crosswalk.run).toHaveBeenCalledTimes(1);

    // W3 binding constraint: every advancement path consults
    // getOrgSettings(...).contentEnabled per org — verify the runner honors a
    // false read by never claiming, on a freshly ensured job.
    const ensured2 = await withOrg(orgC, partnerC, (db) =>
      createIngestJobsService(db).ensureJob(orgC, { trigger: 'manual' }));
    getSettings.mockResolvedValueOnce({ contentEnabled: false });
    const blocked = await withOrg(orgC, partnerC, (db) =>
      runnerFor(db).advance(orgC, { budgetMs: 5_000, batch: 8 }));
    expect(blocked).toEqual({ advanced: false, job: null });

    await admin`DELETE FROM workspace_ingest_jobs WHERE id IN (${jobId}, ${ensured2.job.id})`;
  });
});
