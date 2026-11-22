/**
 * #11178: an agent result that reports file rows and a hydration publish for
 * the same snapshot, against real Postgres. Both replace every
 * backup_snapshot_files row of the snapshot; they must serialize on the
 * snapshot row lock so no reader ever sees a mix of agent rows and manifest
 * rows, duplicates, or rows that disagree with file_index_status.
 *
 * Storage is faked; every decision and lock runs in Postgres.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotFileIndexResultRace.integration.test.ts
 */
import './setup';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { insertSnapshotRow, orgContext, seedBackupJob, seedWriteTenant, type WriteTenant } from './backupWriteFixtures';
import { getTestDb } from './setup';

vi.mock('../../jobs/backupSnapshotFileIndexWorker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/backupSnapshotFileIndexWorker')>()),
  enqueueSnapshotFileIndexHydration: vi.fn(async () => 'queued'),
}));
vi.mock('../../jobs/backupSnapshotAttestationWorker', () => ({
  enqueueSnapshotAttestationVerification: vi.fn(async () => 'job'),
}));

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MANIFEST_PATHS = ['C:/m/one', 'C:/m/two', 'C:/m/three'];
const AGENT_PATHS = ['C:/agent/one', 'C:/agent/two'];

function newId(): string {
  return `snapshot-20261112T120000Z-${randomBytes(12).toString('hex')}`;
}

function manifestFor(snapshotId: string): Uint8Array {
  return Buffer.from(JSON.stringify({
    id: snapshotId,
    files: MANIFEST_PATHS.map((sourcePath, i) => ({ sourcePath, backupPath: `snapshots/${snapshotId}/files/m${i}`, size: 1 })),
  }));
}

const hydrate = (snapshotDbId: string, manifest: Uint8Array) =>
  runOutsideDbContext(() => hydrateSnapshotFileIndex(snapshotDbId, {
    includeUnreferenced: true,
    force: true,
    deps: { openManifest: async () => Readable.from([Buffer.from(manifest)]) },
  }));

/** The agent WS inline path for a result that names an existing snapshot row and reports its files. */
const agentResult = (t: WriteTenant, jobId: string, snapshotId: string) =>
  withDbAccessContext(orgContext(t.orgId), () =>
    applyBackupCommandResultToJob({
      jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
      result: {
        snapshotId,
        filesBackedUp: AGENT_PATHS.length,
        bytesBackedUp: AGENT_PATHS.length,
        snapshot: {
          id: snapshotId,
          files: AGENT_PATHS.map((sourcePath, i) => ({ sourcePath, backupPath: `snapshots/${snapshotId}/files/a${i}`, size: 1 })),
        },
      } as never,
      dispatchExpectationVerified: true,
    }),
  );

async function fileRows(snapshotDbId: string): Promise<string[]> {
  const rows = (await getTestDb().execute(sql`
    SELECT source_path FROM backup_snapshot_files WHERE snapshot_db_id = ${snapshotDbId} ORDER BY source_path
  `)) as unknown as Array<{ source_path: string }>;
  return rows.map((r) => r.source_path);
}

async function indexStatus(snapshotDbId: string): Promise<string> {
  const rows = (await getTestDb().execute(sql`
    SELECT file_index_status AS status FROM backup_snapshots WHERE id = ${snapshotDbId}
  `)) as unknown as Array<{ status: string }>;
  return rows[0]!.status;
}

/** Rows are exactly one writer's set, with the status that writer leaves. */
async function expectOneWritersIndex(snapshotDbId: string): Promise<'manifest' | 'agent'> {
  const rows = await fileRows(snapshotDbId);
  const status = await indexStatus(snapshotDbId);
  const manifestSet = [...MANIFEST_PATHS].sort();
  const agentSet = [...AGENT_PATHS].sort();
  if (status === 'complete') {
    expect(rows).toEqual(manifestSet);
    return 'manifest';
  }
  expect({ status, rows }).toEqual({ status: 'agent', rows: agentSet });
  return 'agent';
}

/** Waits until another backend is blocked on a lock running a statement that matches `pattern`. */
async function waitForLockWait(pattern: string, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND query ILIKE ${pattern}
    `)) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`${what} never blocked on a lock`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Resolves true when `p` settles within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  return settled;
}

describe('agent result file rows vs a hydration publish (#11178)', () => {
  const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
  afterAll(async () => { await adminSql.end({ timeout: 5 }); });

  async function seed(): Promise<{ t: WriteTenant; snapshotId: string; snapshotDbId: string }> {
    const t = await seedWriteTenant({ jobStatus: 'running' });
    const snapshotId = newId();
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    return { t, snapshotId, snapshotDbId };
  }

  runDb('a result arriving while a publish is in flight waits for it, then leaves the published index alone', async () => {
    const { t, snapshotId, snapshotDbId } = await seed();

    // Hold the publish at its origin rewrite: its file rows are already
    // replaced inside its (still open) transaction, under the row lock.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const tableLocked = new Promise<void>((r) => { locked = r; });
    const lockTx = adminSql.begin(async (tx) => {
      await tx`LOCK TABLE backup_snapshot_origins IN ACCESS EXCLUSIVE MODE`;
      locked();
      await held;
    });
    await tableLocked;

    const hydration = hydrate(snapshotDbId, manifestFor(snapshotId));
    let result: ReturnType<typeof agentResult> | undefined;
    try {
      await waitForLockWait('delete from "backup_snapshot_origins"%', 'the publish');
      result = agentResult(t, t.jobId, snapshotId);
      // It waits on the snapshot row the publish holds, before touching rows.
      await waitForLockWait('update "backup_snapshots"%', 'the result');
      // The result must not replace rows under a publish that holds the lock.
      expect(await settlesWithin(result, 1_500)).toBe(false);
      expect(await fileRows(snapshotDbId)).toEqual([]);
    } finally {
      release();
      await lockTx;
    }

    expect(await hydration).toMatchObject({ status: 'complete' });
    expect(await result).toMatchObject({ applied: true, snapshotDbId });
    expect(await expectOneWritersIndex(snapshotDbId)).toBe('manifest');
  });

  runDb('a hydration arriving while a result is replacing rows waits for it, and never publishes over half of it', async () => {
    const { t, snapshotId, snapshotDbId } = await seed();

    // Hold the result at its file-row replace, after it wrote the snapshot row.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const tableLocked = new Promise<void>((r) => { locked = r; });
    const lockTx = adminSql.begin(async (tx) => {
      await tx`LOCK TABLE backup_snapshot_files IN ACCESS EXCLUSIVE MODE`;
      locked();
      await held;
    });
    await tableLocked;

    const result = agentResult(t, t.jobId, snapshotId);
    let hydration: ReturnType<typeof hydrate> | undefined;
    try {
      await waitForLockWait('delete from "backup_snapshot_files"%', 'the result');
      hydration = hydrate(snapshotDbId, manifestFor(snapshotId));
      // The hydration must wait on the snapshot row the result holds.
      await waitForLockWait('update "backup_snapshots"%', 'the hydration');
      expect(await settlesWithin(hydration, 500)).toBe(false);
    } finally {
      release();
      await lockTx;
    }

    expect(await result).toMatchObject({ applied: true, snapshotDbId });
    expect(await hydration).toMatchObject({ status: 'complete' });
    expect(await expectOneWritersIndex(snapshotDbId)).toBe('manifest');
  });

  runDb('racing freely, the rows are always exactly one writer\u2019s set (40 iterations)', async () => {
    const t = await seedWriteTenant({ jobStatus: 'running' });
    const outcomes = { manifest: 0, agent: 0 };
    for (let i = 0; i < 40; i++) {
      const jobId = i === 0 ? t.jobId : await seedBackupJob(t.orgId, t.configId, t.deviceId, 'running');
      const snapshotId = newId();
      const snapshotDbId = await insertSnapshotRow({ ...t, jobId }, snapshotId);
      const manifest = manifestFor(snapshotId);
      await Promise.all([
        i % 2 === 0 ? hydrate(snapshotDbId, manifest) : agentResult(t, jobId, snapshotId),
        i % 2 === 0 ? agentResult(t, jobId, snapshotId) : hydrate(snapshotDbId, manifest),
      ]);
      outcomes[await expectOneWritersIndex(snapshotDbId)]++;
    }
    expect(outcomes.manifest + outcomes.agent).toBe(40);
  });
});
