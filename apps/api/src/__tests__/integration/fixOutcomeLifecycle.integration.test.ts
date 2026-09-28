// apps/api/src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, deviceCommands, deviceMetrics, devices, fixMemory, fixOutcomes, remediationSuggestions, scriptExecutions, scripts, scriptVersions } from '../../db/schema';
import { propagateTimedOutDeviceCommand } from '../../jobs/staleCommandReaper';
import { eraseOrgWithFixMemory } from '../../jobs/tenantErasure';
import { advanceOutcome, handleFixOutcomeEvent } from '../../services/fixMemory/outcomeWatcher';
import { lookupFixes } from '../../services/fixMemory/lookup';
import { recordOutcomeVote } from '../../services/fixMemory/outcomeRecorder';
import { advanceOutcomesForTerminalExecution } from '../../services/fixMemory/scriptTerminalHook';
import { alertSignature } from '../../services/fixMemory/signatureLoader';
import {
  fillOutcomeSignature, markFixMemoryStaleForOrgErasure, markOwnerDriftStale, rebuildFixMemory, recomputeForOutcome,
  stalePartnerIds, transitionOutcome,
} from '../../services/fixMemory/store';
import { executeOrgMerge } from '../../services/orgMerge';
import { probeTelemetryFreshness } from '../../services/outcomeProbes';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { seedEpisode } from './metricAnomalyEpisodeFixtures';
import { getTestDb } from './setup';

const H = 3_600_000;
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

/** A promise the test opens by hand, to hold a transaction (and its locks) open. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => wait, open: () => open() };
}

/**
 * The Postgres lock `p`'s backend is waiting on (pg_stat_activity.wait_event: 'advisory',
 * 'transactionid', 'tuple', …), or null when `p` settled without ever blocking.
 * Observed, not timed: a fixed sleep cannot tell "blocked on a lock" from "still in its
 * context prologue", and a writer that is merely slow to reach its read would let a
 * lock-removal control pass (it did, once, for the rebuild case).
 * Only a CLIENT backend that some other backend actually blocks counts, so an
 * autovacuum/background wait or a transient self-resolving wait is never reported.
 * `timeoutMs` (15 s) is a give-up bound, not a wait: polling returns as soon as the
 * writer blocks or settles. It sits under the 30 s integration testTimeout so a writer
 * that does neither fails with this message instead of an anonymous test timeout.
 */
async function blockedOn(p: Promise<unknown>, timeoutMs = 15_000): Promise<string | null> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (!settled && Date.now() < deadline) {
    const waiting = await getTestDb().execute<{ wait_event: string }>(sql`
      SELECT wait_event FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        AND cardinality(pg_blocking_pids(pid)) > 0`);
    const [first] = [...waiting];
    if (first) return first.wait_event;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!settled) throw new Error('blockedOn: the writer neither blocked nor settled');
  return null;
}

/**
 * Wait for `g` to open, but fail fast if `tx` settles first: a transaction that threw
 * before reaching its gate would otherwise leave the test hanging on a gate nobody opens.
 */
async function reachedOrSettled(g: ReturnType<typeof gate>, tx: Promise<unknown>): Promise<void> {
  await Promise.race([
    g.wait(),
    tx.then(() => { throw new Error('the gated transaction finished without reaching its gate'); }),
  ]);
}

const outcomeRow = async (id: string) => (await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.id, id))))[0]!;
const partnerMemory = async (partnerId: string) => sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, partnerId)));

async function world() {
  const partner = await createPartner();
  const o1 = await createOrganization({ partnerId: partner.id });
  const o2 = await createOrganization({ partnerId: partner.id });
  const mkDevice = async (orgId: string) => {
    const site = await createSite({ orgId });
    const [d] = await sys(() => db.insert(devices).values({
      orgId, siteId: site.id, agentId: randomUUID(), hostname: `host-${randomUUID().slice(0, 6)}`,
      osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id }));
    return d!.id;
  };
  const d1 = await mkDevice(o1.id);
  const d2 = await mkDevice(o2.id);
  const mkScript = async (owner: { orgId?: string; partnerId?: string }) => {
    const [s] = await sys(() => db.insert(scripts).values({
      name: `fix-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Restart-Service Spooler',
      osTypes: ['windows'], orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null,
    }).returning({ id: scripts.id }));
    const [v] = await sys(() => db.insert(scriptVersions).values({
      scriptId: s!.id, version: 1, content: 'Restart-Service Spooler', language: 'powershell', timeoutSeconds: 300,
      runAs: 'system', contentDigest: createHash('sha256').update('Restart-Service Spooler').digest('hex'),
    }).returning({ id: scriptVersions.id }));
    return { scriptId: s!.id, versionId: v!.id };
  };
  const partnerScript = await mkScript({ partnerId: partner.id });
  return { partnerId: partner.id, o1: o1.id, o2: o2.id, d1, d2, partnerScript, mkScript };
}

/** One attempt: an exit-code alert (non-broad signature) + a completed run + a pending outcome created at `t0`. */
async function attempt(w: Awaited<ReturnType<typeof world>>, orgId: string, deviceId: string, fix: { scriptId: string; versionId: string }, t0: Date, fixKind: 'partner_script' | 'org_script' = 'partner_script') {
  const watchedScript = w.partnerScript.scriptId; // the MONITORED script whose exit code alerts
  const [alert] = await sys(() => db.insert(alerts).values({
    orgId, deviceId, severity: 'high', title: 'exit 3', triggeredAt: new Date(t0.getTime() - H),
    context: { source: 'script_exit_code', scriptId: watchedScript, exitCode: 3 },
  }).returning({ id: alerts.id }));
  const [exec] = await sys(() => db.insert(scriptExecutions).values({
    scriptId: fix.scriptId, deviceId, orgId, status: 'completed', exitCode: 0, scriptVersionId: fix.versionId,
    completedAt: new Date(t0.getTime() + 60_000),
  }).returning({ id: scriptExecutions.id }));
  const [o] = await sys(() => db.insert(fixOutcomes).values({
    orgId, partnerId: w.partnerId, deviceId, sourceType: 'alert', sourceId: alert!.id, alertId: alert!.id,
    fixKind, fixIdentity: `script_version:${fix.versionId}`, scriptId: fix.scriptId, scriptVersionId: fix.versionId,
    scriptExecutionId: exec!.id, state: 'pending', deadlineAt: new Date(t0.getTime() + 24 * H), createdAt: t0,
  }).returning());
  return { outcomeId: o!.id, alertId: alert!.id };
}

async function resolveByCondition(alertId: string, at: Date) {
  await sys(() => db.update(alerts).set({ status: 'resolved', resolvedAt: at, resolutionReason: 'condition_cleared' }).where(eq(alerts.id, alertId)));
}

async function reportTelemetry(orgId: string, deviceId: string, from: Date, to: Date) {
  const rows: (typeof deviceMetrics.$inferInsert)[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 30 * 60_000) {
    rows.push({ deviceId, orgId, timestamp: new Date(t), cpuPercent: 5, ramPercent: 40, ramUsedMb: 2048, diskPercent: 50, diskUsedGb: 100 });
  }
  await sys(() => db.insert(deviceMetrics).values(rows).onConflictDoNothing());
  await sys(() => db.update(devices).set({ lastSeenAt: new Date(to.getTime() - 5 * 60_000) }).where(eq(devices.id, deviceId)));
}

/** Drive one attempt to `verified` along the happy path. */
async function verify(w: Awaited<ReturnType<typeof world>>, orgId: string, deviceId: string, fix: { scriptId: string; versionId: string }, t0: Date, fixKind?: 'partner_script' | 'org_script') {
  const a = await attempt(w, orgId, deviceId, fix, t0, fixKind);
  expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) })).toBe('awaiting_recovery');
  await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
  expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
  await reportTelemetry(orgId, deviceId, new Date(t0.getTime() + H), new Date(t0.getTime() + 25 * H));
  expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 25 * H + 60_000) })).toBe('verified');
  return a;
}

async function memoryFor(w: Awaited<ReturnType<typeof world>>, orgId: string, alertId: string) {
  const resolved = await sys(() => alertSignature(alertId));
  return sys(() => lookupFixes({ orgId, partnerId: w.partnerId, signature: resolved!.signature, limit: 5 }));
}

describe('fix outcome lifecycle (real Postgres)', () => {
  it('three verified attempts across two clients make a partner-wide proven fix', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 1);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H));
    const last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base + 60 * H));
    const out = await memoryFor(w, w.o2, last.alertId);
    expect(out.proven).toHaveLength(1);
    expect(out.proven[0]).toMatchObject({ scope: 'all_clients', attempts: 3, verified: 3 });
    const rows = await sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, w.partnerId)));
    expect(rows).toHaveLength(1); // one partner row, no per-org copies
  });

  it('two terminal transitions from the SAME holding snapshot: exactly one wins, and it counts once (Review Focus 1)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 5));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    const resolvedAt = new Date(t0.getTime() + H);
    await resolveByCondition(a.alertId, resolvedAt);
    const evt = { id: randomUUID(), type: 'alert.resolved', orgId: w.o1, source: 't', priority: 'normal',
      payload: { alertId: a.alertId, resolvedAt: resolvedAt.toISOString(), resolvedBy: null, resolutionReason: 'condition_cleared' },
      metadata: { timestamp: '' } } as never;
    await Promise.all([handleFixOutcomeEvent(evt), handleFixOutcomeEvent(evt)]); // redelivery
    const holding = await outcomeRow(a.outcomeId);
    expect(holding.state).toBe('holding');
    await reportTelemetry(w.o1, w.d1, resolvedAt, new Date(resolvedAt.getTime() + 24 * H));
    const end = new Date(resolvedAt.getTime() + 24 * H + 60_000);
    // Two writers (sweeper + event handler) holding the same pre-transition snapshot, each in its
    // own transaction. They may or may not overlap in time: if they do, the loser blocks on the row
    // lock and re-evaluates the CAS on the committed row; if not, the second simply finds the row
    // already counted. Either way exactly one wins. The aggregate alone cannot tell one winner from
    // two (a replay reads one outcome row either way), so the win count is the discriminating assertion.
    const wins = await Promise.all([
      sys(() => transitionOutcome(holding, { to: 'verified', reason: 'held_with_fresh_telemetry' }, end)),
      sys(() => transitionOutcome(holding, { to: 'verified', reason: 'held_with_fresh_telemetry' }, end)),
    ]);
    expect(wins.filter((won) => won)).toHaveLength(1);
    expect(wins.filter((won) => !won)).toHaveLength(1);
    expect(await advanceOutcome(a.outcomeId, { now: end })).toBe('verified'); // a late sweeper sees terminal and stops
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 1 });
  });

  it('a terminal transition from an unsigned snapshot still aggregates: the CAS-returned row carries the signature (Review Focus 1)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 4));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) }); // first advance signs the row
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
    const persisted = await outcomeRow(a.outcomeId);
    expect(persisted.signatureKey).not.toBeNull();
    // A watcher whose snapshot predates the signature fill.
    const unsigned = { ...persisted, signatureVersion: null, signatureKey: null, broadKey: null, osType: null };
    // Lost fill CAS -> the persisted (signed) row is reloaded, not the unsigned snapshot returned.
    expect((await sys(() => fillOutcomeSignature(unsigned, new Date()))).signatureKey).toBe(persisted.signatureKey);
    expect(await sys(() => transitionOutcome(unsigned, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date()))).toBe(true);
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 1 }); // counted AND aggregated, not counted-and-lost
  });

  it('a SQL failure inside the hook on a caller-supplied executor does not abort the caller’s transaction (savepoint, decision D-a)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The caller's open transaction is the system context's tx; `db` resolves to it, as the
      // executor commandCancelPropagation.ts:90-97 forwards. 'not-a-uuid' makes Postgres raise
      // 22P02 inside the hook's UPDATE.
      const survived = await sys(async () => {
        expect(await advanceOutcomesForTerminalExecution({ executionId: 'not-a-uuid', status: 'failed' }, db)).toBe(0);
        // Without the savepoint this statement raises 25P02 (current transaction is aborted).
        const probe = await db.select({ id: fixOutcomes.id }).from(fixOutcomes).limit(1);
        return Array.isArray(probe);
      });
      expect(survived).toBe(true); // and the caller's transaction committed
      expect(err).toHaveBeenCalled(); // the hook logged its own failure
    } finally {
      err.mockRestore();
    }
  });

  it('a human resolve is inconclusive and never counted (Review Focus 2)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 8));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    const user = await createUser({ partnerId: w.partnerId, orgId: w.o1, email: `fix-${randomUUID()}@example.com` });
    await sys(() => db.update(alerts).set({ status: 'resolved', resolvedAt: new Date(t0.getTime() + H), resolvedBy: user.id, resolutionReason: 'manual' }).where(eq(alerts.id, a.alertId)));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('inconclusive');
    expect(await sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, w.partnerId)))).toEqual([]);
  });

  it('a device offline at hold end is inconclusive, not verified (Review Focus 3)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 10));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) });
    await sys(() => db.update(devices).set({ lastSeenAt: new Date(t0.getTime() + 2 * H), status: 'offline' }).where(eq(devices.id, w.d1)));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 25 * H + 60_000) })).toBe('inconclusive');
    const [o] = await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.id, a.outcomeId)));
    expect(o!.stateReason).toBe('telemetry_heartbeat_stale');
  });

  it('erasure: a rebuild racing the cascade cannot clear the request, and a failed post-cascade rebuild is retried by the sweeper', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 12);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H));
    const last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base + 60 * H));
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toHaveLength(1);

    // Step 1 alone: stale + a durable request naming o2.
    expect(await sys(() => markFixMemoryStaleForOrgErasure(w.o2))).toBe(w.partnerId);
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toEqual([]); // stale => excluded
    expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 3, rebuildPendingOrgIds: [w.o2] });

    // A sweeper rebuild that runs before the cascade has deleted anything. o2 still exists,
    // so it must neither un-stale the row nor drop the request, even though its recount is
    // "successful". (The bug: stale_since was the only marker and this rebuild cleared it.)
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    const raced = (await partnerMemory(w.partnerId))[0]!;
    expect(raced).toMatchObject({ attempts: 3, rebuildPendingOrgIds: [w.o2] });
    expect(raced.staleSince).not.toBeNull();

    // The real erasure, with its post-cascade rebuild failing (swallowed by design).
    const actor = await createUser({ partnerId: w.partnerId, orgId: null, email: `erase-${randomUUID()}@example.com` });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await eraseOrgWithFixMemory(w.o2, actor.id, actor.email, { rebuild: async () => { throw new Error('injected rebuild failure'); } });
    } finally {
      err.mockRestore();
    }
    expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o2)))).toEqual([]);
    const stranded = (await partnerMemory(w.partnerId))[0]!;
    expect(stranded).toMatchObject({ attempts: 3, rebuildPendingOrgIds: [w.o2] }); // o2's attempt still counted...
    expect(stranded.staleSince).not.toBeNull(); // ...but out of "proven", and still requested (re-run of mark did not append twice)
    expect(await sys(() => stalePartnerIds(1000))).toContain(w.partnerId); // the sweeper selects it

    await sys(() => rebuildFixMemory({ partnerId: w.partnerId })); // what the sweeper's rebuild pass runs
    expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 2, verifiedCount: 2, staleSince: null, rebuildPendingOrgIds: [] });
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toEqual([]); // 2 verified < the 3-attempt proof bar
  }, 240_000); // the real org cascade walks every tenant table (13-45 s locally, load-dependent)

  it('script re-scope org→partner folds org history into the partner row (Review Focus 5)', async () => {
    const w = await world();
    const orgScript = await w.mkScript({ orgId: w.o1, partnerId: w.partnerId });
    const base = Date.UTC(2026, 10, 16);
    for (let i = 0; i < 3; i += 1) await verify(w, w.o1, w.d1, orgScript, new Date(base + i * 30 * H), 'org_script');
    expect(await sys(() => db.select().from(fixMemory).where(eq(fixMemory.orgId, w.o1)))).toHaveLength(1);
    await sys(() => db.update(scripts).set({ orgId: null }).where(eq(scripts.id, orgScript.scriptId)));
    expect(await sys(() => markOwnerDriftStale())).toBe(1); // exactly this test's one drifted row
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    expect(await sys(() => db.select().from(fixMemory).where(eq(fixMemory.orgId, w.o1)))).toEqual([]);
    const partnerRows = await sys(() => db.select().from(fixMemory).where(and(eq(fixMemory.partnerId, w.partnerId), isNull(fixMemory.orgId))));
    expect(partnerRows).toHaveLength(1);
    expect(partnerRows[0]).toMatchObject({ fixKind: 'partner_script', attempts: 3 });
  });

  it('a new script version drops the old proof out of "proven" (Review Focus 5)', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 20);
    let last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base + 30 * H));
    last = await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 60 * H));
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toHaveLength(1);
    await sys(() => db.insert(scriptVersions).values({
      scriptId: w.partnerScript.scriptId, version: 2, content: 'Restart-Service Spooler -Force', language: 'powershell',
      timeoutSeconds: 300, runAs: 'system', contentDigest: createHash('sha256').update('v2').digest('hex'),
    }));
    await sys(() => db.update(scripts).set({ version: 2 }).where(eq(scripts.id, w.partnerScript.scriptId)));
    const after = await memoryFor(w, w.o1, last.alertId);
    expect(after.proven).toEqual([]);
    expect(after.similar).toEqual([]); // undispatchable version is hidden everywhere
  });

  it('an already-counted outcome never counts twice, even when the state CAS would match (Review Focus 1)', async () => {
    const w = await world();
    const a = await verify(w, w.o1, w.d1, w.partnerScript, new Date(Date.UTC(2026, 10, 6)));
    const counted = await outcomeRow(a.outcomeId);
    expect(counted.state).toBe('verified');
    expect(counted.countedAt).not.toBeNull();
    // A stale writer whose snapshot's `state` still matches: only `counted_at IS NULL` stops it.
    expect(await sys(() => transitionOutcome(counted, { to: 'failed', reason: 'late_verdict' }, new Date()))).toBe(false);
    expect(await outcomeRow(a.outcomeId)).toMatchObject({ state: 'verified', stateReason: 'held_with_fresh_telemetry' });
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 1, failedCount: 0 });
  });

  it('a rebuild waits for an in-flight recompute of the same identity and never overwrites it (one lock protocol)', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 7);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    const t0 = new Date(base + 30 * H);
    const a = await attempt(w, w.o2, w.d2, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
    const holding = await outcomeRow(a.outcomeId);
    const reached = gate();
    const release = gate();
    // T1: terminal transition + recompute, then keep the transaction (and the identity lock) open.
    const t1 = sys(async () => {
      expect(await transitionOutcome(holding, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date())).toBe(true);
      reached.open();
      await release.wait();
    });
    let t2: Promise<unknown> | undefined;
    try {
      await reachedOrSettled(reached, t1);
      // T2: a rebuild of the same partner must wait on the identity lock BEFORE it reads contributions:
      // an advisory wait, not a row-lock wait at its upsert (which it reaches only after a stale read).
      t2 = sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
      expect(await blockedOn(t2)).toBe('advisory');
      release.open();
      await t1;
      await t2;
    } finally {
      // Never leak an open transaction (and its locks) into the next test.
      release.open();
      await Promise.allSettled([t1, t2]);
    }
    // Under a separate rebuild lock, T2 would have read 1 attempt and overwritten T1's 2 after T1 committed.
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 2, verifiedCount: 2 });
  });

  it('a re-vote that arrives during a recount is not lost (Review Focus 1)', async () => {
    const w = await world();
    const a = await verify(w, w.o1, w.d1, w.partnerScript, new Date(Date.UTC(2026, 10, 9)));
    const voter = await createUser({ partnerId: w.partnerId, orgId: w.o1, email: `vote-${randomUUID()}@example.com` });
    // An executed suggestion must link its run (remediation_suggestions_terminal_execution_link_check).
    const scriptExecutionId = (await outcomeRow(a.outcomeId)).scriptExecutionId!;
    const [suggestion] = await sys(() => db.insert(remediationSuggestions).values({
      orgId: w.o1, sourceType: 'alert', sourceId: a.alertId, alertId: a.alertId, deviceId: w.d1, targetType: 'script',
      scriptId: w.partnerScript.scriptId, title: 'Restart spooler', rationale: 'r', expectedAction: 'e', status: 'executed',
      scriptExecutionId,
    }).returning({ id: remediationSuggestions.id }));
    await sys(() => db.update(fixOutcomes).set({ suggestionId: suggestion!.id }).where(eq(fixOutcomes.id, a.outcomeId)));
    await sys(() => recordOutcomeVote({ suggestionId: suggestion!.id, orgId: w.o1, vote: 'up', userId: voter.id }));

    const reached = gate();
    const release = gate();
    const t1 = sys(() => recomputeForOutcome(a.outcomeId, new Date(), {
      afterRecompute: async () => { reached.open(); await release.wait(); },
    }));
    let t2: Promise<unknown> | undefined;
    try {
      await reachedOrSettled(reached, t1);
      t2 = sys(() => recordOutcomeVote({ suggestionId: suggestion!.id, orgId: w.o1, vote: 'down', userId: voter.id }));
      // Blocked on the recount's FOR UPDATE row lock: a row-lock wait shows as 'transactionid'
      // (waiting on the holder's xid) or 'tuple' (queued behind another waiter), never 'advisory'.
      expect(['transactionid', 'tuple']).toContain(await blockedOn(t2));
      release.open();
      await t1;
      await t2;
    } finally {
      release.open();
      await Promise.allSettled([t1, t2]);
    }
    expect((await outcomeRow(a.outcomeId)).recountRequestedAt).not.toBeNull(); // the 👎 re-requested after the clear
    await sys(() => recomputeForOutcome(a.outcomeId));
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 0, failedCount: 1, downVotes: 1 });
  });

  it('a disk_read anomaly hold with only CPU/RAM samples is inconclusive, not verified (Review Focus 3)', async () => {
    const w = await world();
    const recoveredAt = new Date(Date.UTC(2026, 10, 11));
    const holdingUntil = new Date(recoveredAt.getTime() + 24 * H);
    // A real episode that cleared objectively at recoveredAt, so the pre-verify source re-read
    // passes and only the freshness probe stands between this hold and "verified".
    const episode = await seedEpisode({
      orgId: w.o1, deviceId: w.d1, memberCount: 2, start: new Date(recoveredAt.getTime() - 2 * H),
      metricName: 'disk_read_bps', metricFamily: 'disk_read', status: 'resolved', closeReason: 'cleared', resolvedAt: recoveredAt,
    });
    const [o] = await sys(() => db.insert(fixOutcomes).values({
      orgId: w.o1, partnerId: w.partnerId, deviceId: w.d1, sourceType: 'anomaly', sourceId: episode.peakMemberId,
      anomalyEpisodeId: episode.episodeId,
      signatureVersion: 1, signatureKey: 'd'.repeat(64), broadKey: 'd'.repeat(64), osType: 'windows',
      signatureFacets: { family: 'anomaly', condition: 'anomaly:device_metrics:spike:disk_read', osFamily: 'windows', discriminator: null, rootInferred: false },
      fixKind: 'partner_script', fixIdentity: `script_version:${w.partnerScript.versionId}`,
      scriptId: w.partnerScript.scriptId, scriptVersionId: w.partnerScript.versionId,
      state: 'holding', recoveredAt, holdingUntil, deadlineAt: holdingUntil, createdAt: new Date(recoveredAt.getTime() - H),
    }).returning({ id: fixOutcomes.id }));
    await reportTelemetry(w.o1, w.d1, recoveredAt, holdingUntil); // cpu/ram rows only: disk_read_bps stays NULL
    // The device DID report — just not the measurement this problem is about.
    expect(await sys(() => probeTelemetryFreshness({ deviceId: w.d1, from: recoveredAt, to: holdingUntil, probe: { table: 'device_metrics', column: 'cpu_percent' } })))
      .toMatchObject({ fresh: true });
    expect(await advanceOutcome(o!.id, { now: new Date(holdingUntil.getTime() + 60_000) })).toBe('inconclusive');
    expect((await outcomeRow(o!.id)).stateReason).toBe('telemetry_metric_gap');
  });

  it('a real recurrence is found among 120 unrelated alerts in the hold window (Review Focus 3)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 13));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
    // Same prefilter (script_exit_code), different signature (another monitored script): pure noise.
    // 60 older + 60 newer than the recurrence, which is inserted last: it is 61st in (triggered_at, id)
    // order, 61st newest-first (alerts_device_triggered_at_idx is DESC) and last in heap order, so
    // neither an unordered LIMIT nor a single ordered page can reach it; only the keyset paging does.
    const other = await w.mkScript({ partnerId: w.partnerId });
    await sys(() => db.insert(alerts).values(Array.from({ length: 120 }, (_, i) => ({
      orgId: w.o1, deviceId: w.d1, severity: 'low' as const, title: `noise ${i}`,
      triggeredAt: new Date(t0.getTime() + (i < 60 ? 2 * H : 4 * H) + (i % 60) * 60_000),
      context: { source: 'script_exit_code', scriptId: other.scriptId, exitCode: 1 },
    }))));
    await sys(() => db.insert(alerts).values({
      orgId: w.o1, deviceId: w.d1, severity: 'high', title: 'exit 3 again', triggeredAt: new Date(t0.getTime() + 3.5 * H),
      context: { source: 'script_exit_code', scriptId: w.partnerScript.scriptId, exitCode: 3 },
    }));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 6 * H) })).toBe('recurred');
  });

  it('a proven partner fix whose script is re-scoped to org A is never offered to org B, even under system scope (Review Focus 5)', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 15);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H));
    const last = await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 60 * H));
    expect((await memoryFor(w, w.o2, last.alertId)).proven).toHaveLength(1);
    // Scope-only re-scope (routes/scripts.ts:921-928 keeps the version): partner-wide -> org A.
    await sys(() => db.update(scripts).set({ orgId: w.o1 }).where(eq(scripts.id, w.partnerScript.scriptId)));
    const forB = await memoryFor(w, w.o2, last.alertId); // memoryFor runs under SYSTEM scope: RLS cannot help here
    expect(forB.proven).toEqual([]);
    expect(forB.similar).toEqual([]);
    expect(await sys(() => markOwnerDriftStale())).toBe(1); // exactly this test's one drifted row
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    const rows = await sys(() => db.select().from(fixMemory).where(eq(fixMemory.scriptId, w.partnerScript.scriptId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: w.o1, partnerId: null, attempts: 1 }); // only org A's own attempt, privately
  });

  it('an org-private fix whose script moves org A -> org B is flagged as drift and dropped by the rebuild (Review Focus 5)', async () => {
    const w = await world();
    const orgScript = await w.mkScript({ orgId: w.o1, partnerId: w.partnerId });
    const base = Date.UTC(2026, 10, 18);
    for (let i = 0; i < 3; i += 1) await verify(w, w.o1, w.d1, orgScript, new Date(base + i * 30 * H), 'org_script');
    await sys(() => db.update(scripts).set({ orgId: w.o2 }).where(eq(scripts.id, orgScript.scriptId)));
    const byScript = () => sys(() => db.select().from(fixMemory).where(eq(fixMemory.scriptId, orgScript.scriptId)));
    expect((await byScript())[0]).toMatchObject({ orgId: w.o1, staleSince: null });
    expect(await sys(() => markOwnerDriftStale())).toBe(1); // exactly this test's one drifted row
    expect((await byScript())[0]!.staleSince).not.toBeNull(); // an org_id change is drift, not just org<->partner
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    expect(await byScript()).toEqual([]); // org A's attempts no longer belong to any owner org B could see
  });

  it('org merge: loser outcomes stay with the loser (leave-for-erasure); erasure + rebuild leave only the survivor’s proof', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const w = await world();
      const base = Date.UTC(2026, 10, 22);
      await verify(w, w.o1, w.d1, w.partnerScript, new Date(base)); // loser
      await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H)); // survivor
      await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 60 * H)); // survivor
      const actor = await createUser({ partnerId: w.partnerId, orgId: null, email: `merge-${randomUUID()}@example.com` });

      await executeOrgMerge({ loserOrgId: w.o1, survivorOrgId: w.o2, partnerId: w.partnerId, performedBy: actor.id, performedByEmail: actor.email });
      // leave-for-erasure: not re-pointed (no restamp, no double count), device moves notwithstanding.
      expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o1)))).toHaveLength(1);
      expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o2)))).toHaveLength(2);
      expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 3, verifiedCount: 3 });

      // jobs/orgMerge.ts:164 enqueues the loser's erasure; run exactly what that job runs.
      await eraseOrgWithFixMemory(w.o1, actor.id, actor.email);
      expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o1)))).toEqual([]);
      expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 2, verifiedCount: 2, staleSince: null, rebuildPendingOrgIds: [] });
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  }, 240_000); // executeOrgMerge + the org cascade each walk every tenant table (30-110 s locally, load-dependent): far over the 30 s default

  it('the inline script hook fails the attempt once and the recount pass aggregates it (decision D-a)', async () => {
    const w = await world();
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, new Date(Date.UTC(2026, 10, 24)));
    const executionId = (await outcomeRow(a.outcomeId)).scriptExecutionId!;
    expect(await sys(() => advanceOutcomesForTerminalExecution({ executionId, status: 'failed' }))).toBe(1);
    expect(await sys(() => advanceOutcomesForTerminalExecution({ executionId, status: 'failed' }))).toBe(0); // CAS: once
    const failed = await outcomeRow(a.outcomeId);
    expect(failed).toMatchObject({ state: 'failed', stateReason: 'script_failed' });
    expect(failed.recountRequestedAt).not.toBeNull();
    expect(await partnerMemory(w.partnerId)).toEqual([]); // the org-scoped hook never writes fix_memory
    await sys(() => recomputeForOutcome(a.outcomeId)); // what the sweeper's recount pass runs
    expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 1, failedCount: 1 });
    expect((await outcomeRow(a.outcomeId)).recountRequestedAt).toBeNull();
  });

  it('a script whose command expired undelivered is inconclusive, on both the inline and the sweeper path (I2)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 25));
    // Inline path: the reaper's delivery clock expires the command.
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    const executionId = (await outcomeRow(a.outcomeId)).scriptExecutionId!;
    await sys(() => db.update(scriptExecutions).set({ status: 'pending', completedAt: null, exitCode: null }).where(eq(scriptExecutions.id, executionId)));
    await sys(() => propagateTimedOutDeviceCommand({
      commandId: randomUUID(), payload: { executionId }, errorMsg: 'never delivered', completedAt: new Date(), kind: 'expired',
    }));
    expect(await outcomeRow(a.outcomeId)).toMatchObject({ state: 'inconclusive', stateReason: 'script_never_delivered' });

    // Sweeper path: the execution is already failed (hook missed), started_at NULL,
    // and its command row carries the reaper's delivery-clock marker.
    const b = await attempt(w, w.o2, w.d2, w.partnerScript, t0);
    const execB = (await outcomeRow(b.outcomeId)).scriptExecutionId!;
    await sys(() => db.update(scriptExecutions).set({ status: 'failed', exitCode: null }).where(eq(scriptExecutions.id, execB)));
    await sys(() => db.insert(deviceCommands).values({
      deviceId: w.d2, type: 'script', status: 'failed', payload: { executionId: execB },
      result: { status: 'timeout', reason: 'not_delivered_before_deadline', clock: 'delivery', timedOutBy: 'server' },
    }));
    expect(await advanceOutcome(b.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) })).toBe('inconclusive');
    expect((await outcomeRow(b.outcomeId)).stateReason).toBe('script_never_delivered');

    // Control: a delivered script that failed is still a failed attempt.
    const c = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    const execC = (await outcomeRow(c.outcomeId)).scriptExecutionId!;
    await sys(() => db.update(scriptExecutions).set({ status: 'failed', exitCode: 1, startedAt: t0 }).where(eq(scriptExecutions.id, execC)));
    expect(await advanceOutcome(c.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) })).toBe('failed');
  });

  it('"cleared before the fix" is measured from the script start (timestamp WITHOUT time zone, read as UTC) (I3)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 26));
    const startedAt = new Date(t0.getTime() + 30 * 60_000);
    const advanceInFarZone = (id: string, now: Date) => sys(async () => {
      // UTC+14: a zone-dependent read of started_at would shift it 14 h.
      await db.execute(sql`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
      return advanceOutcome(id, { now });
    });
    // Cleared after dispatch (t0) but before the script started → inconclusive.
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    const execA = (await outcomeRow(a.outcomeId)).scriptExecutionId!;
    await sys(() => db.update(scriptExecutions).set({ startedAt }).where(eq(scriptExecutions.id, execA)));
    expect(await advanceInFarZone(a.outcomeId, new Date(t0.getTime() + 2 * 60_000))).toBe('awaiting_recovery');
    await resolveByCondition(a.alertId, new Date(t0.getTime() + 10 * 60_000));
    expect(await advanceInFarZone(a.outcomeId, new Date(t0.getTime() + H))).toBe('inconclusive');
    expect((await outcomeRow(a.outcomeId)).stateReason).toBe('cleared_before_fix');
    // Cleared after the script started → hold.
    const b = await attempt(w, w.o2, w.d2, w.partnerScript, t0);
    const execB = (await outcomeRow(b.outcomeId)).scriptExecutionId!;
    await sys(() => db.update(scriptExecutions).set({ startedAt }).where(eq(scriptExecutions.id, execB)));
    expect(await advanceInFarZone(b.outcomeId, new Date(t0.getTime() + 2 * 60_000))).toBe('awaiting_recovery');
    await resolveByCondition(b.alertId, new Date(t0.getTime() + 40 * 60_000));
    expect(await advanceInFarZone(b.outcomeId, new Date(t0.getTime() + H))).toBe('holding');
  });

  it('a hold whose source alert re-opened in place is inconclusive, never verified (source_not_resolved)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 26));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) })).toBe('awaiting_recovery');
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
    await reportTelemetry(w.o1, w.d1, new Date(t0.getTime() + H), new Date(t0.getTime() + 25 * H));
    // Re-opened in place: the SAME alert row, so the recurrence scan (which only looks at other,
    // newer alerts) is clear and telemetry is fresh. Only the pre-verify re-read can catch it.
    await sys(() => db.update(alerts).set({ status: 'active', resolvedAt: null, resolutionReason: null }).where(eq(alerts.id, a.alertId)));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 25 * H + 60_000) })).toBe('inconclusive');
    expect((await outcomeRow(a.outcomeId)).stateReason).toBe('source_not_resolved');
    expect(await partnerMemory(w.partnerId)).toEqual([]);
  });

  it('an unsignable hold is inconclusive even with a resolved source and fresh telemetry (recurrence_unsignable)', async () => {
    const w = await world();
    const recoveredAt = new Date(Date.UTC(2026, 10, 27));
    const holdingUntil = new Date(recoveredAt.getTime() + 24 * H);
    // A real, objectively-resolved alert whose signature cannot be computed (alertConditionFacets
    // returns null for monitor_recurrence), so fillOutcomeSignature leaves the outcome unsigned.
    const [alert] = await sys(() => db.insert(alerts).values({
      orgId: w.o1, deviceId: w.d1, severity: 'high', title: 'unsignable', triggeredAt: new Date(recoveredAt.getTime() - 2 * H),
      context: { source: 'monitor_recurrence' }, status: 'resolved', resolvedAt: recoveredAt, resolutionReason: 'condition_cleared',
    }).returning({ id: alerts.id }));
    expect(await sys(() => alertSignature(alert!.id))).toBeNull();
    const [o] = await sys(() => db.insert(fixOutcomes).values({
      orgId: w.o1, partnerId: w.partnerId, deviceId: w.d1, sourceType: 'alert', sourceId: alert!.id, alertId: alert!.id,
      fixKind: 'partner_script', fixIdentity: `script_version:${w.partnerScript.versionId}`,
      scriptId: w.partnerScript.scriptId, scriptVersionId: w.partnerScript.versionId,
      state: 'holding', recoveredAt, holdingUntil, deadlineAt: holdingUntil, createdAt: new Date(recoveredAt.getTime() - H),
    }).returning({ id: fixOutcomes.id }));
    await reportTelemetry(w.o1, w.d1, recoveredAt, holdingUntil);
    expect(await advanceOutcome(o!.id, { now: new Date(holdingUntil.getTime() + 60_000) })).toBe('inconclusive');
    expect(await outcomeRow(o!.id)).toMatchObject({ stateReason: 'recurrence_unsignable', signatureKey: null });
  });

  it('freshness reads device_metrics (timestamp WITHOUT time zone) as UTC whatever the session time zone', async () => {
    const w = await world();
    const from = new Date(Date.UTC(2026, 10, 29));
    const to = new Date(from.getTime() + 24 * H);
    await reportTelemetry(w.o1, w.d1, from, to);
    const reading = await sys(async () => {
      // UTC+14: a ::timestamptz comparison would slide the window 14 h past the samples.
      await db.execute(sql`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
      return probeTelemetryFreshness({ deviceId: w.d1, from, to, probe: { table: 'device_metrics', column: 'cpu_percent' } });
    });
    expect(reading).toMatchObject({ fresh: true, reason: 'ok' });
    expect(reading.coverage).toBeGreaterThanOrEqual(0.95);
  });

  it('lookup finds a proven fix behind 120 stronger similar rows (ORDER BY exact-first before LIMIT)', async () => {
    const w = await world();
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, new Date(Date.UTC(2026, 10, 30)));
    const sig = (await sys(() => alertSignature(a.alertId)))!.signature;
    expect(sig.broad).toBe(false);
    const memory = (over: { signatureKey: string; fixIdentity: string; verifiedCount: number }) => ({
      orgId: null, partnerId: w.partnerId, signatureVersion: sig.version, broadKey: sig.broadKey, osType: sig.facets.osFamily,
      fixKind: 'builtin_action' as const, builtinAction: 'reboot', attempts: over.verifiedCount, rollingSuccessRate: 1,
      recentOutcomes: ['verified', 'verified', 'verified'], status: 'active' as const, ...over,
    });
    // Similar-only noise, inserted FIRST (heap order) and each stronger (more verified) than the exact row.
    await sys(() => db.insert(fixMemory).values(Array.from({ length: 120 }, (_, i) => memory({
      signatureKey: createHash('sha256').update(`noise-${i}`).digest('hex'), fixIdentity: `builtin:noise-${i}`, verifiedCount: 10,
    }))));
    await sys(() => db.insert(fixMemory).values(memory({ signatureKey: sig.key, fixIdentity: 'builtin:reboot', verifiedCount: 3 })));
    const out = await sys(() => lookupFixes({ orgId: w.o1, partnerId: w.partnerId, signature: sig, limit: 5 }));
    expect(out.proven).toHaveLength(1);
    expect(out.proven[0]).toMatchObject({ fixKind: 'builtin_action', verified: 3, scope: 'all_clients' });
    expect(out.similar).toHaveLength(5);
  });
});
