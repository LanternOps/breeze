import { randomUUID } from 'node:crypto';
import type { WorkspaceDatabase } from '../hostTypes';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBatchUpsertService, type BatchEntry } from '../services/batchUpsertService';
import { createCrawlRunsService } from '../services/crawlRunsService';
import { createSourcesService } from '../services/sourcesService';

const ADMIN_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP
  ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

if (new URL(ADMIN_URL).port === '5432' || new URL(APP_URL).port === '5432') {
  throw new Error('refusing to run against :5432 — use the test stack (:5433)');
}

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partnerId: string;
let orgId: string;
let siteId: string;
let deviceA: string;
let deviceB: string;
let smbSourceId: string;
let localSourceId: string;

type AppContext = {
  tx: postgres.TransactionSql;
  sources: ReturnType<typeof createSourcesService>;
  runs: ReturnType<typeof createCrawlRunsService>;
  batches: ReturnType<typeof createBatchUpsertService>;
};

async function asOrg<T>(fn: (context: AppContext) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } })
      .session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgId}, true),
                    set_config('breeze.accessible_org_ids', ${orgId}, true),
                    set_config('breeze.accessible_partner_ids', ${partnerId}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    const db = transaction as unknown as WorkspaceDatabase;
    return fn({
      tx,
      sources: createSourcesService(db),
      runs: createCrawlRunsService(db),
      batches: createBatchUpsertService(db),
    });
  });
}

function entry(
  relPath: string,
  options: Partial<Omit<BatchEntry, 'relPath'>> = {},
): BatchEntry {
  const slash = relPath.lastIndexOf('/');
  const name = relPath.slice(slash + 1);
  return {
    relPath,
    parentPath: slash < 0 ? '' : relPath.slice(0, slash),
    name,
    isDir: false,
    size: 100,
    mtime: '2026-07-12T12:00:00.000Z',
    ctime: null,
    ext: name.includes('.') ? name.split('.').at(-1) : null,
    attrs: {},
    ...options,
  };
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partnerId = randomUUID();
  orgId = randomUUID();
  siteId = randomUUID();
  deviceA = randomUUID();
  deviceB = randomUUID();
  const suffix = randomUUID();

  await admin`INSERT INTO partners (id, name, slug)
              VALUES (${partnerId}, 'workspace crawler integration', ${`wsp-crawler-${suffix}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug)
              VALUES (${orgId}, ${partnerId}, 'workspace crawler org', ${`wsp-crawler-org-${suffix}`})`;
  await admin`INSERT INTO sites (id, org_id, name)
              VALUES (${siteId}, ${orgId}, 'workspace crawler site')`;
  await admin`INSERT INTO devices
                (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
              VALUES
                (${deviceA}, ${orgId}, ${siteId}, ${`wsp-crawler-a-${suffix}`}, 'crawler-a', 'windows', '11', 'amd64', 'test'),
                (${deviceB}, ${orgId}, ${siteId}, ${`wsp-crawler-b-${suffix}`}, 'crawler-b', 'windows', '11', 'amd64', 'test')`;

  await asOrg(async ({ sources, tx }) => {
    const smb = await sources.create(orgId, {
      kind: 'smb_share',
      displayName: 'Crawler SMB share',
      rootPath: '\\\\server\\share',
      crawlDeviceId: deviceA,
      visibilityGroupIds: [],
      crawlCadenceMinutes: 60,
      excludeGlobs: [],
      watch: false,
      status: 'active',
    });
    const local = await sources.create(orgId, {
      kind: 'local_profile',
      displayName: 'Crawler local profiles',
      rootPath: '/Users',
      crawlDeviceId: null,
      visibilityGroupIds: [],
      crawlCadenceMinutes: 60,
      excludeGlobs: [],
      watch: false,
      status: 'active',
    });
    smbSourceId = smb.id;
    localSourceId = local.id;

    const rows = await tx<Array<{ id: string; kind: string; crawl_device_id: string | null }>>`
      SELECT id, kind, crawl_device_id
      FROM workspace_sources
      WHERE org_id = ${orgId}
      ORDER BY kind`;
    expect(rows).toEqual([
      { id: smbSourceId, kind: 'smb_share', crawl_device_id: deviceA },
      { id: localSourceId, kind: 'local_profile', crawl_device_id: null },
    ]);
  });
});

afterAll(async () => {
  if (!admin) return;
  try {
    await admin`DELETE FROM workspace_file_activity WHERE org_id = ${orgId}`;
    await admin`DELETE FROM workspace_crawl_runs WHERE org_id = ${orgId}`;
    await admin`DELETE FROM workspace_file_index WHERE org_id = ${orgId}`;
    await admin`DELETE FROM workspace_sources WHERE org_id = ${orgId}`;
    await admin`DELETE FROM devices WHERE id IN (${deviceA}, ${deviceB})`;
    await admin`DELETE FROM sites WHERE id = ${siteId}`;
    await admin`DELETE FROM organizations WHERE id = ${orgId}`;
    await admin`DELETE FROM partners WHERE id = ${partnerId}`;
  } finally {
    await admin.end();
    await app?.end();
  }
});

describe.sequential('workspace crawler end-to-end integration', () => {
  it('completes an SMB crawl, sweeps stale rows, resurrects a victim, and preserves rows on failure', async () => {
    let firstRunId = '';
    let firstRunStartedAt = new Date(0);

    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, smbSourceId, deviceA);
      expect(started).not.toHaveProperty('conflict');
      if (!('run' in started)) throw new Error('expected the first SMB run to start');
      firstRunId = started.run.id;
      firstRunStartedAt = started.run.startedAt;
    });

    await asOrg(async ({ batches }) => {
      await batches.upsertBatch(orgId, smbSourceId, ZERO_UUID, [
        entry('docs', { isDir: true, size: 0, ext: null }),
        entry('docs/guide.txt'),
      ]);
    });
    await asOrg(async ({ batches, tx }) => {
      await batches.upsertBatch(orgId, smbSourceId, ZERO_UUID, [entry('readme.md')]);

      const rows = await tx<Array<{
        rel_path: string;
        is_dir: boolean;
        device_key: string;
        deleted_at: string | null;
        last_seen_at: string;
      }>>`
        SELECT rel_path, is_dir, device_key, deleted_at, last_seen_at
        FROM workspace_file_index
        WHERE org_id = ${orgId} AND source_id = ${smbSourceId}
        ORDER BY rel_path`;
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => [row.rel_path, row.is_dir])).toEqual([
        ['docs', true],
        ['docs/guide.txt', false],
        ['readme.md', false],
      ]);
      expect(rows.every((row) => row.device_key === ZERO_UUID && row.deleted_at === null)).toBe(true);
      expect(rows.every((row) => new Date(row.last_seen_at).getTime() >= firstRunStartedAt.getTime()))
        .toBe(true);
    });

    const victimId = randomUUID();
    await admin`INSERT INTO workspace_file_index
                  (id, org_id, source_id, device_id, device_key, rel_path, parent_path, name,
                   is_dir, size, mtime, last_seen_at, deleted_at)
                VALUES
                  (${victimId}, ${orgId}, ${smbSourceId}, null, ${ZERO_UUID},
                   'stale/victim.txt', 'stale', 'victim.txt', false, 7, now() - interval '2 hours',
                   now() - interval '2 hours', null)`;

    await asOrg(async ({ runs, tx }) => {
      await runs.finish(orgId, firstRunId, deviceA, { complete: true, stats: { seen: 3 } });
      const [run] = await tx<Array<{ status: string; completed_at: string | null }>>`
        SELECT status, completed_at FROM workspace_crawl_runs WHERE id = ${firstRunId}`;
      const files = await tx<Array<{ rel_path: string; deleted_at: string | null }>>`
        SELECT rel_path, deleted_at
        FROM workspace_file_index
        WHERE org_id = ${orgId} AND source_id = ${smbSourceId}
        ORDER BY rel_path`;
      const [source] = await tx<Array<{ status: string; last_complete_run_at: string | null }>>`
        SELECT status, last_complete_run_at FROM workspace_sources WHERE id = ${smbSourceId}`;

      expect(run?.status).toBe('complete');
      expect(run?.completed_at).toEqual(expect.any(String));
      expect(files.find((row) => row.rel_path === 'stale/victim.txt')?.deleted_at)
        .toEqual(expect.any(String));
      expect(files.filter((row) => row.rel_path !== 'stale/victim.txt'))
        .toHaveLength(3);
      expect(files.filter((row) => row.rel_path !== 'stale/victim.txt')
        .every((row) => row.deleted_at === null)).toBe(true);
      expect(source?.status).toBe('active');
      expect(source?.last_complete_run_at).toEqual(expect.any(String));
    });

    let resurrectionRunId = '';
    let resurrectionLastSeenAt = '';
    let resurrectionRunStartedAt = '';
    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, smbSourceId, deviceA);
      if (!('run' in started)) throw new Error('expected the resurrection run to start');
      resurrectionRunId = started.run.id;
    });
    await asOrg(async ({ batches, tx }) => {
      await batches.upsertBatch(orgId, smbSourceId, ZERO_UUID, [entry('stale/victim.txt')]);

      const [victim] = await tx<Array<{
        id: string;
        deleted_at: string | null;
        last_seen_at: string;
        run_started_at: string;
      }>>`
        SELECT f.id, f.deleted_at, f.last_seen_at, r.started_at AS run_started_at
        FROM workspace_file_index f
        JOIN workspace_crawl_runs r ON r.id = ${resurrectionRunId}
        WHERE f.org_id = ${orgId} AND f.source_id = ${smbSourceId}
          AND f.device_key = ${ZERO_UUID} AND f.rel_path = 'stale/victim.txt'`;
      expect(victim).toMatchObject({ id: victimId, deleted_at: null });
      expect(new Date(victim?.last_seen_at ?? 0).getTime())
        .toBeGreaterThanOrEqual(new Date(victim?.run_started_at ?? 0).getTime());
      resurrectionLastSeenAt = victim?.last_seen_at ?? '';
      resurrectionRunStartedAt = victim?.run_started_at ?? '';
    });

    await asOrg(async ({ runs, tx }) => {
      await runs.finish(orgId, resurrectionRunId, deviceA, { complete: true, stats: { seen: 1 } });
      const [run] = await tx<Array<{ status: string }>>`
        SELECT status FROM workspace_crawl_runs WHERE id = ${resurrectionRunId}`;
      const [readback] = await tx<Array<{ deleted_at: string | null }>>`
        SELECT deleted_at FROM workspace_file_index WHERE id = ${victimId}`;
      expect(run?.status).toBe('complete');
      expect(
        readback?.deleted_at,
        `resurrected row was swept: last_seen_at=${resurrectionLastSeenAt}, run.started_at=${resurrectionRunStartedAt}`,
      ).toBeNull();
    });

    const failureSurvivorId = randomUUID();
    await admin`INSERT INTO workspace_file_index
                  (id, org_id, source_id, device_id, device_key, rel_path, parent_path, name,
                   is_dir, size, mtime, last_seen_at, deleted_at)
                VALUES
                  (${failureSurvivorId}, ${orgId}, ${smbSourceId}, null, ${ZERO_UUID},
                   'stale/auth-survivor.txt', 'stale', 'auth-survivor.txt', false, 8,
                   now() - interval '3 hours', now() - interval '3 hours', null)`;

    let failureRunId = '';
    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, smbSourceId, deviceA);
      if (!('run' in started)) throw new Error('expected the failed run to start');
      failureRunId = started.run.id;
    });
    await asOrg(async ({ runs, tx }) => {
      await runs.finish(orgId, failureRunId, deviceA, {
        complete: false,
        errorReason: 'auth failed: invalid SMB credentials',
      });

      const [run] = await tx<Array<{ status: string; error_reason: string | null }>>`
        SELECT status, error_reason FROM workspace_crawl_runs WHERE id = ${failureRunId}`;
      const [source] = await tx<Array<{ status: string; error_reason: string | null }>>`
        SELECT status, error_reason FROM workspace_sources WHERE id = ${smbSourceId}`;
      const [survivor] = await tx<Array<{ deleted_at: string | null }>>`
        SELECT deleted_at FROM workspace_file_index WHERE id = ${failureSurvivorId}`;
      const aliveCount = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM workspace_file_index
        WHERE org_id = ${orgId} AND source_id = ${smbSourceId} AND deleted_at IS NULL`;

      expect(run).toEqual({ status: 'failed', error_reason: 'auth failed: invalid SMB credentials' });
      expect(source).toEqual({ status: 'error', error_reason: 'auth failed: invalid SMB credentials' });
      expect(survivor?.deleted_at).toBeNull();
      expect(aliveCount[0]?.count).toBe(2);
    });
  });

  it('isolates local-profile sweeps by device key even when relative paths overlap', async () => {
    let deviceBRunId = '';
    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, localSourceId, deviceB);
      if (!('run' in started)) throw new Error('expected device B local-profile run to start');
      deviceBRunId = started.run.id;
    });
    await asOrg(async ({ batches, tx }) => {
      await batches.upsertBatch(orgId, localSourceId, deviceB, [
        entry('shared/overlap.txt'),
        entry('device-b/only.txt'),
      ]);
      const rows = await tx<Array<{ rel_path: string; device_key: string }>>`
        SELECT rel_path, device_key
        FROM workspace_file_index
        WHERE org_id = ${orgId} AND source_id = ${localSourceId} AND device_key = ${deviceB}
        ORDER BY rel_path`;
      expect(rows).toEqual([
        { rel_path: 'device-b/only.txt', device_key: deviceB },
        { rel_path: 'shared/overlap.txt', device_key: deviceB },
      ]);
    });

    const staleAId = randomUUID();
    await admin`UPDATE workspace_file_index
                SET last_seen_at = now() - interval '2 hours'
                WHERE org_id = ${orgId} AND source_id = ${localSourceId} AND device_key = ${deviceB}`;
    await admin`INSERT INTO workspace_file_index
                  (id, org_id, source_id, device_id, device_key, rel_path, parent_path, name,
                   is_dir, size, last_seen_at, deleted_at)
                VALUES
                  (${staleAId}, ${orgId}, ${localSourceId}, ${deviceA}, ${deviceA},
                   'device-a/stale.txt', 'device-a', 'stale.txt', false, 1,
                   now() - interval '2 hours', null)`;

    let deviceARunId = '';
    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, localSourceId, deviceA);
      if (!('run' in started)) throw new Error('expected device A local-profile run to start');
      deviceARunId = started.run.id;
    });
    await asOrg(async ({ batches }) => {
      await batches.upsertBatch(orgId, localSourceId, deviceA, [
        entry('shared/overlap.txt'),
        entry('device-a/only.txt'),
      ]);
    });
    await asOrg(async ({ runs, tx }) => {
      await runs.finish(orgId, deviceARunId, deviceA, { complete: true, stats: { seen: 2 } });

      const rows = await tx<Array<{
        id: string;
        rel_path: string;
        device_key: string;
        deleted_at: string | null;
      }>>`
        SELECT id, rel_path, device_key, deleted_at
        FROM workspace_file_index
        WHERE org_id = ${orgId} AND source_id = ${localSourceId}
        ORDER BY device_key, rel_path`;
      const overlapRows = rows.filter((row) => row.rel_path === 'shared/overlap.txt');
      const deviceBRows = rows.filter((row) => row.device_key === deviceB);
      const [runB] = await tx<Array<{ status: string }>>`
        SELECT status FROM workspace_crawl_runs WHERE id = ${deviceBRunId}`;

      expect(rows).toHaveLength(5);
      expect(overlapRows).toHaveLength(2);
      expect(new Set(overlapRows.map((row) => row.device_key))).toEqual(new Set([deviceA, deviceB]));
      expect(rows.find((row) => row.id === staleAId)?.deleted_at).toEqual(expect.any(String));
      expect(deviceBRows).toHaveLength(2);
      expect(deviceBRows.every((row) => row.deleted_at === null)).toBe(true);
      expect(runB?.status).toBe('running');
    });
  });

  // Depends on the auth-failure test above leaving the SMB source in status
  // 'error': the next complete run must heal it (status active, reason
  // cleared) or fixed credentials leave the source stuck in error forever.
  it('recovers an errored source to active on the next complete run', async () => {
    await asOrg(async ({ tx }) => {
      const [before] = await tx<Array<{ status: string }>>`
        SELECT status FROM workspace_sources WHERE id = ${smbSourceId}`;
      expect(before?.status).toBe('error');
    });

    let recoveryRunId = '';
    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, smbSourceId, deviceA);
      if (!('run' in started)) throw new Error('expected the recovery run to start');
      recoveryRunId = started.run.id;
    });
    await asOrg(async ({ batches }) => {
      await batches.upsertBatch(orgId, smbSourceId, ZERO_UUID, [entry('docs/guide.txt')]);
    });
    await asOrg(async ({ runs, tx }) => {
      await runs.finish(orgId, recoveryRunId, deviceA, { complete: true, stats: { seen: 1 } });
      const [source] = await tx<Array<{ status: string; error_reason: string | null }>>`
        SELECT status, error_reason FROM workspace_sources WHERE id = ${smbSourceId}`;
      expect(source).toEqual({ status: 'active', error_reason: null });
    });
  });

  it('surfaces a non-auth failure on the source without flipping its status', async () => {
    let runId = '';
    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, smbSourceId, deviceA);
      if (!('run' in started)) throw new Error('expected the io-failure run to start');
      runId = started.run.id;
    });
    await asOrg(async ({ runs, tx }) => {
      await runs.finish(orgId, runId, deviceA, {
        complete: false,
        errorReason: 'share unreachable: connection timed out',
      });
      const [source] = await tx<Array<{ status: string; error_reason: string | null }>>`
        SELECT status, error_reason FROM workspace_sources WHERE id = ${smbSourceId}`;
      // Visible to admins via errorReason, but a transient failure must not
      // park the source in 'error' (that state is reserved for credential
      // problems needing re-entry).
      expect(source).toEqual({
        status: 'active',
        error_reason: 'share unreachable: connection timed out',
      });
    });
  });

  it('answers a retried finish idempotently against the real status machine', async () => {
    let runId = '';
    await asOrg(async ({ runs }) => {
      const started = await runs.start(orgId, smbSourceId, deviceA);
      if (!('run' in started)) throw new Error('expected the idempotency run to start');
      runId = started.run.id;
    });
    await asOrg(async ({ runs }) => {
      const first = await runs.finish(orgId, runId, deviceA, { complete: true });
      expect(first).toHaveProperty('tombstoned');
      // Lost-response retry: same device, same run, already terminal.
      const retry = await runs.finish(orgId, runId, deviceA, { complete: true });
      expect(retry).toEqual({ alreadyFinished: true });
    });
  });

  it('admits exactly one run across truly concurrent starts on separate connections', async () => {
    // The advisory-lock serialization only means something across real
    // connections — a shared max:1 pool would serialize at the pool instead.
    const app2 = postgres(APP_URL, { max: 1 });
    const appDb2 = drizzle(app2);
    const asOrgOn = async <T>(
      dbClient: ReturnType<typeof drizzle>,
      fn: (context: AppContext) => Promise<T>,
    ): Promise<T> => dbClient.transaction(async (transaction) => {
      const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } })
        .session.client;
      await tx`SELECT set_config('breeze.scope', 'organization', true),
                      set_config('breeze.org_id', ${orgId}, true),
                      set_config('breeze.accessible_org_ids', ${orgId}, true),
                      set_config('breeze.accessible_partner_ids', ${partnerId}, true),
                      set_config('breeze.user_id', '', true),
                      set_config('breeze.current_partner_id', '', true)`;
      const db = transaction as unknown as WorkspaceDatabase;
      return fn({
        tx,
        sources: createSourcesService(db),
        runs: createCrawlRunsService(db),
        batches: createBatchUpsertService(db),
      });
    });

    try {
      const raceSourceId = await asOrg(async ({ sources }) => (await sources.create(orgId, {
        kind: 'local_profile',
        displayName: 'Crawler race source',
        rootPath: '/Users',
        crawlDeviceId: null,
        visibilityGroupIds: [],
        crawlCadenceMinutes: 60,
        excludeGlobs: [],
        watch: false,
        status: 'active',
      })).id);

      const [first, second] = await Promise.all([
        asOrgOn(appDb, ({ runs }) => runs.start(orgId, raceSourceId, deviceA)),
        asOrgOn(appDb2, ({ runs }) => runs.start(orgId, raceSourceId, deviceA)),
      ]);

      const runsStarted = [first, second].filter((result) => 'run' in result);
      const conflicts = [first, second].filter((result) => 'conflict' in result);
      expect(runsStarted).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      const rows = await admin`SELECT id FROM workspace_crawl_runs
                               WHERE org_id = ${orgId} AND source_id = ${raceSourceId}
                                 AND status = 'running'`;
      expect(rows).toHaveLength(1);
    } finally {
      await app2.end();
    }
  });

  it('abandons a stale active run before creating its replacement', async () => {
    const staleRunId = randomUUID();
    await admin`INSERT INTO workspace_crawl_runs
                  (id, org_id, source_id, device_id, device_key, status, started_at, last_activity_at)
                VALUES
                  (${staleRunId}, ${orgId}, ${localSourceId}, ${deviceA}, ${deviceA}, 'running',
                   now() - interval '2 hours', now() - interval '2 hours')`;

    await asOrg(async ({ runs, tx }) => {
      const started = await runs.start(orgId, localSourceId, deviceA);
      if (!('run' in started)) throw new Error('expected a replacement run to start');
      const rows = await tx<Array<{
        id: string;
        status: string;
        completed_at: string | null;
        last_activity_at: string;
      }>>`
        SELECT id, status, completed_at, last_activity_at
        FROM workspace_crawl_runs
        WHERE id IN (${staleRunId}, ${started.run.id})
        ORDER BY started_at`;

      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe(staleRunId);
      expect(rows[0]?.status).toBe('abandoned');
      expect(rows[0]?.completed_at).toEqual(expect.any(String));
      expect(rows[1]).toMatchObject({ id: started.run.id, status: 'running', completed_at: null });
      expect(new Date(rows[1]?.last_activity_at ?? 0).getTime())
        .toBeGreaterThan(new Date(rows[0]?.last_activity_at ?? 0).getTime());
    });
  });
});
