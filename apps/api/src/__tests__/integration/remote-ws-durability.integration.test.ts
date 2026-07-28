/**
 * Wave 4 / Task 9 — Step 4 (durability core): cross-process shared ownership.
 *
 * SCOPE
 * -----
 * This file covers the FOUR cross-process ownership bullets of Task 9 Step 4:
 *
 *   1. two independent server processes sharing Redis — one wins, the other
 *      receives `already_owned`, exact renewal works, stale renewal/release
 *      fail, and the per-`kind`/`sessionId` generation keeps increasing across
 *      a process restart;
 *   2. pausing the winner past `safeForwardingUntilMonotonicMs` while its
 *      Redis key is still alive — local callbacks forward nothing, the loser
 *      cannot acquire until real Redis expiry and can afterwards, with a
 *      provable no-overlap gap;
 *   3. Redis partition / renew failure — forwarding is disabled BEFORE any
 *      cleanup and BEFORE a replacement can acquire;
 *   4. the owner replaced before a stale cleanup — the stale instance performs
 *      a local-only detach and emits no agent stop, no finalization, no DB
 *      write and no audit against the replacement.
 *
 * The remaining Step 4 bullets (BullMQ/finalization durability, the SIGKILL
 * crash-recovery matrix, Redis Cluster, and the V0/lease cutover harness) are
 * DEFERRED by explicit decision and are NOT covered here.
 *
 * NOTHING IS MOCKED. Real Redis, real Postgres, real HTTP listeners, and two
 * genuinely separate OS processes (`__tests__/fixtures/remoteWsLeaseServer.ts`)
 * with distinct boot UUIDs. Substituting two manager objects in one process is
 * forbidden by the plan and would prove nothing: `instanceId`, the local
 * registries and the `db` pool are all process-global singletons.
 *
 * ISOLATION
 * ---------
 * Dedicated database `breeze_test_w4` on :5433 and the shared test Redis on
 * :6380. Every session id is a fresh UUID so the `remote:ws:{kind:sessionId}:*`
 * slots cannot collide with another wave; `afterAll` deletes every key touched
 * (`:generation` is intentionally non-expiring in production).
 *
 * Run:
 *   DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test_w4 \
 *   DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test_w4 \
 *   REDIS_URL=redis://localhost:6380 NODE_ENV=test \
 *   pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/remote-ws-durability.integration.test.ts
 */
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.WS_TICKETS_REQUIRE_REDIS = 'true';

import './setup';
import { getTestDb, getTestRedis } from './setup';
import { setupTestEnvironment } from './db-utils';
import { auditLogs, deviceCommands, devices, remoteSessions } from '../../db/schema';
import { createWsTicket } from '../../services/remoteSessionAuth';
import {
  getRemoteWsRedisKeys,
  REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS,
  REMOTE_WS_SHARED_LEASE_TTL_MS,
} from '../../services/remoteWsSharedLease';
import type { RemoteWsKind } from '../../services/remoteWsOwnership';

const CHILD_ENTRY = fileURLToPath(
  new URL('../fixtures/remoteWsLeaseServer.ts', import.meta.url),
);

// ---------------------------------------------------------------------------
// Child-process harness
// ---------------------------------------------------------------------------

interface LeaseProcess {
  name: string;
  instanceId: string;
  pid: number;
  send: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
  stderr: () => string;
}

const running: ChildProcess[] = [];

async function startLeaseProcess(name: string): Promise<LeaseProcess> {
  const child = fork(CHILD_ENTRY, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // The fixture drives the desktop route's pre-upgrade middleware; that
      // path must not need live DB authorization, so keep it in the rollout
      // mode the wave ships first.
      REMOTE_WS_AUTH_MODE: 'post_upgrade',
      WS_TICKETS_REQUIRE_REDIS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  running.push(child);

  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });

  const ready = await new Promise<{ port: number; instanceId: string; pid: number }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `${name} did not become ready in 60s\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
        ));
      }, 60_000);
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message as { port: number; instanceId: string; pid: number });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${name} exited early (${code})\n${stderr}`));
      });
    },
  );

  const send = async (command: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    return (await response.json()) as Record<string, unknown>;
  };

  return {
    name,
    instanceId: ready.instanceId,
    pid: ready.pid,
    send,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        await send({ op: 'shutdown' });
      } catch {
        // The child may already be gone; the kill below is the backstop.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Redis helpers (parent's own connection — never the children's)
// ---------------------------------------------------------------------------

const touchedSlots: Array<{ kind: RemoteWsKind; sessionId: string }> = [];

function slot(kind: RemoteWsKind): string {
  const sessionId = randomUUID();
  touchedSlots.push({ kind, sessionId });
  return sessionId;
}

function trackSlot(kind: RemoteWsKind, sessionId: string): string {
  touchedSlots.push({ kind, sessionId });
  return sessionId;
}

/**
 * Compress an owner key's remaining TTL and wait for Redis to actually expire
 * it. This is a real Redis expiry — the same DEL-on-expiry the 30 s TTL
 * performs — not a manual key deletion and not a stubbed clock.
 */
async function expireOwnerNow(kind: RemoteWsKind, sessionId: string): Promise<void> {
  const redis = getTestRedis();
  const key = getRemoteWsRedisKeys(kind, sessionId).owner;
  await redis.pexpire(key, 1);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await redis.exists(key)) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`owner key for ${kind}:${sessionId} never expired`);
}

async function waitForOwnerExpiry(kind: RemoteWsKind, sessionId: string, timeoutMs: number) {
  const redis = getTestRedis();
  const key = getRemoteWsRedisKeys(kind, sessionId).owner;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await redis.exists(key)) === 0) return Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`owner key for ${kind}:${sessionId} still present after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let originalAppendOnly = 'no';
let alpha: LeaseProcess;
let beta: LeaseProcess;

beforeAll(async () => {
  // The topology monitor refuses admission unless Redis reports
  // `aof_enabled:1` / `noeviction` / `cluster_enabled:0` / role `master`. The
  // shared test Redis boots with `--appendonly no`, so bring the REAL server
  // to the supported production shape (and restore it afterwards).
  const redis = getTestRedis();
  const current = (await redis.config('GET', 'appendonly')) as unknown as string[];
  originalAppendOnly = current[1] ?? 'no';
  if (originalAppendOnly !== 'yes') await redis.config('SET', 'appendonly', 'yes');

  [alpha, beta] = await Promise.all([
    startLeaseProcess('alpha'),
    startLeaseProcess('beta'),
  ]);
}, 120_000);

afterAll(async () => {
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  const redis = getTestRedis();
  const keys: string[] = [];
  for (const entry of touchedSlots) {
    const slotKeys = getRemoteWsRedisKeys(entry.kind, entry.sessionId);
    keys.push(slotKeys.owner, slotKeys.generation);
    if (slotKeys.finalizing) keys.push(slotKeys.finalizing);
    if (slotKeys.finalizationPayload) keys.push(slotKeys.finalizationPayload);
  }
  if (keys.length > 0) await redis.del(...keys);
  if (originalAppendOnly !== 'yes') await redis.config('SET', 'appendonly', originalAppendOnly);
}, 60_000);

// ---------------------------------------------------------------------------
// 1. Two independent processes
// ---------------------------------------------------------------------------

describe('two independent OS processes share one Redis owner', () => {
  it('the processes really are distinct replicas', () => {
    expect(alpha.instanceId).not.toBe(beta.instanceId);
    expect(alpha.pid).not.toBe(beta.pid);
    expect(alpha.pid).not.toBe(process.pid);
    expect(beta.pid).not.toBe(process.pid);
  });

  it.each<RemoteWsKind>(['terminal', 'desktop', 'tunnel'])(
    '%s — exactly one process wins; the other gets already_owned',
    async (kind) => {
      const sessionId = slot(kind);

      const won = await alpha.send({ op: 'acquire', kind, sessionId });
      const lost = await beta.send({ op: 'acquire', kind, sessionId });

      expect(won.ok).toBe(true);
      expect(lost).toMatchObject({ ok: false, reason: 'already_owned' });

      const claim = won.claim as Record<string, unknown>;
      expect(claim.instanceId).toBe(alpha.instanceId);
      expect(claim.generation).toBe(1);
      // The stored owner value is exactly the winner's — not the loser's.
      const stored = await getTestRedis().get(getRemoteWsRedisKeys(kind, sessionId).owner);
      expect(stored).toBe(claim.ownerValue);
    },
  );

  it('exact renewal works and advances only the owner deadline', async () => {
    const sessionId = slot('terminal');
    const acquired = await alpha.send({ op: 'acquire', kind: 'terminal', sessionId });
    expect(acquired.ok).toBe(true);
    const before = Number(
      (acquired.claim as Record<string, number>).safeForwardingUntilMonotonicMs,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    const renewed = await alpha.send({ op: 'renew', kind: 'terminal', sessionId });

    expect(renewed.ok).toBe(true);
    expect(renewed.safeForwardingUntilMonotonicMs as number).toBeGreaterThan(before);
    // The renewal is a PEXPIRE on the same value — the owner never changes.
    const stored = await getTestRedis().get(getRemoteWsRedisKeys('terminal', sessionId).owner);
    expect(stored).toBe((acquired.claim as Record<string, string>).ownerValue);
    const ttl = await getTestRedis().pttl(getRemoteWsRedisKeys('terminal', sessionId).owner);
    expect(ttl).toBeGreaterThan(REMOTE_WS_SHARED_LEASE_TTL_MS - 2_000);
  });

  it('a stale claim can neither renew nor release the replacement owner', async () => {
    const sessionId = slot('tunnel');

    const first = await alpha.send({ op: 'acquire', kind: 'tunnel', sessionId });
    expect(first.ok).toBe(true);
    expect(await alpha.send({ op: 'release', kind: 'tunnel', sessionId })).toMatchObject({
      ok: true,
    });

    // Alpha still HOLDS the object it acquired with. Everything below replays
    // that now-stale claim.
    const staleRenewAfterRelease = await alpha.send({ op: 'renew', kind: 'tunnel', sessionId });
    expect(staleRenewAfterRelease.ok).toBe(false);
    expect(String(staleRenewAfterRelease.reason)).toContain('owner_mismatch');

    const staleReleaseAfterRelease = await alpha.send({
      op: 'release', kind: 'tunnel', sessionId,
    });
    expect(staleReleaseAfterRelease).toMatchObject({ ok: false });

    // Beta legitimately takes over the free slot.
    const replacement = await beta.send({ op: 'acquire', kind: 'tunnel', sessionId });
    expect(replacement.ok).toBe(true);
    const replacementOwner = (replacement.claim as Record<string, string>).ownerValue;

    // Alpha's stale claim must not touch the replacement.
    expect((await alpha.send({ op: 'renew', kind: 'tunnel', sessionId })).ok).toBe(false);
    expect(await alpha.send({ op: 'release', kind: 'tunnel', sessionId }))
      .toMatchObject({ ok: false });
    expect(await alpha.send({ op: 'beginClose', kind: 'tunnel', sessionId }))
      .toMatchObject({ ok: false, reason: 'owner_mismatch' });

    const stored = await getTestRedis().get(getRemoteWsRedisKeys('tunnel', sessionId).owner);
    expect(stored).toBe(replacementOwner);
  });

  it('the generation is per kind+session, persistent, and survives a process restart', async () => {
    const sessionId = randomUUID();
    trackSlot('terminal', sessionId);
    trackSlot('desktop', sessionId);

    const firstTerminal = await alpha.send({ op: 'acquire', kind: 'terminal', sessionId });
    expect((firstTerminal.claim as Record<string, number>).generation).toBe(1);

    // A different kind on the same session id is a DIFFERENT resource.
    const firstDesktop = await alpha.send({ op: 'acquire', kind: 'desktop', sessionId });
    expect((firstDesktop.claim as Record<string, number>).generation).toBe(1);

    expect(await alpha.send({ op: 'release', kind: 'terminal', sessionId }))
      .toMatchObject({ ok: true });

    // Restart: a brand new OS process with a brand new boot UUID.
    const gamma = await startLeaseProcess('gamma');
    try {
      expect(gamma.instanceId).not.toBe(alpha.instanceId);
      const afterRestart = await gamma.send({ op: 'acquire', kind: 'terminal', sessionId });
      const claim = afterRestart.claim as Record<string, unknown>;

      expect(afterRestart.ok).toBe(true);
      // Generation is a persistent per-resource INCR: a release + restart
      // must never let a later connection reuse an earlier generation.
      expect(claim.generation).toBe(2);
      expect(claim.instanceId).toBe(gamma.instanceId);
      // The desktop slot for the same session id was untouched.
      const desktopGeneration = await getTestRedis()
        .get(getRemoteWsRedisKeys('desktop', sessionId).generation);
      expect(desktopGeneration).toBe('1');
    } finally {
      await gamma.stop();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. Event-loop pause past the forwarding deadline
// ---------------------------------------------------------------------------

describe('a paused owner stops forwarding long before Redis can hand over', () => {
  it(
    'forwarding dies at the deadline, the loser waits for real expiry, and the windows never overlap',
    async () => {
      const kind: RemoteWsKind = 'terminal';
      const sessionId = slot(kind);
      const redis = getTestRedis();
      const ownerKey = getRemoteWsRedisKeys(kind, sessionId).owner;

      const acquired = await alpha.send({ op: 'acquire', kind, sessionId });
      expect(acquired.ok).toBe(true);
      const acquiredAtWallMs = acquired.wallStartMs as number;
      expect(await alpha.send({ op: 'installAndBind', kind, sessionId }))
        .toMatchObject({ ok: true });

      // Baseline: a bound, in-deadline socket DOES forward.
      const healthy = await alpha.send({ op: 'probeForward', kind, sessionId, payload: 'a' });
      expect(healthy).toMatchObject({ forwarded: true });

      // Block alpha's event loop past `TTL - safetyMargin` (20 s) but well
      // inside the 30 s Redis TTL. No timer, renewal or cleanup can run.
      const blockMs = REMOTE_WS_SHARED_LEASE_TTL_MS
        - REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS
        + 1_000;
      const afterPause = await alpha.send({
        op: 'blockThenProbe', kind, sessionId, ms: blockMs, payload: 'b',
      });

      expect(afterPause.blockedForMs as number).toBeGreaterThanOrEqual(blockMs - 50);
      // The whole point: the resumed callback is inert.
      expect(afterPause).toMatchObject({ forwarded: false });
      expect(afterPause.monotonicNowMs as number)
        .toBeGreaterThan(afterPause.safeForwardingUntilMonotonicMs as number);
      // Only the pre-pause probe ever reached the sink.
      expect((await alpha.send({ op: 'agentSink' })).entries).toHaveLength(1);

      // ... and the Redis key is still very much alive at this point.
      expect(await redis.exists(ownerKey)).toBe(1);
      expect(await beta.send({ op: 'acquire', kind, sessionId }))
        .toMatchObject({ ok: false, reason: 'already_owned' });

      // Let the lease die of natural causes.
      const expiredAtWallMs = await waitForOwnerExpiry(kind, sessionId, 20_000);
      const replacement = await beta.send({ op: 'acquire', kind, sessionId });
      expect(replacement.ok).toBe(true);
      const claim = replacement.claim as Record<string, unknown>;
      expect(claim.instanceId).toBe(beta.instanceId);
      expect(claim.generation).toBe(2);

      // No overlap: the replacement could not acquire until at least a full
      // TTL after the incumbent's acquire, i.e. at least one whole safety
      // margin after the incumbent stopped being allowed to forward.
      const handoverGapMs = (replacement.wallStartMs as number) - acquiredAtWallMs;
      expect(handoverGapMs).toBeGreaterThanOrEqual(
        REMOTE_WS_SHARED_LEASE_TTL_MS - REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS,
      );
      expect(expiredAtWallMs - acquiredAtWallMs).toBeGreaterThanOrEqual(
        REMOTE_WS_SHARED_LEASE_TTL_MS - REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS,
      );

      // The stale incumbent still cannot forward after the handover.
      expect(await alpha.send({ op: 'probeForward', kind, sessionId, payload: 'c' }))
        .toMatchObject({ forwarded: false });
      expect((await alpha.send({ op: 'agentSink' })).entries).toHaveLength(1);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// 3. Redis partition / renew failure
// ---------------------------------------------------------------------------

describe('a Redis partition disables forwarding before cleanup and before handover', () => {
  it('renew failure zeroes the deadline while the key is still alive', async () => {
    const kind: RemoteWsKind = 'desktop';
    const sessionId = slot(kind);
    const redis = getTestRedis();
    const ownerKey = getRemoteWsRedisKeys(kind, sessionId).owner;

    // A dedicated process so the partition cannot affect the other scenarios.
    const delta = await startLeaseProcess('delta');
    try {
      expect(await delta.send({ op: 'acquire', kind, sessionId })).toMatchObject({ ok: true });
      expect(await delta.send({ op: 'installAndBind', kind, sessionId }))
        .toMatchObject({ ok: true });
      expect(await delta.send({ op: 'probeForward', kind, sessionId }))
        .toMatchObject({ forwarded: true });

      // Sever the replica's Redis connection. ioredis is configured not to
      // heal it, so this is a genuine partition for this process.
      expect(await delta.send({ op: 'partition' })).toMatchObject({ ok: true });

      const renewal = await delta.send({ op: 'renewLocal', kind, sessionId });

      // (a) Forwarding is off — and it went off inside `renew()` BEFORE the
      //     Redis round trip, not as a consequence of any cleanup.
      expect(renewal).toMatchObject({ ok: false, safeForwardingUntilMonotonicMs: 0 });
      expect(await delta.send({ op: 'probeForward', kind, sessionId }))
        .toMatchObject({ forwarded: false });
      expect((await delta.send({ op: 'agentSink' })).entries).toHaveLength(1);

      // (b) No cleanup has happened: the exact local entry is still installed
      //     and still `active`. Forwarding died first.
      expect(renewal).toMatchObject({ stillInstalled: true, state: 'active' });
      expect(await delta.send({ op: 'localState', kind, sessionId }))
        .toMatchObject({ installed: true, safeForwardingUntilMonotonicMs: 0 });

      // (c) No replacement can acquire yet — the key outlives the partition,
      //     so the handover is still fenced behind the full TTL.
      expect(await redis.exists(ownerKey)).toBe(1);
      expect(await beta.send({ op: 'acquire', kind, sessionId }))
        .toMatchObject({ ok: false, reason: 'already_owned' });

      // Only once the lease genuinely expires may a replacement take over.
      await expireOwnerNow(kind, sessionId);
      const replacement = await beta.send({ op: 'acquire', kind, sessionId });
      expect(replacement.ok).toBe(true);
      expect((replacement.claim as Record<string, unknown>).generation).toBe(2);
    } finally {
      await delta.stop();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. Stale cleanup against a replacement owner
// ---------------------------------------------------------------------------

describe('a stale instance cleans up locally and never touches the replacement', () => {
  interface DesktopFixture {
    sessionId: string;
    deviceId: string;
    orgId: string;
    userId: string;
    ticket: string;
  }

  async function createDesktopFixture(): Promise<DesktopFixture> {
    const env = await setupTestEnvironment();
    const agentId = `agent-w4-durability-${randomUUID()}`;
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId,
        hostname: `w4-durability-${agentId.slice(-12)}`,
        displayName: 'W4 Durability Host',
        osType: 'windows',
        osVersion: '11',
        osBuild: '22000',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        enrolledAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('createDesktopFixture: no device');

    const [session] = await getTestDb()
      .insert(remoteSessions)
      .values({
        deviceId: device.id,
        orgId: env.organization.id,
        userId: env.user.id,
        type: 'desktop',
        // `pending` and freshly created: `recoverDesktopFinalizationOrphan`
        // treats this as `not_orphaned`, which is the real admission window.
        status: 'pending',
        iceCandidates: [],
      })
      .returning({ id: remoteSessions.id });
    if (!session) throw new Error('createDesktopFixture: no session');
    trackSlot('desktop', session.id);

    const { ticket } = await createWsTicket({
      sessionId: session.id,
      sessionType: 'desktop',
      userId: env.user.id,
      mfaSatisfied: true,
    });

    return {
      sessionId: session.id,
      deviceId: device.id,
      orgId: env.organization.id,
      userId: env.user.id,
      ticket,
    };
  }

  it(
    'the stale owner detaches locally and emits no stop, finalization, DB write or audit',
    async () => {
      const redis = getTestRedis();
      const tdb = getTestDb();
      const fixture = await createDesktopFixture();
      const controlFixture = await createDesktopFixture();

      // Two more dedicated processes: `stale` is the incumbent whose lease
      // lapses, `fresh` is the replacement.
      const stale = await startLeaseProcess('stale');
      const fresh = await startLeaseProcess('fresh');
      try {
        // -- the incumbent is admitted through the REAL desktop middleware ---
        const admitted = await stale.send({
          op: 'desktopAdmit',
          sessionId: fixture.sessionId,
          ticket: fixture.ticket,
        });
        expect(admitted).toMatchObject({ status: 200, activeDesktopSessions: 1 });
        expect(admitted.connection).not.toBeNull();

        const controlAdmitted = await stale.send({
          op: 'desktopAdmit',
          sessionId: controlFixture.sessionId,
          ticket: controlFixture.ticket,
        });
        expect(controlAdmitted).toMatchObject({ status: 200 });

        // -- the incumbent's lease lapses and a replacement takes the slot ---
        await expireOwnerNow('desktop', fixture.sessionId);
        const replacement = await fresh.send({
          op: 'acquire', kind: 'desktop', sessionId: fixture.sessionId,
        });
        expect(replacement.ok).toBe(true);
        const replacementOwner = (replacement.claim as Record<string, string>).ownerValue;
        expect((replacement.claim as Record<string, string>).instanceId)
          .toBe(fresh.instanceId);

        const auditBefore = await tdb
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs);

        // -- the stale instance now runs the REAL close lifecycle -----------
        const closed = await stale.send({ op: 'desktopClose', sessionId: fixture.sessionId });

        // It resolves quietly: `beginClose` reported `owner_mismatch`, so the
        // only action permitted is detaching this exact local socket.
        expect(closed).toMatchObject({ settled: 'resolved', activeDesktopSessions: 1 });

        // (a) NO agent stop — no durable `desktop_stream_stop` command exists.
        const stopCommands = await tdb
          .select({ id: deviceCommands.id })
          .from(deviceCommands)
          .where(and(
            eq(deviceCommands.deviceId, fixture.deviceId),
            eq(deviceCommands.type, 'desktop_stream_stop'),
          ));
        expect(stopCommands).toHaveLength(0);

        // (b) NO finalization — neither fence nor payload was written.
        const desktopKeys = getRemoteWsRedisKeys('desktop', fixture.sessionId);
        expect(await redis.exists(desktopKeys.finalizing as string)).toBe(0);
        expect(await redis.exists(desktopKeys.finalizationPayload as string)).toBe(0);

        // (c) NO DB write against the session the replacement now owns.
        const [row] = await tdb
          .select({ status: remoteSessions.status, endedAt: remoteSessions.endedAt })
          .from(remoteSessions)
          .where(eq(remoteSessions.id, fixture.sessionId));
        expect(row).toMatchObject({ status: 'pending', endedAt: null });

        // (d) NO audit.
        const auditAfter = await tdb
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs);
        expect(auditAfter[0]?.count).toBe(auditBefore[0]?.count);

        // (e) The replacement's shared owner is byte-identical — the stale
        //     instance never released or overwrote it.
        expect(await redis.get(desktopKeys.owner)).toBe(replacementOwner);

        // (f) LOCAL-ONLY detach really happened: the stale process dropped its
        //     exact entry (2 admitted -> 1 left, the control session).
        expect(await stale.send({ op: 'localState', kind: 'desktop', sessionId: fixture.sessionId }))
          .toMatchObject({ installed: false });

        // -- NON-VACUITY CONTROL --------------------------------------------
        // Identical call, identical code, on the session where this process
        // is STILL the exact Redis owner. `beginClose` returns `still_owner`,
        // so the lifecycle proceeds PAST the local-only branch into
        // write-ahead intent persistence — which rejects here only because the
        // fixture never ran `onOpen` to populate org/user/device ids. A
        // `rejected` settlement is therefore proof that the quiet `resolved`
        // above was selected by OWNERSHIP, not by the lifecycle being inert.
        expect(await redis.exists(
          getRemoteWsRedisKeys('desktop', controlFixture.sessionId).owner,
        )).toBe(1);
        const controlClosed = await stale.send({
          op: 'desktopClose', sessionId: controlFixture.sessionId,
        });
        expect(controlClosed.settled).toBe('rejected');

        // -- NON-VACUITY CONTROL for assertion (a) --------------------------
        // Run the REAL durable stop path against the SAME device with a valid
        // payload, then re-run the exact query used above. It must now find a
        // row — otherwise "no agent stop" was never observable in the first
        // place.
        const controlStop = await fresh.send({
          op: 'ensureStop',
          sessionId: fixture.sessionId,
          finalizationId: randomUUID(),
          orgId: fixture.orgId,
          userId: fixture.userId,
          deviceId: fixture.deviceId,
        });
        expect(controlStop.ok).toBe(true);
        const observedStops = await tdb
          .select({ id: deviceCommands.id })
          .from(deviceCommands)
          .where(and(
            eq(deviceCommands.deviceId, fixture.deviceId),
            eq(deviceCommands.type, 'desktop_stream_stop'),
          ));
        expect(observedStops).toHaveLength(1);
      } finally {
        await stale.stop();
        await fresh.stop();
      }
    },
    180_000,
  );

  it('write-ahead intent persistence is refused once the owner has been replaced', async () => {
    const redis = getTestRedis();
    const sessionId = slot('desktop');
    const keys = getRemoteWsRedisKeys('desktop', sessionId);
    const finalizationId = randomUUID();
    const identity = {
      orgId: randomUUID(),
      userId: randomUUID(),
      deviceId: randomUUID(),
    };

    // POSITIVE CONTROL: as the exact owner, the REAL
    // `persistDesktopFinalizationIntent` writes both keys.
    expect(await alpha.send({ op: 'acquire', kind: 'desktop', sessionId }))
      .toMatchObject({ ok: true });
    const wrote = await alpha.send({
      op: 'persistIntent', sessionId, finalizationId, ...identity,
    });
    expect(wrote.ok).toBe(true);
    expect(await redis.get(keys.finalizing as string)).toBe(finalizationId);
    expect(await redis.get(keys.finalizationPayload as string)).toBe(wrote.canonicalPayload);
    // The fence and payload are deliberately non-expiring.
    expect(await redis.pttl(keys.finalizing as string)).toBe(-1);
    expect(await redis.pttl(keys.finalizationPayload as string)).toBe(-1);

    // NEGATIVE CASE: a second slot where the owner is replaced first.
    const replacedSession = slot('desktop');
    const replacedKeys = getRemoteWsRedisKeys('desktop', replacedSession);
    expect(await alpha.send({ op: 'acquire', kind: 'desktop', sessionId: replacedSession }))
      .toMatchObject({ ok: true });
    await expireOwnerNow('desktop', replacedSession);
    expect(await beta.send({ op: 'acquire', kind: 'desktop', sessionId: replacedSession }))
      .toMatchObject({ ok: true });

    const refused = await alpha.send({
      op: 'persistIntent',
      sessionId: replacedSession,
      finalizationId: randomUUID(),
      ...identity,
    });

    expect(refused.ok).toBe(false);
    expect(String(refused.reason)).toMatch(/owner_mismatch|owner mismatch/);
    expect(await redis.exists(replacedKeys.finalizing as string)).toBe(0);
    expect(await redis.exists(replacedKeys.finalizationPayload as string)).toBe(0);
  }, 120_000);
});
