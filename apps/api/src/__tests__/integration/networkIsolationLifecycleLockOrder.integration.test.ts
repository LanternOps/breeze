/** Real-DB regression for device -> org-FK versus org -> device deadlocks. */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceNetworkIsolations, organizations } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), afterDeviceLock: vi.fn() }));
vi.mock('../../services/dispatchDeviceCommand', () => ({ dispatchDeviceCommand: mocks.dispatch }));
vi.mock('../../services/partnerTrust.commands', () => ({
  // This real-start boundary follows loadDevice's FOR NO KEY UPDATE, before
  // the incident/action/episode inserts acquire FK KEY SHARE on organizations.
  assertDeviceExecuteAllowed: mocks.afterDeviceLock,
  deviceExecuteAllowedForOrg: async () => true,
  TrustDeniedError: class extends Error {},
}));
import { startNetworkIsolation } from '../../services/networkIsolation/service';
import { assertIsolationErasureSafe, cascadeDeleteOrg } from '../../services/tenantCascade';
import { assertMergeIsolationSafe, assertPairStillMergeable, lockMergePartnerGroupRows } from '../../services/orgMerge';

beforeEach(() => {
  vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'true');
  vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', '');
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  mocks.afterDeviceLock.mockReset().mockResolvedValue(undefined);
  mocks.dispatch.mockReset().mockImplementation(async ({ commandId }: { commandId: string }) => ({
    ok: true, command: { id: commandId }, delivery: 'queued_offline',
  }));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => closeDb());

async function fixture() {
  const partner = await createPartner();
  const loser = await createOrganization({ partnerId: partner.id });
  const survivor = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: loser.id });
  const device = await createDevice({ orgId: loser.id, siteId: site.id });
  await withDbAccessContext(orgContext(loser.id), () => db.update(devices).set({
    agentVersion: '999.0.0', networkIsolationVersion: 1, networkIsolationReady: true,
    osType: 'windows', agentServerUrl: 'https://control.example.test', status: 'online',
  }).where(eq(devices.id, device.id)));
  const auth = {
    scope: 'organization', orgId: loser.id, partnerId: partner.id, accessibleOrgIds: [loser.id],
    principal: { kind: 'user_session', id: randomUUID() }, user: { id: randomUUID() },
    canAccessOrg: (id: string) => id === loser.id, canAccessSite: () => true,
  } as unknown as AuthContext;
  return { partner, loser, survivor, device, auth };
}
const input = {
  createIncident: { title: 'Containment investigation', severity: 'p2' as const },
  reason: 'Investigation',
};
const systemTransaction = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/** Acquire the real Phase-B prefix, including its pre-existing org NKU locks. */
async function mergePrefix(f: Awaited<ReturnType<typeof fixture>>) {
  await lockMergePartnerGroupRows(f.partner.id);
  const orgIds = [f.loser.id, f.survivor.id].sort();
  await db.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
    ARRAY[${sql.join(orgIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])`);
  await assertPairStillMergeable(f.loser, f.survivor);
  await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function pid(): Promise<number> {
  const [row] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return row!.pid;
}
async function waitForDeviceBlock(waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ blocked: boolean }>(sql`
      SELECT ${blocker}::integer = ANY(pg_blocking_pids(pid))
        AND query ILIKE '%FROM devices%FOR NO KEY UPDATE%' AS blocked
      FROM pg_stat_activity WHERE pid = ${waiter}::integer`);
    if (row?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Lifecycle fence never waited on the start transaction device lock');
}
function sqlState(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 8; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code)) return value.code;
    current = value.cause;
  }
  return undefined;
}

describe('network isolation lifecycle fences', () => {
  it('refuses org erasure and merge with isolation_unresolved against persisted episodes', async () => {
    const f = await fixture();
    const started = await startNetworkIsolation(f.auth, f.device.id, input, { requestedByKind: 'system' });
    expect(started).not.toHaveProperty('error');
    await expect(systemTransaction(() => assertIsolationErasureSafe(f.loser.id)))
      .rejects.toMatchObject({ code: 'isolation_unresolved' });
    await expect(cascadeDeleteOrg(f.loser.id, randomUUID()))
      .rejects.toMatchObject({ code: 'isolation_unresolved' });
    await withSystemDbAccessContext(() => db.update(organizations).set({ status: 'merging' })
      .where(eq(organizations.id, f.loser.id)));
    await expect(systemTransaction(async () => {
      await mergePrefix(f);
      await assertMergeIsolationSafe(f.loser.id, false);
    })).rejects.toMatchObject({ blockerCodes: ['isolation_unresolved'] });
    const rows = await withDbAccessContext(orgContext(f.loser.id), () => db.select()
      .from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.deviceId, f.device.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('dispatched');
  });

  it.each(['merge', 'erasure'] as const)('concurrent start and %s fence complete without 40P01', async kind => {
    const f = await fixture();
    const startLocked = gate();
    const releaseStart = gate();
    const fenceReady = gate();
    let startPid = 0;
    let fencePid = 0;
    mocks.afterDeviceLock.mockImplementationOnce(async () => {
      await db.execute(sql`SET LOCAL statement_timeout = '15s'`);
      startPid = await pid();
      startLocked.release();
      await bounded(releaseStart.promise, 'start release');
    });
    const start = runOutsideDbContext(() => startNetworkIsolation(f.auth, f.device.id, input, { requestedByKind: 'system' }));
    void start.catch(() => {});
    let fence: Promise<void> | undefined;
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      await bounded(Promise.race([startLocked.promise, start.then(() => {
        throw new Error('Start completed before reaching its device lock');
      })]), 'start device lock');
      if (kind === 'merge') {
        // Phase A fences the org while the already-started request is in flight.
        await withSystemDbAccessContext(() => db.update(organizations).set({ status: 'merging' })
          .where(eq(organizations.id, f.loser.id)));
      }
      fence = systemTransaction(async () => {
        await db.execute(sql`SET LOCAL statement_timeout = '15s'`);
        if (kind === 'merge') await mergePrefix(f);
        fencePid = await pid();
        fenceReady.release();
        if (kind === 'merge') await assertMergeIsolationSafe(f.loser.id, false);
        else await assertIsolationErasureSafe(f.loser.id);
      });
      void fence.catch(() => {});
      await bounded(Promise.race([fenceReady.promise, fence.then(() => {
        throw new Error('Fence completed before reaching its device scan');
      })]), 'fence prefix');
      expect(fencePid).not.toBe(startPid);
      // Release only once Postgres confirms the device wait. A sleep alone
      // could run both operations serially and miss the original deadlock.
      await waitForDeviceBlock(fencePid, startPid);
    } finally {
      releaseStart.release();
      // Even failed barrier assertions drain both transactions before cleanup.
      outcomes = await Promise.allSettled([start, ...(fence ? [fence] : [])]);
    }
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(sqlState(outcome.reason)).not.toBe('40P01');
    }
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
    if (outcomes[0]!.status === 'fulfilled') expect(outcomes[0]!.value).not.toHaveProperty('error');
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: kind === 'merge'
      ? { blockerCodes: ['isolation_unresolved'] }
      : { code: 'isolation_unresolved' } });
  }, 45_000);
});
