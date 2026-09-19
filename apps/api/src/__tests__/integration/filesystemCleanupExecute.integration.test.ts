import './setup';

import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceFilesystemCleanupRuns, devices } from '../../db/schema';
import { CLEANUP_PREVIEW_TTL_HOURS } from '../../routes/devices/filesystem';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getAppDb, getTestDb } from './setup';

/**
 * Spec §13 #5: real transaction visibility and rollback boundaries cannot be
 * proved by the route's mocked-db tests. No agent commands are dispatched here.
 */
let tenant: { deviceId: string; orgId: string; userId: string };

/** The route's atomic claim, usable with either independent connection pool. */
async function claimRow(connection: Pick<typeof db, 'update'>, runId: string) {
  const [row] = await connection.update(deviceFilesystemCleanupRuns)
    .set({ status: 'running', approvedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, runId),
      eq(deviceFilesystemCleanupRuns.deviceId, tenant.deviceId),
      eq(deviceFilesystemCleanupRuns.status, 'previewed'),
    ))
    .returning({ id: deviceFilesystemCleanupRuns.id });
  return row?.id ?? null;
}

function claim(runId: string) {
  return withSystemDbAccessContext(() => claimRow(db, runId));
}

function insertPreviewedRun(requestedAt = new Date()) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(deviceFilesystemCleanupRuns).values({
      deviceId: tenant.deviceId,
      orgId: tenant.orgId,
      requestedBy: tenant.userId,
      requestedAt,
      scanPath: '/',
      kind: 'files',
      status: 'previewed',
      plan: { preview: {
        candidates: [{ path: '/tmp/a', category: 'temp_files', sizeBytes: 1, safe: true }],
        estimatedBytes: 1,
      } },
    }).returning({ id: deviceFilesystemCleanupRuns.id });
    return row!.id;
  });
}

function readStatus(runId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select({ status: deviceFilesystemCleanupRuns.status })
      .from(deviceFilesystemCleanupRuns)
      .where(eq(deviceFilesystemCleanupRuns.id, runId))
      .limit(1);
    return row?.status ?? null;
  });
}

describe('cleanup-execute claim semantics (real Postgres)', () => {
  // setup.ts truncates between cases, so fixtures must also be per-test.
  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const [device] = await getTestDb().insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `cleanup-claim-${randomUUID()}`,
      hostname: 'cleanup-claim-test',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: '0.0.0-test',
      status: 'online',
    }).returning({ id: devices.id });
    tenant = { deviceId: device!.id, orgId: org.id, userId: user.id };
  });

  it('a committed claim is immediately visible to a second connection', async () => {
    const runId = await insertPreviewedRun();

    // getAppDb owns a different pool from the production db proxy. Hold its
    // connection open and compare backend PIDs so pool reuse cannot make this
    // a single-connection visibility test accidentally.
    await getAppDb().transaction(async (observer) => {
      await observer.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      const [observerBackend] = await observer.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      const first = await withSystemDbAccessContext(async () => {
        const [backend] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        return { id: await claimRow(db, runId), pid: backend!.pid };
      });
      expect(first.pid).not.toBe(observerBackend!.pid);
      expect(first.id).toBe(runId);

      expect(await claimRow(observer, runId)).toBeNull();
      const [visible] = await observer.select({ status: deviceFilesystemCleanupRuns.status })
        .from(deviceFilesystemCleanupRuns)
        .where(eq(deviceFilesystemCleanupRuns.id, runId));
      expect(visible?.status).toBe('running');
    });
  });

  it('two concurrent claims produce exactly one winner', async () => {
    const runId = await insertPreviewedRun();
    const results = await Promise.all([claim(runId), claim(runId)]);
    expect(results.filter((id) => id !== null)).toEqual([runId]);
    expect(await readStatus(runId)).toBe('running');
  });

  it('a throw after the claim leaves the row running, never back at previewed', async () => {
    const runId = await insertPreviewedRun();
    expect(await claim(runId)).toBe(runId);

    // Finalisation rolls back its own write, not the already-committed claim.
    await expect(withSystemDbAccessContext(async () => {
      await db.update(deviceFilesystemCleanupRuns)
        .set({ status: 'executed', updatedAt: new Date() })
        .where(eq(deviceFilesystemCleanupRuns.id, runId));
      throw new Error('connection reset');
    })).rejects.toThrow('connection reset');

    expect(await readStatus(runId)).toBe('running');
  });

  it('a run older than the TTL is still claimable but must be rejected by the route', async () => {
    const stale = new Date(Date.now() - (CLEANUP_PREVIEW_TTL_HOURS + 1) * 3_600_000);
    const runId = await insertPreviewedRun(stale);
    expect(await claim(runId)).toBe(runId);
    // SQL does not enforce preview freshness; the route TTL check is required.
    expect(await readStatus(runId)).toBe('running');
  });
});
