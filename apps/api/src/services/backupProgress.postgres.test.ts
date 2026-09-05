import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

// Opt-in, isolated SQL contract test. Only connection-local temporary objects
// are created; no application schema, migrations or shared fixtures are touched.
const state = vi.hoisted(() => ({ db: undefined as ReturnType<typeof drizzle> | undefined }));
vi.mock('../db', () => ({ db: new Proxy({}, {
  get: (_target, key) => Reflect.get(state.db!, key),
}) }));
vi.mock('./agentWorkExpectation', () => ({ refreshDispatchedExpectation: vi.fn(async () => true) }));

import { applyBackupProgress, applyBackupStartedAck } from './backupProgress';

const url = process.env.BACKUP_QUEUE_TEST_DATABASE_URL;
const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe.skipIf(!url)('backup queue lifecycle (real PostgreSQL)', () => {
  let client: ReturnType<typeof postgres>;
  beforeAll(async () => {
    client = postgres(url!, { max: 1 });
    state.db = drizzle(client);
    await client`CREATE TYPE pg_temp.backup_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled')`;
    await client`CREATE TEMP TABLE devices (id uuid PRIMARY KEY, agent_id text)`;
    await client`CREATE TEMP TABLE backup_jobs (
      id uuid PRIMARY KEY, device_id uuid, status pg_temp.backup_status,
      started_at timestamptz, last_progress_at timestamptz, updated_at timestamptz
    )`;
    await client`INSERT INTO devices VALUES (${deviceId}, 'agent-owner')`;
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    await client`DELETE FROM backup_jobs`;
    await client`INSERT INTO backup_jobs VALUES (${jobId}, ${deviceId}, 'running', '2026-01-01', NULL, NULL)`;
  });
  const progress = (phase: string) => applyBackupProgress({ agentId: 'agent-owner', commandId: jobId, progress: { phase } });
  const admission = () => applyBackupStartedAck({ jobId, deviceId, queued: true });
  const row = async () => (await client`SELECT * FROM backup_jobs WHERE id = ${jobId}`)[0]!;

  it('queues until starting, then ignores late queued signals without resetting execution time', async () => {
    await admission();
    expect(await row()).toMatchObject({ status: 'pending', started_at: null });
    await progress('queued');
    expect(await row()).toMatchObject({ status: 'pending', started_at: null });
    await progress('starting');
    const started = (await row()).started_at;
    expect(Number.isFinite(Date.parse(started))).toBe(true);
    await Promise.all([admission(), progress('queued'), progress('starting')]);
    expect(await row()).toMatchObject({ status: 'running', started_at: started });
  });

  it('handles starting before acknowledgement and ignores queued signals after completion', async () => {
    await progress('starting');
    const started = (await row()).started_at;
    await admission();
    expect(await row()).toMatchObject({ status: 'running', started_at: started });
    await client`UPDATE backup_jobs SET status = 'completed' WHERE id = ${jobId}`;
    expect(await admission()).toBe(false);
    expect(await progress('queued')).toMatchObject({ applied: false, reason: 'terminal-status' });
    expect(await row()).toMatchObject({ status: 'completed', started_at: started });
  });

  it('promotes ordinary legacy progress that beats the worker post-dispatch write', async () => {
    await client`UPDATE backup_jobs SET status = 'pending', started_at = NULL WHERE id = ${jobId}`;
    await progress('uploading');
    expect(await row()).toMatchObject({ status: 'running', started_at: expect.any(String) });
  });

  it('rejects lifecycle messages from another agent', async () => {
    expect(await applyBackupProgress({ agentId: 'other', commandId: jobId, progress: { phase: 'starting' } }))
      .toMatchObject({ applied: false, reason: 'agent-mismatch' });
    expect((await row()).last_progress_at).toBeNull();
  });
});
