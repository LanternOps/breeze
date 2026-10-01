/**
 * On-demand MSSQL / Hyper-V backups queued through the REST routes, against
 * real Postgres and the real auth middleware.
 *
 * A helper that reports brokered writes is given a write-scoped storage
 * session instead of the storage destination — but the session is minted when
 * the command is DELIVERED, on the delivery path's own connection, and only
 * for a backup job that connection can see. The routes create that job
 * themselves, so the job has to be committed before the command is pushed.
 * Under the request transaction it was not: delivery found no live job and
 * sent the destination (with its access key) instead.
 *
 * Only a real database can show this — it is a question of which rows another
 * connection can see, which no mock models. The websocket is the one thing
 * stubbed: it captures the frame the helper would receive and answers with the
 * helper's queue-admission ack, as a real helper does.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupRouteWriteSession.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authMiddleware } from '../../middleware/auth';
import { hypervRoutes } from '../../routes/backup/hyperv';
import { mssqlRoutes } from '../../routes/backup/mssql';
import { createAccessToken } from '../../services/jwt';
import { WRITE_DESTINATION, reservationRow } from './backupWriteFixtures';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

type Frame = { id: string; type: string; payload: Record<string, unknown> };

const ws = vi.hoisted(() => ({ frames: [] as Frame[] }));
const config = vi.hoisted(() => ({ byDevice: new Map<string, string>() }));

// The helper: records what it was sent and acks queue admission, which is
// what the route waits for.
vi.mock('../../routes/agentWs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../routes/agentWs')>()),
  isAgentConnected: vi.fn(() => true),
  sendCommandToAgent: vi.fn((_agentId: string, frame: Frame) => {
    ws.frames.push(frame);
    setTimeout(() => {
      // The query builder is lazy: it only runs once something subscribes.
      getTestDb().execute(sql`
        UPDATE device_commands
           SET status = 'completed', completed_at = now(),
               result = ${JSON.stringify({ status: 'completed', stdout: JSON.stringify({ queued: true }) })}::jsonb
         WHERE id = ${frame.id}
      `).then(undefined, (err: unknown) => console.error('[test helper] could not ack the command', err));
    }, 10);
    return true;
  }),
}));

// Configuration-policy resolution is not what this suite is about; the device's
// backup configuration is named directly.
vi.mock('../../services/featureConfigResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/featureConfigResolver')>()),
  resolveBackupConfigForDevice: vi.fn(async (deviceId: string) => {
    const configId = config.byDevice.get(deviceId);
    return configId ? { configId, featureLinkId: null } : null;
  }),
}));

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  // Mounted at the real prefix: the auth middleware decides whether a route
  // manages its own DB context from the full request path.
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/api/v1/backup', mssqlRoutes);
  app.route('/api/v1/backup/hyperv', hypervRoutes);
  return app;
}

async function seed(writeProtocol: number) {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const deviceId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version,
                         status, backup_read_protocol_version, backup_write_protocol_version)
    VALUES (${deviceId}, ${env.organization.id}, ${env.site.id}, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
            'windows', '11', 'amd64', '2.0.0', 'online', 1, ${writeProtocol})
  `);
  const configId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
    VALUES (${configId}, ${env.organization.id}, 'Primary', 'file', 's3', ${JSON.stringify(WRITE_DESTINATION)}::jsonb)
  `);
  config.byDevice.set(deviceId, configId);
  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  return { env, deviceId, token };
}

const ROUTES = [
  {
    name: 'MSSQL',
    type: 'mssql_backup',
    path: '/api/v1/backup/mssql/backup',
    body: (deviceId: string) => ({ deviceId, instance: 'MSSQLSERVER', database: 'AppDb' }),
  },
  {
    name: 'Hyper-V',
    type: 'hyperv_backup',
    path: '/api/v1/backup/hyperv/backup',
    body: (deviceId: string) => ({ deviceId, vmName: 'Accounting VM', consistencyType: 'application' }),
  },
] as const;

describe.each(ROUTES)('an on-demand $name backup queued through the API', (route) => {
  const previous = process.env.PUBLIC_API_URL;
  beforeAll(() => { process.env.PUBLIC_API_URL = 'https://api.breeze.example'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = previous;
  });
  beforeEach(() => { ws.frames = []; });

  async function queue(writeProtocol: number) {
    const { deviceId, token } = await seed(writeProtocol);
    const res = await buildApp().request(route.path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(route.body(deviceId)),
    });
    const body = await res.json() as { data?: { backupJobId?: string } };
    expect(res.status, JSON.stringify(body)).toBe(202);
    expect(ws.frames).toHaveLength(1);
    const frame = ws.frames[0]!;
    expect(frame.type).toBe(route.type);
    return { deviceId, frame, jobId: body.data!.backupJobId! };
  }

  runDb('delivers a write session, never the storage destination, to a helper that reports brokered writes', async () => {
    const { deviceId, frame, jobId } = await queue(1);

    expect(frame.payload).not.toHaveProperty('providerConfig');
    expect(frame.payload).not.toHaveProperty('providerConfigRef');
    expect(JSON.stringify(frame)).not.toContain(WRITE_DESTINATION.secretKey);
    expect(JSON.stringify(frame)).not.toContain(WRITE_DESTINATION.accessKey);
    expect(frame.payload.storageSession).toMatchObject({ scope: 'snapshot_write', baseUrl: 'https://api.breeze.example' });

    // The session was issued for the job this request created.
    const snapshotId = (frame.payload.storageSession as { snapshotId: string }).snapshotId;
    expect(await reservationRow(snapshotId)).toMatchObject({ current_job_id: jobId, device_id: deviceId, state: 'reserved' });
    // The helper's queue-admission ack was recorded against the committed job.
    const [job] = await getTestDb().execute(sql`
      SELECT status, last_keepalive_at FROM backup_jobs WHERE id = ${jobId}
    `) as unknown as Array<{ status: string; last_keepalive_at: Date | null }>;
    expect(job?.status).toBe('pending');
    expect(job?.last_keepalive_at).not.toBeNull();
  });

  runDb('refuses a helper that does not report brokered writes: 409, no frame, the job failed with the update message', async () => {
    const { deviceId, token } = await seed(0);
    const res = await buildApp().request(route.path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(route.body(deviceId)),
    });
    const body = await res.json() as { error?: string; reason?: string };
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.reason).toBe('helper_update_required');
    expect(body.error).toMatch(/^Update the Breeze agent on this device, then try again\. Backups now require/);
    expect(ws.frames).toEqual([]);
    const jobs = await getTestDb().execute(sql`
      SELECT status, error_log FROM backup_jobs WHERE device_id = ${deviceId}
    `) as unknown as Array<{ status: string; error_log: string | null }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'failed', error_log: body.error });
    const rows = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM device_commands WHERE device_id = ${deviceId}
    `) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });
});
